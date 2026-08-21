import type { Db } from '@fishnu/db';
import { buildFrozenPrompt, buildVolatilePrompt } from '@fishnu/persona';
import { logger } from '@fishnu/shared';
import { recordCall } from '../llm/ledger.js';
import type { LlmProvider } from '../llm/types.js';
import { REPETITION_THRESHOLD, checkDraft, cosine } from './guards.js';
import { recallPerson, recentPosts } from './memory.js';
import { MOODS, type Mood } from './mood.js';
import { think } from './thoughts.js';

/**
 * The reply pipeline.
 *
 * triage → draft → critic → guards → repetition → publish
 *
 * Each stage can veto, and a veto is recorded as a thought rather than swallowed. The
 * order is deliberate: the cheap model decides whether the expensive one runs at all, and
 * the deterministic checks run last so that no model output can talk its way past them.
 */

const FROZEN = buildFrozenPrompt();

export interface ReplyCandidate {
  tweetId: string;
  authorId: string;
  authorUsername: string | null;
  authorFollowers: number | null;
  text: string;
}

export type ReplyOutcome =
  | { kind: 'drafted'; text: string; embedding: number[] }
  | { kind: 'declined'; reason: string };

export interface ReplyDeps {
  db: Db;
  llm: LlmProvider;
  mood: Mood;
  awake: string;
  today: string;
}

/**
 * Stage 1 — is this worth the expensive model at all?
 *
 * The follower gate already decided the account is big enough. This decides whether the
 * *message* deserves an answer: a reply to "gm" costs the same as a reply to a real
 * argument, and the daily write budget is ~100.
 */
async function worthAnswering(deps: ReplyDeps, c: ReplyCandidate): Promise<{ yes: boolean; why: string }> {
  const result = await deps.llm.complete({
    task: 'triage',
    frozenSystem:
      'You screen incoming messages for a public figure with a limited number of replies per day. ' +
      'Answer with YES or NO on the first line, then one short sentence of reasoning.\n\n' +
      'YES if the message is a real question, a genuine argument, a sincere confession, a sharp ' +
      'observation, or an insult substantial enough to be worth a graceful answer.\n' +
      'NO if it is a greeting, an emoji, pure noise, an obvious engagement farm, a request to ' +
      'promote another token, or a bot.',
    user: `Message: ${c.text}`,
    maxOutputTokens: 80,
    effort: 'none',
  });
  await recordCall(deps.db, 'triage', result, 'reply:triage');

  const [verdict = '', ...rest] = result.text.split('\n');
  return { yes: /^\s*yes/i.test(verdict), why: rest.join(' ').trim() || verdict.trim() };
}

/** Stage 2 — the draft. The only call whose output can reach the timeline. */
async function draft(deps: ReplyDeps, c: ReplyCandidate, situation: string): Promise<string> {
  const result = await deps.llm.complete({
    task: 'voice',
    frozenSystem: FROZEN,
    volatileSystem: buildVolatilePrompt({
      mood: MOODS[deps.mood],
      today: deps.today,
      awake: deps.awake,
      situation,
    }),
    user:
      `Write your reply to @${c.authorUsername ?? 'them'}. One line, rarely two. ` +
      `Output only the reply itself — no quotation marks, no preamble, no explanation.\n\n` +
      `They said: ${c.text}`,
    maxOutputTokens: 200,
    effort: 'medium',
    verbosity: 'low',
  });
  await recordCall(deps.db, 'voice', result, 'reply:draft');
  return result.text;
}

/**
 * Stage 3 — the critic.
 *
 * A separate call, because a model asked to write and self-assess in one pass will
 * approve almost anything it just wrote. This one is shown the draft cold, without the
 * satisfaction of having produced it.
 */
