/**
 * Read-quota allocation, as a fraction of the daily read budget.
 *
 * Official-API-only means reads are the binding constraint on everything the agent
 * can perceive, so the split is an explicit product decision rather than a side effect
 * of whatever code happens to run first. See PLAN.md §3.
 */
export const READ_ALLOCATION: Record<string, number> = {
  mentions: 0.3, // non-negotiable: "reply to everything it receives"
  search: 0.5, // proactive hunting
  watchlist: 0.16, // KOL accounts
  reserve: 0.04, // bursts, retries
};

/**
 * When the monthly read budget drops below this fraction, the agent degrades:
 * discovery stops, mentions keep running. Better to go quiet outward than to go
 * deaf to the people already talking to it.
 */
export const DEGRADED_MODE_THRESHOLD = 0.15;

/** Buckets that survive degraded mode. */
export const ESSENTIAL_BUCKETS = new Set(['mentions', 'reply']);
