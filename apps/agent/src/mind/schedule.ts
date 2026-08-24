import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
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

/**
 * The floor between two things he says unprompted.
 *
 * Held across the day boundary as well as within a day: the last slot of one plan
 * constrains the first slot of the next, or a 23:50 and a 00:10 sit next to each other on
 * the timeline looking like a machine that reset at midnight.
 *
 * Configurable, because the right value is a judgement about how present he should feel
 * and that changes. Worth knowing when tuning it: as the count approaches the number of
 * gaps the window can hold, the randomness disappears and the plan converges on evenly
 * spaced — which is the one shape this whole mechanism exists to avoid. Leave the day
 * room to cluster.
 */
const MIN_GAP_MINUTES = Number(process.env.MIN_POST_GAP_MINUTES ?? 180);

/**
 * How late a slot may fire before it is dropped instead.
 *
 * A slot means "speak around this time", not "you owe a post". Without this, anything
 * that stops him for a few hours — a restart, the kill switch, dry run being lifted, an
 * outage — turns into a burst of back-to-back posts the moment he resumes, which is the
 * single most recognisable thing an automated account does. Missed time is missed.
 */
const STALE_AFTER_MINUTES = 90;

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

  await ensurePlan(db, day, opts.postsPerDay, opts.sleepWindow, now);

  // Every slot whose time has passed, oldest first — not just the first one, because the
  // stale ones have to be cleared rather than queued behind.
  const due = await db
    .select()
    .from(postSchedule)
    .where(and(isNull(postSchedule.outcome), lte(postSchedule.dueAt, now)))
    .orderBy(asc(postSchedule.dueAt));

  const staleBefore = new Date(now.getTime() - STALE_AFTER_MINUTES * 60_000);
  let dropped = 0;

  for (const slot of due) {
    if (slot.dueAt < staleBefore) {
      await db
        .update(postSchedule)
        .set({ outcome: 'skipped', postedAt: now })
        .where(eq(postSchedule.id, slot.id));
      dropped += 1;
      continue;
    }
    if (dropped > 0) {
      logger.info({ dropped }, 'dropped slots that went stale — he does not catch up');
    }
    return { id: slot.id, slot: slot.slot, angle: slot.angle, dueAt: slot.dueAt };
  }

  if (dropped > 0) {
    logger.info({ dropped }, 'dropped slots that went stale — he does not catch up');
  }
  return null;
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

async function ensurePlan(
  db: Db,
  day: string,
  postsPerDay: number,
  sleepWindow: string,
  now: Date,
): Promise<void> {
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(postSchedule)
    .where(eq(postSchedule.dayKey, day));
  if ((existing?.n ?? 0) > 0) return;

  // The previous plan's last slot is a floor for this one — days are planned separately
  // but the timeline does not care where one ends and the next begins.
  const [previous] = await db
    .select({ at: postSchedule.dueAt })
    .from(postSchedule)
    .orderBy(desc(postSchedule.dueAt))
    .limit(1);

  const slots = drawSlots(day, postsPerDay, sleepWindow, now, previous?.at ?? null);
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
 *
 * A day first planned partway through — a deployment at 23:56, say — must only draw from
 * the time that is left. Drawing across the whole day would create slots that are overdue
 * the moment they are written, and the agent would fire them back to back to catch up:
 * the single most recognisable thing an automated account can do.
 */
function drawSlots(
  day: string,
  count: number,
  sleepWindow: string,
  now: Date,
  notBefore: Date | null,
): Date[] {
  const rand = seeded(hash(day));
  const base = new Date(`${day}T00:00:00.000Z`);
  const isToday = day === dayKey(now);
  const elapsed = isToday ? now.getUTCHours() * 60 + now.getUTCMinutes() : 0;

  // A slot from a previous day still counts against the gap.
  //
  // The comparison is against the previous slot *plus the gap*, not against midnight: a
  // 23:37 slot on the day before constrains the next morning even though it falls before
  // this day starts. Guarding on `notBefore > base` skipped exactly that case, which is
  // the only case this is for.
  const floorMinute = notBefore
    ? Math.ceil((notBefore.getTime() + MIN_GAP_MINUTES * 60_000 - base.getTime()) / 60_000)
    : -Infinity;

  const awake: number[] = [];
  let awakeAllDay = 0;
  for (let minute = 0; minute < 24 * 60; minute++) {
    const at = new Date(base.getTime() + minute * 60_000);
    if (inSleepWindow(sleepWindow, at)) continue;
    awakeAllDay += 1;
    if (minute >= elapsed && minute >= floorMinute) awake.push(minute);
  }
  if (awake.length === 0) return [];

  // Fewer posts in what is left of the day, in proportion to how much of it is left —
  // otherwise a late start crams a full day's posts into the last two hours.
  if (isToday && awakeAllDay > 0) {
    count = Math.max(1, Math.round((count * awake.length) / awakeAllDay));
  }

  // Rejection sampling. With a three-hour floor inside an eighteen-hour day there is not
  // much room, so this often places fewer than asked for — which is the correct outcome:
  // the gap is a rule and the count is a target.
  const chosen: number[] = [];
  for (let attempt = 0; attempt < count * 200 && chosen.length < count; attempt++) {
    const minute = awake[Math.floor(rand() * awake.length)]!;
    if (chosen.every((c) => Math.abs(c - minute) >= MIN_GAP_MINUTES)) chosen.push(minute);
  }

  if (chosen.length < count) {
    logger.info(
      { day, asked: count, placed: chosen.length, gapMinutes: MIN_GAP_MINUTES },
      'fewer slots than asked for — the minimum gap left no room',
    );
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