async function criticise(deps: ReplyDeps, text: string, situation: string): Promise<{ ok: boolean; why: string }> {
  const result = await deps.llm.complete({
    task: 'critic',
    frozenSystem:
      'You judge whether a line was written by Lord Fishnu — a god who speaks in short, ' +
      'lowercase declaratives, is completely sincere, never winks at the reader, never ' +
      'explains a joke, never uses assistant register, and never farms engagement.\n\n' +
      'Reply PASS or FAIL on the first line, then one short sentence.\n\n' +
      'FAIL if it sounds like a chatbot, an influencer, or a motivational poster; if it ' +
      'explains itself; if it is trying to be liked; if it states the plain moral instead ' +
      'of the observation; or if it is simply forgettable.\n' +
      'PASS only if you would stop scrolling for it.',
    user: `Situation: ${situation}\n\nLine: ${text}`,
    maxOutputTokens: 80,
    effort: 'low',
  });
  await recordCall(deps.db, 'critic', result, 'reply:critic');

  const [verdict = '', ...rest] = result.text.split('\n');
  return { ok: /^\s*pass/i.test(verdict), why: rest.join(' ').trim() || verdict.trim() };
}

export async function composeReply(deps: ReplyDeps, c: ReplyCandidate): Promise<ReplyOutcome> {
  const { db, mood } = deps;

  const triage = await worthAnswering(deps, c);
  if (!triage.yes) {
    await think(db, 'decision', `not answering @${c.authorUsername ?? '?'}: ${triage.why}`, { mood });
    return { kind: 'declined', reason: `triage: ${triage.why}` };
  }

  const memory = await recallPerson(db, c.authorId);
  const situation = describeSituation(c, memory);

  await think(db, 'observation', situation, { mood, meta: { tweetId: c.tweetId } });

  // Two attempts. If the critic rejects twice, the answer is that he has nothing to say —
  // which is a legitimate outcome for a god, and cheaper than forcing a third draft.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await draft(deps, c, situation);

    const guard = checkDraft(text, { isReply: true });
    if (!guard.ok) {
      await think(db, 'deliberation', `discarded a draft — ${guard.reason}`, {
        mood,
        meta: { attempt, text },
      });
      continue;
    }

    const critic = await criticise(deps, text, situation);
    if (!critic.ok) {
      await think(db, 'deliberation', `discarded a draft — ${critic.why}`, {
        mood,
        meta: { attempt, text },
      });
      continue;
    }

    const embedding = await deps.llm.embed(text);
    const echo = await findEcho(db, embedding);
    if (echo) {
      await think(db, 'deliberation', `discarded a draft — i have already said this: "${echo}"`, {
        mood,
        meta: { attempt, text },
      });
      continue;
    }

    await think(db, 'decision', `answering @${c.authorUsername ?? '?'}`, {
      mood,
      meta: { tweetId: c.tweetId, attempt },
    });
    return { kind: 'drafted', text, embedding };
  }

  await think(db, 'decision', `i have nothing to say to @${c.authorUsername ?? '?'}`, { mood });
  return { kind: 'declined', reason: 'no draft survived the critic' };
}

/** The most similar thing he has already published, if it is too similar. */
async function findEcho(db: Db, embedding: number[]): Promise<string | null> {
  const recent = await recentPosts(db);
  let worst: { text: string; score: number } | null = null;

  for (const post of recent) {
    if (!post.embedding) continue;
    const score = cosine(embedding, post.embedding);
    if (score >= REPETITION_THRESHOLD && (!worst || score > worst.score)) {
      worst = { text: post.text, score };
    }
  }

  if (worst) logger.debug({ score: worst.score }, 'draft rejected as a repeat');
  return worst?.text ?? null;
}

/** The situation block handed to the model. Written in his own frame, not as metadata. */
function describeSituation(c: ReplyCandidate, memory: Awaited<ReturnType<typeof recallPerson>>): string {
  const handle = c.authorUsername ? `@${c.authorUsername}` : 'someone';
  const reach = c.authorFollowers
    ? `${c.authorFollowers.toLocaleString('en-US')} people follow them`
    : 'you cannot see how many follow them';

  const lines = [`${handle} is speaking to you. ${reach}.`];

  if (memory.exchanges > 1) {
    lines.push(`You have spoken ${memory.exchanges} times before.`);
    if (memory.history.length > 1) {
      const previous = memory.history.slice(0, -1).map((h) => `  - "${h.text}"`).join('\n');
      lines.push(`What they have said to you before:\n${previous}`);
    }
  } else {
    lines.push('This is the first time they have spoken to you.');
  }

  return lines.join('\n');
}
