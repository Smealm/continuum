import { ActivitySnapshot } from './activity';
import { CatalogMeta } from './catalog';
import { EngineSnapshot } from './engine';
import { formatBytes, formatCount, formatDuration } from './format';
import { describeScope } from './scope';

export interface ProgressInput {
  scan: ActivitySnapshot;
  engine: EngineSnapshot;
  meta: CatalogMeta | null;
  freeBytes: number | null;
  now: number;
}

export interface ProgressView {
  /** True while a scan or download is active (or paused mid-job). */
  active: boolean;
  title: string;
  message: string;
  /** 0-100, for the dialog progress bar. */
  percent: number;
  activity: string;
  stats: string;
  timing: string;
}

export function buildProgressView(input: ProgressInput): ProgressView {
  const { scan, engine, meta, freeBytes, now } = input;

  if (scan.running) {
    const elapsed = Math.max(0, now - scan.startedAt);
    const percent = clampPercent(scan.percent * 100);
    return {
      active: true,
      title: 'Rebuilding the catalogue',
      message: 'Continuum is reading every tag from the launcher database.\n\n'
        + 'Closing this window does not stop the rebuild. Open Check Ongoing Progress again to see it.',
      percent,
      activity: scan.lines[0] || 'Starting...',
      stats: scan.lines[1] || '',
      timing: [`Elapsed ${formatDuration(elapsed)}`, etaFromPercent(elapsed, scan.percent)]
        .filter(Boolean)
        .join(' · '),
    };
  }

  const job = engine.job;
  if (job && (engine.status === 'running' || engine.status === 'paused' || engine.status === 'stopped')) {
    const running = engine.status === 'running';
    const mode = job.mode || engine.mode || 'passive';
    const title = engine.status === 'paused'
      ? 'Download paused'
      : engine.status === 'stopped'
        ? 'Download stopped'
        : `Downloading (${mode})`;

    const elapsedEnd = running ? now : Date.parse(job.updatedAt) || now;
    const elapsed = engine.startedAt ? Math.max(0, elapsedEnd - engine.startedAt) : 0;
    const seconds = elapsed / 1000;
    const doneBytes = engine.progress.doneBytes ?? engine.progress.sessionBytes;
    const remaining = engine.progress.remainingBytes
      ?? Math.max(0, engine.progress.estimateBytes - doneBytes);
    // The average since the job started is skewed by the first minutes of a
    // smallest-first queue, so the ETA uses the best sustained rate the link
    // has shown. The current rate is what the user is watching right now.
    const current = engine.progress.currentBytesPerSecond ?? 0;
    const lifetime = seconds > 0 ? engine.progress.sessionBytes / seconds : 0;
    const speed = current > 0 ? current : lifetime;
    const peak = engine.progress.peakBytesPerSecond ?? 0;
    const peakPacks = engine.progress.peakPacksPerSecond ?? 0;
    const peakGames = engine.progress.peakGamesPerSecond ?? 0;
    const remainingPacks = engine.progress.remainingPacks ?? 0;
    const remainingGames = engine.progress.remainingGames ?? 0;
    const rate = peak > 0 ? peak : speed;
    const byteSeconds = remaining > 0 && rate > 0 ? remaining / rate : 0;
    const packSeconds = peakPacks > 0 ? remainingPacks / peakPacks : 0;
    const gameSeconds = peakGames > 0 ? remainingGames / peakGames : 0;
    // Whichever runs out last: bytes at the measured link speed, or the queue
    // of small games at the fastest rate it has ever finished them.
    const etaSeconds = Math.max(byteSeconds, packSeconds, gameSeconds);
    const activity = engine.live
      ? `${engine.live.gameTitle}${engine.live.received > 0
        ? ` (${formatBytes(engine.live.received)}${engine.live.total ? ` / ${formatBytes(engine.live.total)}` : ''})`
        : ''}`
      : running
        ? 'Waiting for the next game...'
        : engine.message || job.message;

    const stats = [
      `${formatCount(job.gamesDone)} games`,
      `${formatCount(job.packsDone)} packs`,
      formatBytes(doneBytes),
      job.packsFailed > 0 ? `${formatCount(job.packsFailed)} failed` : '',
      (job.packFlagsFailed ?? 0) > 0 ? `${formatCount(job.packFlagsFailed!)} flags pending` : '',
      job.priority && job.priority.ids.length > 0
        ? `${formatCount(job.priority.cursor)}/${formatCount(job.priority.ids.length)} priority`
        : '',
    ].filter(Boolean).join(' · ');

    const timing = [
      elapsed > 0 ? `Elapsed ${formatDuration(elapsed)}` : '',
      speed > 0 ? `${formatBytes(speed)}/s` : '',
      peak > 0 && (speed <= 0 || peak > speed * 1.25) ? `peak ${formatBytes(peak)}/s` : '',
      etaSeconds > 0 ? `ETA ${formatDuration(etaSeconds * 1000)}` : '',
      engine.retryPending > 0 ? `${formatCount(engine.retryPending)} queued for retry` : '',
      freeBytes !== null ? `${formatBytes(freeBytes)} free` : '',
    ].filter(Boolean).join(' · ');

    const scope = engine.settings ? describeScope(engine.settings.scope) : 'the selected scope';
    return {
      active: true,
      title,
      message: `${engine.message || job.message}\n\nScope: ${scope}\n\n`
        + 'Closing this window does not stop the download. Open Check Ongoing Progress again to see it.',
      percent: clampPercent(engine.progress.percent * 100),
      activity,
      stats,
      timing,
    };
  }

  return idleView(scan, engine, meta, freeBytes);
}

