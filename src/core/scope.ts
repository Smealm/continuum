import { CatalogGameRecord } from './catalog';
import { Scope, ScopeKind } from './types';

export interface ScopeFilter {
  scope: Scope;
  /** Resolved playlist members, when the scope is a playlist. */
  playlistIds?: Set<string>;
  /** Tags the launcher treats as extreme content. */
  extremeTags?: string[];
  excludeExtreme?: boolean;
}

export function normalizeScopeKind(value: unknown): ScopeKind {
  switch (value) {
    case 'platform':
    case 'tag':
    case 'library':
    case 'playlist':
      return value;
    default:
      return 'all';
  }
}

export function matchesScope(game: CatalogGameRecord, filter: ScopeFilter): boolean {
  if (filter.excludeExtreme && filter.extremeTags && filter.extremeTags.length > 0) {
    const extreme = new Set(filter.extremeTags.map((tag) => tag.toLowerCase()));
    if (game.tags.some((tag) => extreme.has(tag.toLowerCase()))) {
      return false;
    }
  }

  const { scope } = filter;
  switch (scope.kind) {
    case 'all':
      return true;
    case 'playlist':
      return !!filter.playlistIds && filter.playlistIds.has(game.id);
    case 'platform':
      return includesIgnoreCase(game.platforms, scope.value);
    case 'tag':
      return includesIgnoreCase(game.tags, scope.value);
    case 'library':
      return game.library.trim().toLowerCase() === scope.value.trim().toLowerCase();
    default:
      return true;
  }
}

export function includesIgnoreCase(values: string[], needle: string): boolean {
  const target = needle.trim().toLowerCase();
  if (!target) {
    return true;
  }
  return values.some((value) => value.trim().toLowerCase() === target);
}

/** Stable key used to decide whether a saved job may be resumed. */
export function scopeKey(scope: Scope, includeImages: boolean): string {
  return `${scope.kind}:${scope.value.trim().toLowerCase()}|images=${includeImages ? 1 : 0}`;
}

export function describeScope(scope: Scope): string {
  return scope.kind === 'all'
    ? 'the whole archive'
    : `${scope.kind} "${scope.value}"`;
}
