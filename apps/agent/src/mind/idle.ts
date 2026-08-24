import { desc } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { thoughts } from '@fishnu/db';
import { buildFrozenPrompt, buildVolatilePrompt } from '@fishnu/persona';
import { logger } from '@fishnu/shared';
import { recordCall } from '../llm/ledger.js';
import type { LlmProvider } from '../llm/types.js';
import { loadKnowledge } from './knowledge.js';
import { MOODS, type Mood } from './mood.js';
import { think } from './thoughts.js';

/**
 * Thinking between the things he does.
 *
 * Without this the stream is a log of actions: it moves when a mention arrives or a slot
 * comes due and is otherwise still for twenty minutes at a time. The channel is called
 * "what he is thinking, right now" and a page that only updates when something happens is
 * a different thing wearing that name.
 *
 * These never become posts. Nothing here is drafted, judged or published — it is the part
 * of a mind that is running while nobody is being spoken to, and it exists so that the
 * page tells the truth about a thing that is actually awake.
 */

const FROZEN = buildFrozenPrompt();

/** How recently he must have thought before this stays quiet. */
export const IDLE_AFTER_MINUTES = 25;

/** Shown to him so an idle mind does not circle the same thought all evening. */
const RECENT_SHOWN = 12;

export interface IdleDeps {
  db: Db;
  llm: LlmProvider;
  mood: Mood;
  awake: string;
  today: string;
}

export async function thinkIdly(deps: IdleDeps, now = new Date()): Promise<boolean> {
  const { db } = deps;

  const [last] = await db
    .select({ at: thoughts.createdAt })
    .from(thoughts)
    .orderBy(desc(thoughts.createdAt))
    .limit(1);

  if (last && now.getTime() - last.at.getTime() < IDLE_AFTER_MINUTES * 60_000) return false;

  const recent = await db
    .select({ body: thoughts.body })
    .from(thoughts)
    .orderBy(desc(thoughts.createdAt))
    .limit(RECENT_SHOWN);

  try {
    const result = await deps.llm.complete({
      // The cheaper tier: this runs many times a day and nobody outside sees it as prose.
      task: 'reflect',
      frozenSystem: FROZEN,
      volatileSystem: buildVolatilePrompt({
        mood: MOODS[deps.mood],
        today: deps.today,
        awake: deps.awake,
        knowledge: await loadKnowledge(db),
        situation:
          'Nobody is speaking to you. Nothing is due. You are simply awake, and this is not ' +
          'going anywhere — it will not be published and no one is waiting on it.\\n\\n' +
          'Think one thought. Not a post, not a line for anyone. The kind of thing that ' +
          'happens in a mind that has been left running.',
        recentlySaid: recent.map((r) => r.body),
      }),
      user: 'One thought. Two sentences at most. Output only the thought.',
      maxOutputTokens: 400,
      effort: 'low',
      verbosity: 'low',
    });
    await recordCall(db, 'reflect', result, 'idle');

    if (result.truncated || !result.text) return false;

    await think(db, 'deliberation', result.text, { mood: deps.mood, meta: { idle: true } });
    return true;
  } catch (err) {
    // Never worth failing a tick over: this is the least important thing he does.
    logger.debug({ err }, 'idle thought failed');
    return false;
  }
}
