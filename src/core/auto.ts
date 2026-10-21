import * as fs from 'fs';
import type { CatalogMeta } from './catalog';
import type { Preparation } from './engine';
import { readJson, writeJsonAtomic } from './jsonl';
import { DenialState, readDenial } from './permission';
import { EngineMode, JobState, JobStatus, Logger, Settings } from './types';

/**
 * Automatic jobs start in passive mode: they run unattended, possibly for days,
 * and passive is the mode designed for that. A resumed job keeps the mode the
 * user chose when they started it.
 */
export const AUTO_MODE: EngineMode = 'passive';

/** How often the launcher database is checked for changes while it is open. */
export const AUTO_CHECK_INTERVAL_MS = 5 * 60_000;

export const AUTO_STATE_VERSION = 1;

/**
 * What the last catalogue rebuild read from the launcher. Kept in
 * `state/database.json` so a restart can tell whether the database changed
 * since the catalogue was built without re-reading 221k games to find out.
 */
export interface AutoState {
  version: 1;
  /** `mtimeMs:size` of Data/flashpoint.sqlite at the last rebuild. */
  database: string;
  /** The launcher's own dataVersion at that rebuild, when it exposes one. */
  dataVersion?: string;
  updatedAt: string;
}

/** `missing` when the file does not exist (catalogue built by the tag scan). */
export function databaseSignature(stat: { mtimeMs: number; size: number } | null): string {
  return stat ? `${Math.round(stat.mtimeMs)}:${stat.size}` : 'missing';
}

export async function currentDatabaseSignature(file: string): Promise<string> {
  try {
    return databaseSignature(await fs.promises.stat(file));
  } catch {
    return 'missing';
  }
}

export async function readAutoState(file: string): Promise<AutoState | null> {
  const state = await readJson<AutoState>(file);
  if (!state || state.version !== AUTO_STATE_VERSION || typeof state.database !== 'string') {
    return null;
  }
  return state;
}

