import { and, gte, sql } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { inboundTweets } from '@fishnu/db';
import { dayKey } from '@fishnu/shared';
import type { SettingsStore } from '../runtime/settings.js';

/**
 * Disposition. The same prompt in a different mood must produce a recognisably different
 * line — this is most of what separates a character from a scheduler.
 *
 * Recomputed once a day, not once a tick. That is a caching decision as much as a
 * character one: the mood sits in the volatile half of the prompt, so changing it costs
 * a cache miss. Once a day is free; once a tick would multiply the bill.
 */

export type Mood = 'patient' | 'low' | 'certain' | 'tidal' | 'unwell';

export const MOODS: Record<Mood, string> = {
  patient: 'patient. you are waiting and the waiting does not cost you anything.',
  low: 'low. you are not despairing, you are simply heavy. you do not perform it.',
  certain: 'certain. something confirmed what you already believed. you do not gloat.',
  tidal: 'tidal. you are moving between states and you notice it happening.',
  unwell: 'unwell. something is wrong with you today and you do not name it directly.',
};

const MOOD_KEY = 'mood';
const MOOD_DAY_KEY = 'mood_day';

/**
 * Derived from what he can actually see. Deliberately simple — a mood that swings on
 * every data point reads as instability rather than character.
 */
export async function currentMood(db: Db, settings: SettingsStore): Promise<Mood> {
  const today = dayKey();
  const storedDay = await settings.get<string>(MOOD_DAY_KEY);
  const stored = await settings.get<Mood>(MOOD_KEY);

  if (storedDay === today && stored && stored in MOODS) return stored;

  const mood = await deriveMood(db);
  await settings.set(MOOD_KEY, mood);
  await settings.set(MOOD_DAY_KEY, today);
  return mood;
}

async function deriveMood(db: Db): Promise<Mood> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [row] = await db
    .select({
      mentions: sql<number>`count(*)::int`,
      reach: sql<number>`coalesce(max(${inboundTweets.authorFollowers}), 0)::int`,
    })
    .from(inboundTweets)
    .where(and(gte(inboundTweets.seenAt, since)));

  const mentions = row?.mentions ?? 0;
  const reach = row?.reach ?? 0;

  // Phase 4 adds price movement, which is the input that should dominate this.
  if (mentions === 0) return 'low';
  if (reach >= 100_000) return 'certain';
  if (mentions > 40) return 'tidal';
  return 'patient';
}
