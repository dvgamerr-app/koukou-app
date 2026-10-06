// Plan usage — the 5-hour and 7-day windows Claude Code puts in the statusLine
// JSON (`rate_limits`). Every session reports them, and they all describe the
// same account, so the island keeps one value per window: the highest any
// session reported for the current window.

export interface UsageWindow {
  /** 0–100. */
  pct: number;
  /** Unix epoch seconds. */
  resetsAt: number;
}

export type UsageKey = "fiveHour" | "sevenDay";

/** Sessions don't report at the same instant; a reset time may wobble a little. */
const SAME_WINDOW_S = 120;

/** Parses one `rate_limits.<window>` object, or null if it isn't usable. */
export function parseWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const { used_percentage: pct, resets_at: resetsAt } = raw as Record<string, unknown>;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  return { pct: Math.max(0, pct), resetsAt };
}

/**
 * Folds a session's report into what the island holds.
 *
 * The max is only meaningful within one window. A report with a later reset
 * time means a new window has started, so it replaces the old value even when
 * it is lower; a window past its reset time is dropped, as Claude Code does.
 */
export function mergeWindow(
  current: UsageWindow | null,
  incoming: UsageWindow | null,
  nowS: number,
): UsageWindow | null {
  const live = current && current.resetsAt > nowS ? current : null;
  if (!incoming || incoming.resetsAt <= nowS) return live;
  if (!live) return incoming;
  if (incoming.resetsAt > live.resetsAt + SAME_WINDOW_S) return incoming;
  if (incoming.resetsAt < live.resetsAt - SAME_WINDOW_S) return live;
  return {
    pct: Math.max(live.pct, incoming.pct),
    resetsAt: Math.max(live.resetsAt, incoming.resetsAt),
  };
}

/** Still inside its window? */
export const isLive = (w: UsageWindow | null, nowS: number): w is UsageWindow =>
  !!w && w.resetsAt > nowS;

/** Bar colour: quiet while there's room, amber getting close, red near the limit. */
export function usageColor(pct: number): string {
  if (pct >= 85) return "#F4505E";
  if (pct >= 60) return "#F5A524";
  return "#34D399";
}
