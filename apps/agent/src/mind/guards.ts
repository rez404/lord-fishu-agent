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

  // An engagement-farming question is the single most recognisable bot signature.
  if (opts.isReply === false && /\?\s*$/.test(trimmed) && /\b(you|your|anyone|who|what do)\b/i.test(trimmed)) {
    return { ok: false, reason: 'ends in a reply-farming question' };
  }

  // He is one voice, not a thread-writer.
  if ((trimmed.match(/\n\n/g) ?? []).length > 1) {
    return { ok: false, reason: 'reads as a thread, not a line' };
  }

  return { ok: true };
}

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

/** Above this, the draft is something he has effectively already said. */
export const REPETITION_THRESHOLD = 0.85;
