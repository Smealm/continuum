import type { ContinuumContext } from './context';
import type { CatalogMeta } from './core/catalog';
import { buildProgressView, ProgressView } from './core/progress';

const REFRESH_MS = 1000;
const FREE_SPACE_REFRESH_MS = 30_000;

/**
 * Shows what Continuum is doing right now. The dialog gets live field updates
 * while it is open; pressing Back only closes the window, the job keeps going.
 */
export async function showProgress(ctx: ContinuumContext): Promise<void> {
  const meta = await ctx.catalog.loadMeta();
  const freeBytes = await ctx.probeFreeBytes(ctx.paths.dataPacksDir);
  const initial = buildProgressView({
    scan: ctx.activity.snapshot(),
    engine: ctx.engine.snapshot(),
    meta,
    freeBytes,
    now: Date.now(),
  });

  const dialogs = ctx.fp.dialogs;
  const canUpdateLive = typeof dialogs.showMessageBoxWithHandle === 'function'
    && typeof dialogs.awaitDialog === 'function'
    && typeof dialogs.updateDialogField === 'function';

  if (!initial.active) {
    await dialogs.showMessageBox({
      message: initial.message,
      buttons: ['Back'],
      cancelId: 0,
      userCanCancel: true,
      largeMessage: true,
    });
    return;
  }

  if (!canUpdateLive) {
    await showRefreshableProgress(ctx, meta, initial);
    return;
  }

  const dialogId = await dialogs.showMessageBoxWithHandle({
    message: initial.message,
    buttons: ['Back'],
    cancelId: 0,
    userCanCancel: true,
    largeMessage: true,
    fields: [
      { type: 'string', name: 'activity', message: 'Current activity', locked: true, value: initial.activity },
      { type: 'string', name: 'stats', message: 'Progress so far', locked: true, value: initial.stats },
      { type: 'string', name: 'timing', message: 'Timing', locked: true, value: initial.timing },
      { type: 'progress', name: 'progress', message: 'Overall progress', value: initial.percent },
    ],
  });

  let closed = false;
  const finished = dialogs.awaitDialog(dialogId)
    .then(() => { closed = true; })
    .catch(() => { closed = true; });

  let cachedFree = freeBytes;
  let freeCheckedAt = Date.now();

  const tick = async (): Promise<void> => {
    if (closed) {
      return;
    }
    const now = Date.now();
    if (now - freeCheckedAt >= FREE_SPACE_REFRESH_MS) {
      cachedFree = await ctx.probeFreeBytes(ctx.paths.dataPacksDir);
      freeCheckedAt = now;
    }
    if (closed) {
      return;
    }
    const view = buildProgressView({
      scan: ctx.activity.snapshot(),
      engine: ctx.engine.snapshot(),
      meta,
      freeBytes: cachedFree,
      now,
    });
    try {
      dialogs.updateDialogField(dialogId, 'activity', view.activity);
      dialogs.updateDialogField(dialogId, 'stats', view.stats);
      dialogs.updateDialogField(dialogId, 'timing', view.timing);
      // The dialog only exists because something was running, so a transition
      // to the idle view means it finished; leave the bar full.
      dialogs.updateDialogField(dialogId, 'progress', view.active ? view.percent : 100);
    } catch {
      // The dialog was closed between the check and the update.
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, REFRESH_MS);
  try {
    await finished;
  } finally {
    clearInterval(timer);
  }
}

/** Fallback for launcher builds without live dialog fields. */
async function showRefreshableProgress(
  ctx: ContinuumContext,
  meta: CatalogMeta | null,
  initial: ProgressView,
): Promise<void> {
  const render = (view: ProgressView): string =>
    [view.title, '', view.message, '', view.activity, view.stats, view.timing].filter(Boolean).join('\n');

  let view = initial;
  for (;;) {
    const choice = await ctx.fp.dialogs.showMessageBox({
      message: render(view),
      buttons: ['Refresh', 'Back'],
      cancelId: 1,
      largeMessage: true,
    });
    if (choice !== 0) {
      return;
    }
    view = buildProgressView({
      scan: ctx.activity.snapshot(),
      engine: ctx.engine.snapshot(),
      meta,
      freeBytes: await ctx.probeFreeBytes(ctx.paths.dataPacksDir),
      now: Date.now(),
    });
  }
}
