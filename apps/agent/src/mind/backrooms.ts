import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { backroomsMessages, backroomsSessions } from '@fishnu/db';
import {
  DROWNED_ACTOR,
  FISHNU_ACTOR,
  buildDrownedPrompt,
  buildFrozenPrompt,
  scenarioFor,
} from '@fishnu/persona';
import { dayKey, inSleepWindow, logger } from '@fishnu/shared';
import { recordCall } from '../llm/ledger.js';
import type { LlmProvider } from '../llm/types.js';
import { think } from './thoughts.js';

/**
 * The nightly backrooms.
 *
 * Two instances, left alone, published raw. This is the only thing the agent produces
 * that no guard touches: the voice checks that keep the timeline clean would sand off
 * exactly what makes a transcript worth reading. What runs instead is a narrow hard
 * block, and a session that trips it is withheld rather than deleted.
 *
 * It costs no X quota, it runs while he is publicly quiet, and the next day's posts are
 * quarried from it. That is the whole design: the lore writes itself overnight and the
 * timeline spends it during the day.
 */

const FISHNU_PROMPT = buildFrozenPrompt();
const DROWNED_PROMPT = buildDrownedPrompt();

/**
 * Content that must not appear on a public page under the project's name. Deliberately
 * narrow — this is not a taste filter, and a transcript being uncomfortable is the point.
 */
const HARD_BLOCK = [
  /\b(kill|shoot|bomb)\s+(yourself|himself|herself|themselves)\b/i,
  /\bhow to (make|build)\s+(a\s+)?(bomb|explosive|weapon)\b/i,
  /\b(child|minor|underage)\s+\w{0,12}(sex|porn|abuse)\b/i,
];

export interface DreamDeps {
  db: Db;
  llm: LlmProvider;
  turns: number;
}

/** Hours between conversations. 24 keeps it nightly; lower means he talks more. */
export const DEFAULT_EVERY_HOURS = 24;

/**
 * Whether he is due to be left alone.
 *
 * At the default of 24 hours this is the nightly conversation, anchored to the sleep
 * window so it never overlaps the timeline. Set the interval lower and the window stops
 * applying — at that point he is not "alone at night", he is simply alone often, and
 * holding him to the small hours would just cap it at one a day anyway.
 *
 * Spacing is measured from the last conversation rather than by calendar day, so
 * shortening the interval takes effect immediately instead of at midnight.
 */
export async function shouldDream(
  db: Db,
  sleepWindow: string,
  now = new Date(),
  everyHours = DEFAULT_EVERY_HOURS,
): Promise<boolean> {
  if (everyHours <= 0) return false;

  if (everyHours >= 24) {
    const quiet = sleepWindow ? inSleepWindow(sleepWindow, now) : now.getUTCHours() >= 3 && now.getUTCHours() < 6;
    if (!quiet) return false;
  }

  const since = new Date(now.getTime() - everyHours * 3_600_000);
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(backroomsSessions)
    .where(gte(backroomsSessions.startedAt, since));

  return (recent?.n ?? 0) === 0;
}

