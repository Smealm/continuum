import * as fs from 'fs';
import { readJson, writeJsonAtomic } from './jsonl';

/**
 * A host refused Continuum access (HTTP 401/403). That is what a blacklist
 * looks like from the client, so it is treated as a permission decision rather
 * than a failure: the job stops, nothing is retried automatically, and the
 * marker below keeps the automatic switch paused until a person chooses to try
 * again. Clearing it is always an explicit act.
 */
export const DENIAL_VERSION = 1;

export interface DenialState {
  version: 1;
  /** ISO time of the refused request. */
  at: string;
  /** 401 or 403. */
  status: number;
  /** The URL that was refused, when the failure carried one. */
  url?: string;
}

export async function readDenial(file: string): Promise<DenialState | null> {
  const state = await readJson<DenialState>(file).catch(() => null);
  if (!state || state.version !== DENIAL_VERSION || typeof state.at !== 'string') {
    return null;
  }
  return state;
}

export async function recordDenial(
  file: string,
  denial: { status: number; url?: string; now?: number },
): Promise<DenialState> {
  const state: DenialState = {
    version: DENIAL_VERSION,
    at: new Date(denial.now ?? Date.now()).toISOString(),
    status: denial.status,
    ...(denial.url ? { url: denial.url } : {}),
  };
  await writeJsonAtomic(file, state);
  return state;
}

export async function clearDenial(file: string): Promise<void> {
  await fs.promises.unlink(file).catch(() => undefined);
}
