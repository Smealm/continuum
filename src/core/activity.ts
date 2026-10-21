export type ActivityKind = 'catalogue' | null;

export interface ActivitySnapshot {
  kind: ActivityKind;
  running: boolean;
  percent: number;
  /** Two short lines: current item, and totals so far. */
  lines: string[];
  startedAt: number;
  updatedAt: number;
  outcome: string | null;
  error: string | null;
}

/**
 * Tracks work that is not driven by the download engine (currently the
 * catalogue rebuild), so the live progress dialog can show it even after the
 * dialog that started it has been closed.
 */
export class ActivityTracker {
  private state: ActivitySnapshot = {
    kind: null,
    running: false,
    percent: 0,
    lines: [],
    startedAt: 0,
    updatedAt: 0,
    outcome: null,
    error: null,
  };

  begin(kind: Exclude<ActivityKind, null>, now = Date.now()): void {
    this.state = {
      kind,
      running: true,
      percent: 0,
      lines: [],
      startedAt: now,
      updatedAt: now,
      outcome: null,
      error: null,
    };
  }

  update(percent: number, lines: string[], now = Date.now()): void {
    if (!this.state.running) {
      return;
    }
    this.state.percent = clamp01(percent);
    this.state.lines = lines.slice(0, 2);
    this.state.updatedAt = now;
  }

  finish(outcome: string, now = Date.now()): void {
    if (!this.state.running) {
      return;
    }
    this.state.running = false;
    this.state.percent = 1;
    this.state.outcome = outcome;
    this.state.updatedAt = now;
  }

  fail(error: string, now = Date.now()): void {
    if (!this.state.running) {
      return;
    }
    this.state.running = false;
    this.state.error = error;
    this.state.updatedAt = now;
  }

  reset(): void {
    this.state = {
      kind: null,
      running: false,
      percent: 0,
      lines: [],
      startedAt: 0,
      updatedAt: 0,
      outcome: null,
      error: null,
    };
  }

  snapshot(): ActivitySnapshot {
    return { ...this.state, lines: [...this.state.lines] };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
