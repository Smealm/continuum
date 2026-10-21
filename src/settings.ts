import { gbToBytes, parseNonNegativeInt } from './core/format';
import { normalizeScopeKind } from './core/scope';
import { EngineMode, Settings } from './core/types';

export type ConfigReader = (key: string) => unknown;

function readBoolean(read: ConfigReader, key: string, fallback: boolean): boolean {
  const value = read(key);
  return typeof value === 'boolean' ? value : fallback;
}

function readString(read: ConfigReader, key: string, fallback: string): string {
  const value = read(key);
  return typeof value === 'string' ? value.trim() : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readSettings(mode: EngineMode, read: ConfigReader): Settings {
  const reserveGb = parseNonNegativeInt(read('continuum.reserveGB'), 5);
  const maxGb = parseNonNegativeInt(read('continuum.maxTotalGB'), 0);
  const activeWorkers = clamp(parseNonNegativeInt(read('continuum.activeWorkers'), 4), 1, 8);
  const passiveWorkers = clamp(parseNonNegativeInt(read('continuum.passiveWorkers'), 1), 1, 2);
  const passiveDelayMs = clamp(parseNonNegativeInt(read('continuum.passiveDelayMs'), 750), 0, 60_000);

  return {
    mode,
    scope: {
      kind: normalizeScopeKind(readString(read, 'continuum.scope', 'all')),
      value: readString(read, 'continuum.scopeValue', ''),
    },
    includeImages: readBoolean(read, 'continuum.includeImages', true),
    reserveBytes: gbToBytes(reserveGb),
    maxBytes: gbToBytes(maxGb),
    activeWorkers,
    passiveWorkers,
    passiveDelayMs,
    respectExtremeFilter: readBoolean(read, 'continuum.respectExtremeFilter', true),
    autoResume: readBoolean(read, 'continuum.autoResume', false),
  };
}