function idleView(
  scan: ActivitySnapshot,
  engine: EngineSnapshot,
  meta: CatalogMeta | null,
  freeBytes: number | null,
): ProgressView {
  const lines = ['Continuum is idle.', ''];

  const lastAction = scan.error
    ? `Last catalogue rebuild failed: ${scan.error}`
    : scan.outcome
      ? `Last action: ${scan.outcome}`
      : '';
  if (lastAction) {
    lines.push(lastAction, '');
  }

  const job = engine.job;
  if (job && (engine.status === 'done' || engine.status === 'error')) {
    lines.push(engine.status === 'error' ? `Last download failed: ${job.message}` : `Last download: ${job.message}`, '');
  } else if (engine.status === 'paused' || engine.status === 'stopped') {
    lines.push(`Last download ${engine.status}: ${engine.message || job?.message || ''}`, '');
  }

  if (meta) {
    lines.push(`Catalogue: ${formatCount(meta.games)} games · ${formatCount(meta.packs)} packs`);
    lines.push(`Missing from disk: ${formatCount(meta.packsMissing)} packs · ${formatBytes(meta.bytesMissing)}`);
    lines.push(`Catalogue built: ${new Date(meta.scannedAt).toLocaleString()}`);
  } else {
    lines.push('Catalogue: not built yet');
  }
  if (freeBytes !== null) {
    lines.push(`Free space: ${formatBytes(freeBytes)}`);
  }
  lines.push('', 'Use the Continuum Manager to start or resume a download.');

  const finished = engine.status === 'done';
  const scanFinished = scan.kind === 'catalogue' && !scan.running && !scan.error && !!scan.outcome;
  return {
    active: false,
    title: 'Continuum is idle',
    message: lines.join('\n'),
    percent: 0,
    activity: finished ? 'Finished' : scanFinished ? 'Catalogue rebuilt' : '',
    stats: finished && job
      ? `${formatCount(job.gamesDone)} games · ${formatCount(job.packsDone)} packs · ${formatBytes(engine.progress.doneBytes ?? engine.progress.sessionBytes)}`
      : scanFinished
        ? scan.outcome || ''
        : '',
    timing: finished && job?.updatedAt
      ? `Last saved ${new Date(job.updatedAt).toLocaleTimeString()}`
      : '',
  };
}

function etaFromPercent(elapsedMs: number, percent: number): string {
  if (percent <= 0.0001 || percent >= 1 || elapsedMs <= 0) {
    return '';
  }
  const rate = percent / elapsedMs;
  return `ETA ${formatDuration((1 - percent) / rate)}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
