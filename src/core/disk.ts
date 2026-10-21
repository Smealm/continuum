import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface FreeSpace {
  freeBytes: number;
  source: 'statfs' | 'powershell' | 'df';
}

interface CacheEntry {
  at: number;
  value: FreeSpace | null;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export function parsePowerShellFree(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Parse `df -Pk <path>` output: Filesystem 1024-blocks Used Available Capacity Mounted. */
export function parseDfAvailableKb(stdout: string): number | null {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return null;
  }
  const columns = lines[lines.length - 1].trim().split(/\s+/);
  if (columns.length < 4) {
    return null;
  }
  const availableKb = Number.parseInt(columns[3], 10);
  return Number.isFinite(availableKb) && availableKb >= 0 ? availableKb * 1024 : null;
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
  });
}

async function probeWithStatfs(target: string): Promise<FreeSpace | null> {
  // fs.statfs only exists on newer Node (Electron 30+). Electron 19 has Node 16.
  const statfs = (fs as unknown as {
    statfs?: (p: string, cb: (err: NodeJS.ErrnoException | null, stats: { bavail: number; bsize: number }) => void) => void;
  }).statfs;
  if (typeof statfs !== 'function') {
    return null;
  }
  return new Promise((resolve) => {
    statfs(target, (error, stats) => {
      if (error || !stats) {
        resolve(null);
        return;
      }
      resolve({ freeBytes: stats.bavail * stats.bsize, source: 'statfs' });
    });
  });
}

async function probeWindows(target: string): Promise<FreeSpace | null> {
  const root = path.parse(path.resolve(target)).root;
  const drive = root.slice(0, 2).replace(':', '');
  if (!/^[A-Za-z]$/.test(drive)) {
    return null;
  }
  try {
    const stdout = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-PSDrive -Name '${drive.toUpperCase()}').Free`],
      15_000,
    );
    const freeBytes = parsePowerShellFree(stdout);
    return freeBytes === null ? null : { freeBytes, source: 'powershell' };
  } catch {
    return null;
  }
}

async function probePosix(target: string): Promise<FreeSpace | null> {
  try {
    const stdout = await run('df', ['-Pk', target], 15_000);
    const freeBytes = parseDfAvailableKb(stdout);
    return freeBytes === null ? null : { freeBytes, source: 'df' };
  } catch {
    return null;
  }
}

/**
 * Free bytes on the volume holding `target`. Results are cached briefly because
 * a 220k game job would otherwise spawn thousands of processes.
 * Returns null when the platform gives us no way to ask.
 */
export async function getFreeBytes(target: string): Promise<FreeSpace | null> {
  const key = path.parse(path.resolve(target)).root || target;
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  let value = await probeWithStatfs(target);
  if (!value) {
    value = process.platform === 'win32' ? await probeWindows(target) : await probePosix(target);
  }
  cache.set(key, { at: now, value });
  return value;
}

/** Force the next call to hit the OS again. */
export function clearFreeSpaceCache(): void {
  cache.clear();
}
