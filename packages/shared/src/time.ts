/** UTC day key, e.g. "2026-08-21". Quota buckets are keyed by this. */
export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** UTC month key, e.g. "2026-08". */
export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Adds +/- jitter so the agent never posts on a machine-perfect cadence. */
export function jitter(baseMs: number, jitterMs: number): number {
  if (jitterMs <= 0) return baseMs;
  const delta = Math.floor((Math.random() * 2 - 1) * jitterMs);
  return Math.max(1_000, baseMs + delta);
}

/**
 * Parses "HH:MM-HH:MM" (UTC) and reports whether `d` falls inside it.
 * Handles windows that wrap past midnight.
 */
export function inSleepWindow(window: string, d = new Date()): boolean {
  if (!window) return false;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window.trim());
  if (!m) return false;
  const [, sh, sm, eh, em] = m;
  const start = Number(sh) * 60 + Number(sm);
  const end = Number(eh) * 60 + Number(em);
  const now = d.getUTCHours() * 60 + d.getUTCMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