export async function writeAutoState(
  file: string,
  database: string,
  dataVersion: string | undefined,
): Promise<void> {
  const state: AutoState = {
    version: AUTO_STATE_VERSION,
    database,
    ...(dataVersion ? { dataVersion } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(file, state);
}

export type AutoAction =
  /** The master switch is off. */
  | { kind: 'off' }
  /** A job or a rebuild is already going. */
  | { kind: 'busy' }
  | { kind: 'rebuild'; database: string; reason: string }
  | { kind: 'resume'; mode: EngineMode; status: JobStatus }
  | { kind: 'changed'; mode: EngineMode; count: number }
  | { kind: 'pass'; mode: EngineMode }
  | { kind: 'none'; reason: string };

export interface AutoDecisionInput {
  enabled: boolean;
  running: boolean;
  meta: CatalogMeta | null;
  job: JobState | null;
  /** Signature of Data/flashpoint.sqlite right now. */
  database: string;
  dataVersion?: string;
  /** What the last rebuild recorded, or null when it recorded nothing. */
  saved: AutoState | null;
  /** Games a rebuild left in `state/changed.json` for this catalogue. */
  pendingChanges: number;
  /** Mode for a new automatic pass. */
  mode?: EngineMode;
  /**
   * The archive host refused access (a blacklist looks like this). While it is
   * set, nothing automatic runs: a person has to decide to try again.
   */
  denied?: DenialState | null;
}

/**
 * What the automatic switch should do now, in priority order: rebuild when the
 * launcher database moved, then continue the saved job, then handle the games a
 * rebuild changed, then start a pass when something is still missing.
 */
export function decideAutoAction(input: AutoDecisionInput): AutoAction {
  if (!input.enabled) {
    return { kind: 'off' };
  }
  if (input.denied) {
    return {
      kind: 'none',
      reason: `the archive host refused access (HTTP ${input.denied.status}); start a download yourself to try again`,
    };
  }
  if (input.running) {
    return { kind: 'busy' };
  }
  const mode = input.mode || AUTO_MODE;

  if (!input.meta) {
    return { kind: 'rebuild', database: input.database, reason: 'there is no catalogue yet' };
  }
  const saved = input.saved;
  if (!saved) {
    return {
      kind: 'rebuild',
      database: input.database,
      reason: 'the launcher database was not recorded by the last rebuild',
    };
  }
  if (saved.database !== input.database) {
    return {
      kind: 'rebuild',
      database: input.database,
      reason: 'the launcher database changed since the last catalogue rebuild',
    };
  }
  if ((saved.dataVersion || '') !== (input.dataVersion || '')) {
    return {
      kind: 'rebuild',
      database: input.database,
      reason: 'the launcher data version changed',
    };
  }

  const job = input.job;
  if (job && job.generation === input.meta.generation) {
    if (job.status === 'paused' || job.status === 'stopped' || job.status === 'running' || job.status === 'idle') {
      return { kind: 'resume', mode: job.mode || mode, status: job.status };
    }
    if (job.status === 'error') {
      return { kind: 'none', reason: `the last job failed: ${job.message}` };
    }
    return { kind: 'none', reason: 'the last pass for this catalogue finished' };
  }

  if (input.pendingChanges > 0) {
    return { kind: 'changed', mode, count: input.pendingChanges };
  }
  if (input.meta.packsMissing > 0) {
    return { kind: 'pass', mode };
  }
  return { kind: 'none', reason: 'everything in scope is already on disk' };
}

/** What the automatic rebuild produced, for deciding what to download next. */
export interface AutoRebuild {
  meta: CatalogMeta;
  /** Games written to `state/changed.json` by this rebuild. */
  changed: number;
}

/**
 * Everything the automatic runner needs. Kept structural so the decision and
 * the orchestration can be tested without a launcher, a catalogue or a server.
 */
export interface AutoDeps {
  log: Logger;
  paths: {
    databaseFile: string;
    databaseStateFile: string;
    changedFile: string;
    deniedFile: string;
  };
  readSettings(mode: EngineMode): Settings;
  readDataVersion(): string | undefined;
  loadMeta(): Promise<CatalogMeta | null>;
  pendingChanges(meta: CatalogMeta): Promise<number>;
  rebuild(): Promise<AutoRebuild | null>;
  prepare(settings: Settings, options?: { changedOnly?: boolean }): Promise<Preparation>;
  start(prep: Preparation): Promise<{ ok: boolean; reason?: string }>;
  isRunning(): boolean;
  readJob(): Promise<JobState | null>;
}

export interface AutoResult {
  action: AutoAction['kind'] | 'rebuild-failed';
  started: boolean;
  mode?: EngineMode;
  reason?: string;
}

/**
 * Run whatever the automatic switch calls for, once. Never shows a dialog: an
 * unattended run logs what it did and leaves the rest to the log.
 */
export async function runAutoTasks(deps: AutoDeps): Promise<AutoResult> {
  const settings = deps.readSettings(AUTO_MODE);
  const database = await currentDatabaseSignature(deps.paths.databaseFile);
  const meta = await deps.loadMeta();
  const job = await deps.readJob();
  const saved = await readAutoState(deps.paths.databaseStateFile);
  const denied = await readDenial(deps.paths.deniedFile);
  if (denied) {
    deps.log.info(
      `Automatic tasks are paused: the archive host refused access (HTTP ${denied.status}) `
      + `on ${new Date(denied.at).toLocaleString()}. Start a download yourself to try again.`,
    );
  }
  const pending = meta ? await deps.pendingChanges(meta) : 0;

  const action = decideAutoAction({
    enabled: settings.autoMirror,
    running: deps.isRunning(),
    meta,
    job,
    database,
    dataVersion: deps.readDataVersion(),
    saved,
    pendingChanges: pending,
    denied,
  });

  switch (action.kind) {
    case 'off':
      return { action: 'off', started: false };
    case 'busy':
      return { action: 'busy', started: false };
    case 'none':
      return { action: 'none', started: false, reason: action.reason };
    case 'rebuild': {
      deps.log.info(`Automatic catalogue rebuild: ${action.reason}.`);
      const rebuilt = await deps.rebuild();
      if (!rebuilt) {
        // No signature is recorded, so the next check tries the rebuild again.
        deps.log.warn('The automatic catalogue rebuild did not finish; it will be retried.');
        return { action: 'rebuild-failed', started: false };
      }
      // Read the signature again: the database may have moved during the build,
      // and the next check should see that instead of pretending it did not.
      try {
        await writeAutoState(
          deps.paths.databaseStateFile,
          await currentDatabaseSignature(deps.paths.databaseFile),
          deps.readDataVersion(),
        );
      } catch (error) {
        deps.log.warn(`Could not record the launcher database state: ${errorMessage(error)}`);
      }
      if (rebuilt.changed > 0) {
        const changed = await startTask(deps, AUTO_MODE, true, 'changed');
        if (changed.action !== 'none' || changed.started) {
          return changed;
        }
        // The list had nothing left to fetch; fall through to the full pass,
        // which is what finds packs the diff cannot see.
      }
      if (rebuilt.meta.packsMissing > 0) {
        return startTask(deps, AUTO_MODE, false, 'pass');
      }
      return { action: 'rebuild', started: false };
    }
    case 'resume':
      return startTask(deps, action.mode, false, 'resume');
    case 'changed':
      return startTask(deps, action.mode, true, 'changed');
    case 'pass':
      return startTask(deps, action.mode, false, 'pass');
    default:
      return { action: 'none', started: false };
  }
}

async function startTask(
  deps: AutoDeps,
  mode: EngineMode,
  changedOnly: boolean,
  action: AutoResult['action'],
): Promise<AutoResult> {
  const settings = deps.readSettings(mode);
  let prep: Preparation;
  try {
    prep = await deps.prepare(settings, changedOnly ? { changedOnly: true } : undefined);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log.warn(`Could not prepare the automatic job: ${reason}`);
    return { action, started: false, mode, reason };
  }
  if (changedOnly && !prep.changedOnly) {
    // The list went away between the check and the prepare; the next check will
    // decide between a changed pass and a full one again.
    deps.log.info('The changed list is no longer available; nothing was started.');
    return { action: 'none', started: false, mode, reason: 'no changed list' };
  }
  if (prep.estimate.gamesInScope === 0) {
    deps.log.info('Automatic job skipped: nothing matches the current scope.');
    return { action: 'none', started: false, mode, reason: 'nothing in scope' };
  }
  if (changedOnly && prep.estimate.packsMissing === 0) {
    // Every changed game in scope is already on disk, so the list has done its
    // job; removing it lets the next check get on with the full pass.
    try {
      await fs.promises.unlink(deps.paths.changedFile);
    } catch {
      // Already gone, which is the same outcome.
    }
    deps.log.info('Every changed game is already on disk; the changed list is done.');
    return { action: 'none', started: false, mode, reason: 'changed list handled' };
  }
  if (prep.estimate.totalBytes === 0) {
    deps.log.info('Automatic job skipped: everything in this scope is already on disk.');
    return { action: 'none', started: false, mode, reason: 'everything on disk' };
  }

  const result = await deps.start(prep);
  if (!result.ok) {
    const reason = result.reason || 'unknown reason';
    deps.log.warn(`The automatic job did not start: ${reason}`);
    return { action, started: false, mode, reason };
  }
  deps.log.info(
    `Automatic ${mode} ${changedOnly ? 'changed-only ' : ''}job started (${action}).`,
  );
  return { action, started: true, mode };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
