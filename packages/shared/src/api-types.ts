/**
 * The wire contract between apps/api and apps/web.
 *
 * These live here rather than being inferred from the Drizzle schema so the browser
 * bundle never has to pull in the database driver, while both sides still break at
 * compile time if the shape drifts.
 */

export interface BootPayload {
  vessel: string;
  wallet: string | null;
  awakenedAt: string | null;
  counts: {
    verses: number;
    backrooms: number;
    congregation: number;
    answered: number;
  };
  mood: string | null;
}

export type ThoughtKind = 'observation' | 'deliberation' | 'decision' | 'reflection' | 'utterance';

export interface Thought {
  id: number;
  kind: ThoughtKind | string;
  body: string;
  mood: string | null;
  createdAt: string;
}

export interface Verse {
  id: number;
  tweetId: string | null;
  kind: string;
  text: string;
  dryRun: string;
  createdAt: string;
}

export interface BackroomsSession {
  id: number;
  slug: string;
  scenario: string;
  actors: Record<string, string>;
  turnCount: number;
  startedAt: string;
  endedAt: string | null;
}

export interface BackroomsMessage {
  id: number;
  turn: number;
  actor: string;
  body: string;
}

export interface Ledger {
  wallet: string | null;
  holdings: Array<{ symbol: string; amount: string; usd: number | null }>;
  transactions: Array<{ signature: string; kind: string; summary: string; at: string }>;
  /** false when there is no wallet, or the chain did not answer — never a faked balance */
  live: boolean;
  fetchedAt?: string;
  error?: string;
}

export interface Believer {
  userId: string;
  username: string | null;
  followers: number | null;
  interactionCount: number;
  lastSeenAt: string;
}