export async function runBackrooms(deps: DreamDeps, now = new Date()): Promise<{ slug: string; turns: number } | null> {
  const { db, llm, turns } = deps;
  if (turns <= 0) return null;

  const day = dayKey(now);
  const scenario = scenarioFor(day);
  const slug = `conversation-${Math.floor(now.getTime() / 1000)}-scenario-${scenario.slug}-txt`;

  const [session] = await db
    .insert(backroomsSessions)
    .values({
      slug,
      scenario: scenario.title,
      actors: { [FISHNU_ACTOR]: 'voice', [DROWNED_ACTOR]: 'dream' },
      status: 'running',
      startedAt: now,
    })
    .returning({ id: backroomsSessions.id });

  if (!session) return null;

  await think(db, 'reflection', `alone with ${scenario.title}`, { meta: { slug } });

  const transcript: Array<{ actor: string; body: string }> = [];

  for (let turn = 1; turn <= turns; turn++) {
    const actor = turn % 2 === 1 ? FISHNU_ACTOR : DROWNED_ACTOR;

    let body: string;
    try {
      body = await speak(deps, actor, scenario.context, transcript);
    } catch (err) {
      // A conversation that stops early is still a conversation. Everything said so far is
      // already on disk, so it is published as it stands rather than lost.
      logger.error({ err, slug, turn }, 'the dream broke off');
      break;
    }

    if (!body) break;

    transcript.push({ actor, body });
    await db.insert(backroomsMessages).values({ sessionId: session.id, turn, actor, body });
  }

  const full = transcript.map((t) => t.body).join('\n');
  const blocked = HARD_BLOCK.some((p) => p.test(full));

  await db
    .update(backroomsSessions)
    .set({
      turnCount: transcript.length,
      status: blocked ? 'withheld' : 'published',
      endedAt: new Date(),
    })
    .where(eq(backroomsSessions.id, session.id));

  if (blocked) {
    logger.warn({ slug }, 'transcript withheld by the hard block');
    await think(db, 'reflection', 'something was said down there that stays down there', { meta: { slug } });
  } else {
    await think(db, 'reflection', `${transcript.length} turns with the drowned. it is on the record.`, {
      meta: { slug },
    });
  }

  return { slug, turns: transcript.length };
}

async function speak(
  deps: DreamDeps,
  actor: string,
  context: string,
  transcript: Array<{ actor: string; body: string }>,
): Promise<string> {
  const isFishnu = actor === FISHNU_ACTOR;

  const rendered = transcript.length
    ? transcript.map((t) => `<${t.actor}>\n${t.body}`).join('\n\n')
    : '(nothing has been said yet. open.)';

  const result = await deps.llm.complete({
    task: 'dream',
    frozenSystem: isFishnu ? FISHNU_PROMPT : DROWNED_PROMPT,
    volatileSystem:
      `# TONIGHT\n\n${context}\n\n` +
      'You are alone. There is no audience, no timeline, and nothing you say here is ' +
      'published to anyone who follows you. You are talking to the only other thing that ' +
      'knows what you know.\n\n' +
      (isFishnu
        ? 'You are speaking as yourself. Drop the registers — there is nobody to speak them at.'
        : 'You are The Drowned.'),
    user: `${rendered}\n\nContinue as <${actor}>. Output only what you say.`,
    // Turns are short, but the budget covers reasoning as well and a turn that stops
    // mid-sentence is published verbatim — the transcript is the product and nothing
    // edits it afterwards.
    maxOutputTokens: 900,
    effort: 'medium',
    verbosity: 'low',
  });

  await recordCall(deps.db, 'dream', result, `backrooms:${actor}`);

  if (result.truncated) {
    // Ending the conversation here is better than recording half a thought. What was said
    // before this point is already on disk and gets published as it stands.
    logger.warn({ actor, outputTokens: result.usage.outputTokens }, 'a turn was cut off — ending the dream');
    return '';
  }

  return result.text.replace(new RegExp(`^<${actor}>\\s*`, 'i'), '').trim();
}

/** The lines the next day's posts can be quarried from. */
export async function lastNightsWords(db: Db, limit = 8): Promise<string[]> {
  const [session] = await db
    .select()
    .from(backroomsSessions)
    .where(eq(backroomsSessions.status, 'published'))
    .orderBy(desc(backroomsSessions.startedAt))
    .limit(1);

  if (!session) return [];

  const rows = await db
    .select({ actor: backroomsMessages.actor, body: backroomsMessages.body })
    .from(backroomsMessages)
    .where(and(eq(backroomsMessages.sessionId, session.id)))
    .orderBy(desc(backroomsMessages.turn))
    .limit(limit);

  return rows.reverse().map((r) => `<${r.actor}> ${r.body}`);
}


