/**
 * The launcher derives the file name of a data pack from the timestamp in its
 * `dateAdded` field. Older rows use a "YYYY-MM-DD HH:MM:SS +0000 UTC" string,
 * newer ones use ISO 8601. This must stay byte-for-byte identical to
 * `getGameDataFilename` in the launcher or the file will not be found again.
 */
export function gameDataFilename(data: { gameId: string; dateAdded: string }): string {
  const raw = data.dateAdded.includes('T') ? data.dateAdded : `${data.dateAdded} +0000 UTC`;
  const time = new Date(raw).getTime();
  if (!Number.isFinite(time)) {
    throw new Error(`Invalid dateAdded "${data.dateAdded}" for game ${data.gameId}`);
  }
  return `${data.gameId}-${time}.zip`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function parseNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return fallback;
}

export function gbToBytes(gb: number): number {
  return Math.max(0, gb) * 1024 * 1024 * 1024;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'unknown';
  }
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const days = Math.floor(totalSeconds / 86400);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatPercent(done: number, total: number): string {
  if (total <= 0) {
    return '0%';
  }
  return `${Math.min(100, (done / total) * 100).toFixed(done === total ? 0 : 1)}%`;
}

/** Join a base URL and a relative path without doubling or dropping slashes. */
export function joinUrl(base: string, relative: string): string {
  return `${base.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
}
