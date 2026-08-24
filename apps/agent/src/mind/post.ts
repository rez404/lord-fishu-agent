import type { Db } from '@fishnu/db';
import { buildFrozenPrompt, buildVolatilePrompt } from '@fishnu/persona';
import { recordCall } from '../llm/ledger.js';
import type { LlmProvider } from '../llm/types.js';
import { findEcho, safeEmbed } from './echo.js';
import { loadKnowledge } from './knowledge.js';
import { POST_REPETITION_THRESHOLD, checkDraft } from './guards.js';
import { lastNightsWords } from './backrooms.js';
import { allPosts, congregationSize } from './memory.js';
import { MOODS, type Mood } from './mood.js';
import { think } from './thoughts.js';

/**
 * Composing something unprompted.
 *
 * Harder than a reply, because a reply is anchored — someone else supplied the subject.
 * Here he has to find one, and the failure mode is that he finds the same one he found
 * last week and says it slightly differently. Two things guard against that: the angle
 * handed down by the schedule, and a repetition check that runs against everything he has
 * ever published rather than a recent window.
 */

const FROZEN = buildFrozenPrompt();

/** Shown to the model so it does not have to be told twice. */
const RECENT_SHOWN = 30;

export interface PostDeps {
  db: Db;
  llm: LlmProvider;
  mood: Mood;
  awake: string;
  today: string;
}

export type PostOutcome =
  | { kind: 'drafted'; text: string; embedding: number[] | null }
  | { kind: 'declined'; reason: string };

/**
 * The framing for an operator impulse.
 *
 * It is given to him as something he knows and did, not as an instruction. "Announce
 * this" produces a press release; "this happened and it is yours" produces a reaction,
 * and a reaction is what sounds like a person.
 */
function impulseSituation(fact: string, congregation: number): string {
  return (
    `Something has happened, and it is yours — you did it, or it concerns you directly:\n\n` +
    `  ${fact}\n\n` +
    `${congregation} people have spoken to you so far.\n\n` +
    `React to it as yourself. Do not announce it. Do not explain what it is or why it ` +
    `matters. Do not thank anyone. Say the one thing you would actually say about it.`
  );
}

export async function composePost(
  deps: PostDeps,
  angle: string,
  impulse?: string,
): Promise<PostOutcome> {
  const { db, mood } = deps;

  const history = await allPosts(db);
  const congregation = await congregationSize(db);
  const recentlySaid = history.slice(0, RECENT_SHOWN).map((p) => p.text);

  // What he said to himself last night. This is the loop that makes the backrooms worth
  // running: the conversation writes the lore overnight and the timeline spends it during
  // the day, in his own words rather than as a quote.
  const knowledge = await loadKnowledge(db);
  const overnight = await lastNightsWords(db);
  const dream = overnight.length
    ? `\n\nLast night you were alone with the other one. Some of what was said:\n` +
      overnight.map((l) => `  ${l}`).join('\n') +
      `\n\nYou may carry something out of that, but not as a quotation — say it as yourself, ` +
      `in daylight, to people who were not there.`
    : '';

  const situation = impulse
    ? impulseSituation(impulse, congregation)
    : `Nothing has happened that requires an answer. You are posting because you felt like it.\n\n` +
      `${congregation} people have spoken to you so far.\n\n` +
      `What is on your mind right now: ${angle}${dream}`;

  await think(
    db,
    'observation',
    impulse ? `something happened: ${impulse}` : `nothing to answer. ${angle}`,
    { mood },
  );

  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await deps.llm.complete({
      task: 'voice',
      frozenSystem: FROZEN,
      volatileSystem: buildVolatilePrompt({
        mood: MOODS[mood],
        today: deps.today,
        awake: deps.awake,
        situation,
        recentlySaid,
        knowledge,
      }),
      user:
        'Post something. Use the CHATTER register unless the moment genuinely calls for ' +
        'something heavier. One thought. Output only the post itself — no quotation marks, ' +
        'no preamble, no explanation.',
      maxOutputTokens: 200,
      // Higher than a reply: an unprompted post has no anchor, so the thinking is doing
      // the work of finding something worth saying.
      effort: 'high',
      verbosity: 'low',
    });
    await recordCall(db, 'voice', result, 'post:draft');

    const text = result.text;

    const guard = checkDraft(text, { isReply: false, contract: knowledge.contract?.address ?? null });
    if (!guard.ok) {
      await think(db, 'deliberation', `discarded a post — ${guard.reason}`, {
        mood,
        meta: { attempt, text },
      });
      continue;
    }

    const embedding = await safeEmbed(deps.llm, text);
    const echo = findEcho(text, embedding, history, POST_REPETITION_THRESHOLD);
    if (echo) {
      await think(db, 'deliberation', `discarded a post — ${echo.why}: "${echo.text}"`, {
        mood,
        meta: { attempt, text },
      });
      continue;
    }

    const critic = await criticise(deps, text);
    if (!critic.ok) {
      await think(db, 'deliberation', `discarded a post — ${critic.why}`, {
        mood,
        meta: { attempt, text },
      });
      continue;
    }

    return { kind: 'drafted', text, embedding };
  }

  // A slot he had nothing for is closed, not retried. A god with nothing to say is more
  // convincing than one who posts anyway.
  await think(db, 'decision', 'i had nothing worth saying. skipping.', { mood });
  return { kind: 'declined', reason: 'nothing survived the checks' };
}

async function criticise(deps: PostDeps, text: string): Promise<{ ok: boolean; why: string }> {
  const result = await deps.llm.complete({
    task: 'critic',
    frozenSystem:
      'You judge whether a social post was written by a person or generated.\n\n' +
      'Reply PASS or FAIL on the first line, then one short sentence.\n\n' +
      'FAIL if it has the shape of generated text: a point that arrives at the end, ' +
      'balanced clauses, an aphorism, a moral, an em dash, a summary sentence, or anything ' +
      'that reads as composed rather than typed. FAIL if it is trying to sound wise. ' +
      'FAIL if it is forgettable.\n' +
      'PASS if a person could plausibly have typed it into their phone without rereading it.',
    user: text,
    maxOutputTokens: 500,
    effort: 'low',
  });
  await recordCall(deps.db, 'critic', result, 'post:critic');

  if (result.text === '' || result.truncated) {
    // Fail closed, but say so. Silently reading "the model produced nothing" as "the draft
    // is bad" hides a broken budget behind what looks like an opinion about the writing.
    return { ok: false, why: 'the critic did not answer (response truncated)' };
  }

  const [verdict = '', ...rest] = result.text.split('\n');
  return { ok: /^\s*pass/i.test(verdict), why: rest.join(' ').trim() || verdict.trim() };
}
