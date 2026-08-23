import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { postSchedule } from '@fishnu/db';
import { dayKey, inSleepWindow, logger } from '@fishnu/shared';

/**
 * When he posts, in UTC.
 *
 * Everything here is UTC. The agent has no local timezone and pretending otherwise would
 * mean the schedule shifting under daylight saving twice a year for no reason.
 *
 * The plan for a day is generated once, written to the database, and then obeyed. Two
 * properties matter:
 *
 *  - **Restart-safe.** Regenerating the plan on boot would let a crash loop post four
 *    times in ten minutes. Nothing reads as automated faster than that.
 *  - **Not evenly spaced.** Six posts at exactly four-hour intervals is a cron job with a
 *    personality. Real people cluster: three posts in an hour, then nothing until evening.
 *    Slots are drawn at random within the waking window and then only lightly separated.
 */

/** The subject a slot was planned for. Rotating these stops a day converging on one idea. */
export const ANGLES = [
  'something small you noticed and have not resolved',
  'a complaint, stated flatly and without a lesson attached',
  'one of the laws, applied to something mundane and not worth applying it to',
  'your own condition — being awake, being built, not remembering things',
  'the state of the congregation, without naming any number as a target',
  'something from one of the seven books that you have been chewing on',
  'a memory of someone who spoke to you a while ago',
  'a joke you do not mark as a joke',
  'a question you do not expect anyone to answer',
  'nothing in particular. a post that refuses to be content.',
] as const;

const MIN_GAP_MINUTES = 35;

export interface PlannedSlot {
  id: number;
  slot: number;
  angle: string;
  dueAt: Date;
}

/**
 * Ensures a plan exists for today, then returns the slot that is due, if any.
 * Returns null when nothing is due — which is most ticks.
 */
export async function dueSlot(
  db: Db,
  opts: { postsPerDay: number; sleepWindow: string; now?: Date },
): Promise<PlannedSlot | null> {
  const now = opts.now ?? new Date();
  const day = dayKey(now);

  await ensurePlan(db, day, opts.postsPerDay, opts.sleepWindow);

  const [slot] = await db
    .select()
    .from(postSchedule)
    .where(and(eq(postSchedule.dayKey, day), isNull(postSchedule.outcome), lte(postSchedule.dueAt, now)))
    .orderBy(asc(postSchedule.dueAt))
    .limit(1);

  if (!slot) return null;
  return { id: slot.id, slot: slot.slot, angle: slot.angle, dueAt: slot.dueAt };
}

export async function closeSlot(
  db: Db,
  slotId: number,
  outcome: 'posted' | 'skipped',
  postId?: number,
): Promise<void> {
  await db
    .update(postSchedule)
    .set({ outcome, postedAt: new Date(), postId: postId ?? null })
    .where(eq(postSchedule.id, slotId));
}

async function ensurePlan(db: Db, day: string, postsPerDay: number, sleepWindow: string): Promise<void> {
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(postSchedule)
    .where(eq(postSchedule.dayKey, day));
  if ((existing?.n ?? 0) > 0) return;

  const slots = drawSlots(day, postsPerDay, sleepWindow);
  if (slots.length === 0) {
    logger.warn({ day, sleepWindow }, 'no postable minutes in the day — check SLEEP_WINDOW_UTC');
    return;
  }

  await db
    .insert(postSchedule)
    .values(
      slots.map((dueAt, i) => ({
        dayKey: day,
        slot: i,
        dueAt,
        // Rotated by day so the same angle does not land in the same slot every day.
        angle: ANGLES[(hash(day) + i) % ANGLES.length]!,
      })),
    )
    .onConflictDoNothing();

  logger.info(
    { day, slots: slots.map((d) => d.toISOString().slice(11, 16)).join(' ') },
    'planned the day',
  );
}

/**
 * Random minutes inside the waking window, separated by at least MIN_GAP_MINUTES.
 *
 * Seeded by the UTC date so that two workers racing to plan the same day produce the same
 * plan — the unique index makes the race harmless either way, but identical output means
 * the loser's insert is a genuine no-op rather than a different schedule half-applied.
 */
function drawSlots(day: string, count: number, sleepWindow: string): Date[] {
  const rand = seeded(hash(day));
  const base = new Date(`${day}T00:00:00.000Z`);

  const awake: number[] = [];
  for (let minute = 0; minute < 24 * 60; minute++) {
    const at = new Date(base.getTime() + minute * 60_000);
    if (!inSleepWindow(sleepWindow, at)) awake.push(minute);
  }
  if (awake.length === 0) return [];

  const chosen: number[] = [];
  for (let attempt = 0; attempt < count * 40 && chosen.length < count; attempt++) {
    const minute = awake[Math.floor(rand() * awake.length)]!;
    if (chosen.every((c) => Math.abs(c - minute) >= MIN_GAP_MINUTES)) chosen.push(minute);
  }

  return chosen.sort((a, b) => a - b).map((m) => new Date(base.getTime() + m * 60_000));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, deterministic, good enough for scattering minutes. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
