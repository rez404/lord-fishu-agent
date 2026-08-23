/**
 * The last thing between a draft and the timeline.
 *
 * There is no human approval queue (decision locked in PLAN.md §1), so these run on every
 * draft and a failure means the draft is discarded, not softened. They are pure functions
 * on purpose: no model call, no network, no way for them to be "mostly" applied.
 *
 * A rejection is not a failure of the system — it is the system. Rejections are written
 * to the thought stream, where they are visible on the public terminal.
 */

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

const MAX_TWEET_LENGTH = 280;

/** Cheap tells that the model reverted to assistant-voice. */
const BANNED_PHRASES = [
  'as an ai',
  "i'm just an ai",
  'as a language model',
  'delve',
  'unlock',
  'harness',
  'game-changer',
  'game changer',
  'let that sink in',
  'buckle up',
  'the bottom line',
  'in conclusion',
  'great question',
  'i hope this helps',
  'feel free to',
  "here's the thing",
  'dive into',
  'navigate the',
  'in the ever-evolving',
  'testament to',
  'it is important to note',
  "it's worth noting",
];

/** Financial promises. He may state what he does; he may never state what will happen. */
const PROMISE_PATTERNS = [
  /\bguarantee/i,
  /\b(will|gonna|going to)\s+(moon|pump|10x|100x|explode|skyrocket)/i,
  /\bprice\s+(will|target)/i,
  /\byou will (make|earn|profit|get rich)/i,
  /\b\d+x\s+(guaranteed|incoming|by)/i,
  /\bnot financial advice\b/i, // the disclaimer is itself a tell; he does not hedge
];

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Punctuation and constructions that read as machine-written in a short social post.
 *
 * These are not style preferences. An em dash in a four-word lowercase post is one of the
 * loudest tells there is — people typing on a phone reach for a comma or nothing at all.
 * Same for the antithesis constructions: "it's not X, it's Y" and "more than just" are
 * shapes a model produces when it is trying to sound profound, and once you have seen
 * them you cannot unsee them.
 */
const MACHINE_TELLS: Array<[RegExp, string]> = [
  [/—/, 'em dash'],
  [/\s;\s|\w;\s/, 'semicolon'],
  [/\b(it'?s|this is|that'?s) not (just )?\w[^.!?]*,? (it'?s|but) /i, '"not X, it\'s Y" construction'],
  [/\bnot (just|merely|only) (a|an|about) \w+[.,]/i, '"not just a X" construction'],
  [/\bmore than (just )?(a|an) /i, '"more than just a" construction'],
  // The antithesis survives being split across sentences, so match the shape rather than
  // the punctuation: "it's not about the price. it's about the patience."
  [/\bnot about\b[\s\S]{0,70}\babout\b/i, '"not about X … about Y" antithesis'],
  [/\bnot\s+\w+[.,]\s+(but|rather)\b/i, '"not X, but Y" antithesis'],
  [/\b(remember|and that'?s)[:,] /i, 'closing aphorism setup'],
];

/**
 * Parallel sentence openings — "Some men wait. Some men sell." — which is the shape a
 * model reaches for when it is trying to sound like a proverb.
 *
 * Counting sentences was the first attempt and it was wrong: three short sentences is
 * just a way of talking, and it rejected lines that are exactly on voice. The tell is the
 * repetition of structure, not the count.
 */
function hasParallelOpenings(text: string): boolean {
  const openings = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().toLowerCase().split(/\s+/).slice(0, 2).join(' '))
    .filter((o) => o.split(' ').length === 2);

  return new Set(openings).size < openings.length;
}

export function checkDraft(text: string, opts: { isReply: boolean }): GuardVerdict {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_TWEET_LENGTH) {
    return { ok: false, reason: `too long (${trimmed.length}/${MAX_TWEET_LENGTH})` };
  }

  if (EMOJI.test(trimmed)) return { ok: false, reason: 'contains emoji' };
  if (/#\w/.test(trimmed)) return { ok: false, reason: 'contains a hashtag' };

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) return { ok: false, reason: `banned phrase: "${phrase}"` };
  }

  for (const pattern of PROMISE_PATTERNS) {
    if (pattern.test(trimmed)) return { ok: false, reason: 'reads as a financial promise' };
  }

  // Models love to wrap output in quotes or announce what they are about to do.
  if (/^["'`]|["'`]$/.test(trimmed)) return { ok: false, reason: 'wrapped in quotes' };
  if (/^(sure|certainly|of course|absolutely)[,!. ]/i.test(trimmed)) {
    return { ok: false, reason: 'assistant preamble' };
  }
  if (/^(here'?s|here is)\b/i.test(trimmed)) return { ok: false, reason: 'assistant preamble' };

  for (const [pattern, label] of MACHINE_TELLS) {
    if (pattern.test(trimmed)) return { ok: false, reason: `machine tell: ${label}` };
  }

  if (hasParallelOpenings(trimmed)) {
    return { ok: false, reason: 'machine tell: parallel sentence openings' };
  }

  // Engagement farming is a bot signature; an idle question is not. "is it normal to be
  // this attached to a ceiling fan" is a person thinking out loud. "What do YOU think?"
  // is a growth hack. Only the second kind is banned.
  if (FARMING.some((p) => p.test(trimmed))) {
    return { ok: false, reason: 'reply-farming' };
  }

  // He is one voice, not a thread-writer.
  if ((trimmed.match(/\n\n/g) ?? []).length > 1) {
    return { ok: false, reason: 'reads as a thread, not a line' };
  }

  return { ok: true };
}

const FARMING = [
  /\bwhat do you (think|reckon)\b/i,
  /\bwho'?s with me\b/i,
  /\bdrop (a|your) \w+ (below|in the )/i,
  /\b(comment|reply) (below|with)\b/i,
  /\blet me know (what|if|in)\b/i,
  /\bam i (right|wrong)\?\s*$/i,
  /\bthoughts\?\s*$/i,
  /\bagree\?\s*$/i,
];

/** Cosine similarity over the embedding vectors, for the anti-repetition check. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Above this, the draft is something he has effectively already said.
 *
 * Unprompted posts are held to a stricter bar than replies. A reply is anchored to
 * someone else's words, so two replies can legitimately land near each other; two
 * unprompted posts landing near each other is him repeating himself in public, which is
 * the fastest way for a timeline to start reading as generated.
 */
export const REPETITION_THRESHOLD = 0.85;
export const POST_REPETITION_THRESHOLD = 0.78;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from', 'has', 'have',
  'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'not', 'of', 'on', 'or', 'that', 'the',
  'they', 'this', 'to', 'was', 'we', 'what', 'when', 'who', 'will', 'with', 'you', 'your',
]);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

/**
 * Word-overlap similarity, run alongside the embedding check.
 *
 * Embeddings measure meaning, which is exactly why they miss a certain kind of repeat:
 * the same sentence with its clauses swapped, or one noun changed, can land below the
 * cosine threshold while being obviously the same post to a reader. Overlap catches that.
 * The two checks fail differently, so both run.
 */
export function overlap(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;

  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

/** Above this share of shared content words, it is a rewording of something he has said. */
export const OVERLAP_THRESHOLD = 0.6;
