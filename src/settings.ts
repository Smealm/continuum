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

/**
 * The mode the manager's Start button uses. The explicit Start Active and Start
 * Passive buttons still choose for themselves, and a resumed job keeps the mode
 * it was saved with.
 */
export function readConfiguredMode(read: ConfigReader): EngineMode {
  return read('continuum.mode') === 'active' ? 'active' : 'passive';
}

export function readSettings(mode: EngineMode, read: ConfigReader): Settings {
  const reserveGb = parseNonNegativeInt(read('continuum.reserveGB'), 5);
  const maxGb = parseNonNegativeInt(read('continuum.maxTotalGB'), 0);
  const activeWorkers = clamp(parseNonNegativeInt(read('continuum.activeWorkers'), 4), 1, 20);
  const passiveWorkers = clamp(parseNonNegativeInt(read('continuum.passiveWorkers'), 1), 1, 2);
  const passiveDelayMs = clamp(parseNonNegativeInt(read('continuum.passiveDelayMs'), 750), 0, 60_000);

  return {
    mode,
    scope: {
      kind: normalizeScopeKind(readString(read, 'continuum.scope', 'all')),
      value: readString(read, 'continuum.scopeValue', ''),
    },
    // Not a Continuum setting: Engine.prepare resolves it from the launcher's
    // own image caching preference while Respect Flashpoint Settings is on, and
    // leaves it on when that switch is off. `true` here means "not suppressed",
    // so a caller can still ask for a pass without images.
    includeImages: true,
    reserveBytes: gbToBytes(reserveGb),
    maxBytes: gbToBytes(maxGb),
    activeWorkers,
    passiveWorkers,
    passiveDelayMs,
    // Replaces continuum.respectExtremeFilter (0.2.0). The old key is ignored,
    // and the new switch defaults on so the launcher's filters stay in force.
    // Image caching is followed whether this is on or off; see Engine.prepare.
    respectFlashpointSettings: readBoolean(read, 'continuum.respectFlashpointSettings', true),
    // Replaces continuum.autoResume (0.3.0). The old key is ignored, and the
    // new switch defaults off so nothing downloads without being asked.
    autoMirror: readBoolean(read, 'continuum.autoMirror', false),
    prioritizePlaylists: readBoolean(read, 'continuum.prioritizePlaylists', false),
    // Smaller games first is the point of the download scheduler; catalogue
    // order is kept for anyone who wants the old byte-cursor sequence.
    order: readString(read, 'continuum.order', 'smallest') === 'catalogue' ? 'catalogue' : 'smallest',
    adaptiveWorkers: readBoolean(read, 'continuum.adaptiveWorkers', true),
  };
}
