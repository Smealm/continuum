import * as path from 'path';
import { previousCatalogPath } from './catalog';
import { ContinuumPreferences, Paths } from './types';

/**
 * The launcher resolves relative preference paths against the Flashpoint
 * folder. Use the same rule here so a portable install and a normal install
 * both work.
 */
export function resolveAgainst(root: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(root, maybeRelative);
}

export function resolveFlashpointRoot(configured: string, extensionPath: string): string {
  if (configured && configured.trim()) {
    return path.resolve(configured);
  }
  // <flashpoint>/Data/Extensions/Continuum -> <flashpoint>
  return path.resolve(extensionPath, '..', '..', '..');
}

export function resolvePaths(
  flashpointRoot: string,
  preferences: ContinuumPreferences,
  extensionPath: string,
): Paths {
  const stateDir = path.join(extensionPath, 'state');
  const catalogFile = path.join(stateDir, 'catalog.jsonl');
  return {
    flashpointRoot,
    dataPacksDir: resolveAgainst(flashpointRoot, preferences.dataPacksFolderPath || 'Data/Games'),
    imagesDir: resolveAgainst(flashpointRoot, preferences.imageFolderPath || 'Data/Images'),
    stateDir,
    databaseFile: path.join(flashpointRoot, 'Data', 'flashpoint.sqlite'),
    databaseStateFile: path.join(stateDir, 'database.json'),
    catalogFile,
    catalogMetaFile: path.join(stateDir, 'catalog.json'),
    catalogPreviousFile: previousCatalogPath(catalogFile),
    changedFile: path.join(stateDir, 'changed.json'),
    rebuildReportFile: path.join(stateDir, 'rebuild.json'),
    deniedFile: path.join(stateDir, 'denied.json'),
    failuresFile: path.join(stateDir, 'failures.jsonl'),
    retriesFile: path.join(stateDir, 'retries.json'),
    jobFile: path.join(stateDir, 'job.json'),
  };
}
