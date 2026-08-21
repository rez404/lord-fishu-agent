import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Persistent quota ledger. In-memory counters are not enough: a restart must not
 * be able to re-spend the monthly X API budget.
 */
export const quotaUsage = pgTable(
  'quota_usage',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** 'read' | 'write' */
    kind: text('kind').notNull(),
    /** allocation bucket: 'mentions' | 'search' | 'watchlist' | 'reserve' | 'post' | 'reply' | 'like' | 'follow' */
    bucket: text('bucket').notNull(),
    /** X endpoint that was actually hit, for reconciliation against X's own dashboard */
    endpoint: text('endpoint').notNull(),
    /** number of posts read, or 1 per write */
    amount: integer('amount').notNull(),
    dayKey: text('day_key').notNull(),
    monthKey: text('month_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('quota_usage_day_idx').on(t.dayKey, t.kind),
    index('quota_usage_month_idx').on(t.monthKey, t.kind),
  ],
);

/** Runtime-togglable settings. The kill switch lives here so it can be flipped without a deploy. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Resumable read positions, e.g. mentions since_id. */
export const cursors = pgTable('cursors', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Everything the agent has published. */
export const posts = pgTable(
  'posts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tweetId: text('tweet_id'),
    /** 'post' | 'reply' | 'quote' */
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    inReplyToTweetId: text('in_reply_to_tweet_id'),
    /** true when DRY_RUN meant this was never actually sent */
    dryRun: text('dry_run').notNull().default('false'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('posts_tweet_id_idx').on(t.tweetId), index('posts_created_idx').on(t.createdAt)],
);

/** Inbound tweets the agent has seen (mentions, search hits, watchlist hits). */
export const inboundTweets = pgTable(
  'inbound_tweets',
  {
    tweetId: text('tweet_id').primaryKey(),
    authorId: text('author_id').notNull(),
    authorUsername: text('author_username'),
    /** Captured at ingest time, free of extra quota via the author_id expansion. */
    authorFollowers: integer('author_followers'),
    text: text('text').notNull(),
    /** 'mention' | 'search' | 'watchlist' */
    source: text('source').notNull(),
    conversationId: text('conversation_id'),
    tweetCreatedAt: timestamp('tweet_created_at', { withTimezone: true }),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * 'pending'           — awaiting a decision
     * 'replied'           — answered
     * 'skipped_low_reach' — parked below the follower threshold, revivable
     * 'failed'            — X rejected the reply permanently
     */
    status: text('status').notNull().default('pending'),
    handledAt: timestamp('handled_at', { withTimezone: true }),
    meta: jsonb('meta'),
  },
  (t) => [
    index('inbound_status_idx').on(t.status, t.source),
    index('inbound_reach_idx').on(t.authorFollowers),
    index('inbound_source_idx').on(t.source),
  ],
);

/** Append-only audit log of every action attempt, successful or not. */
export const actionLog = pgTable(
  'action_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    action: text('action').notNull(),
    /** 'ok' | 'skipped' | 'blocked' | 'error' */
    status: text('status').notNull(),
    reason: text('reason'),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('action_log_created_idx').on(t.createdAt), index('action_log_action_idx').on(t.action)],
);

/** People the agent has interacted with. Phase 1 grows this into a real profile store. */
export const people = pgTable(
  'people',
  {
    userId: text('user_id').primaryKey(),
    username: text('username'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    followers: integer('followers'),
    interactionCount: integer('interaction_count').notNull().default(0),
    notes: jsonb('notes'),
  },
);

/**
 * The agent's inner monologue. Every deliberation step writes one row, whether or not
 * it results in an action — this is what the public terminal streams, so it is the
 * product surface as much as it is a log.
 */
export const thoughts = pgTable(
  'thoughts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** 'observation' | 'deliberation' | 'decision' | 'reflection' | 'utterance' */
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    /** mood at the time, so the terminal can colour the line */
    mood: text('mood'),
    /** set when this thought produced a visible action */
    actionId: bigint('action_id', { mode: 'number' }),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('thoughts_created_idx').on(t.createdAt), index('thoughts_kind_idx').on(t.kind)],
);

/**
 * Nightly unsupervised conversations between two instances of the agent, published raw
 * in the style of infinitebackrooms.com. This is the lore engine: the transcripts become
 * the source material the agent quotes from on X the following day.
 */
export const backroomsSessions = pgTable(
  'backrooms_sessions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** permalink slug, e.g. "conversation-1755792000-scenario-tide-of-fishnu-txt" */
    slug: text('slug').notNull(),
    scenario: text('scenario').notNull(),
    /** actor tag -> model id, e.g. { "lord-fishnu": "claude-opus-5", "the-drowned": "claude-sonnet-5" } */
    actors: jsonb('actors').notNull(),
    turnCount: integer('turn_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('backrooms_slug_idx').on(t.slug)],
);

export const backroomsMessages = pgTable(
  'backrooms_messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => backroomsSessions.id, { onDelete: 'cascade' }),
    turn: integer('turn').notNull(),
    /** the actor tag rendered as <actor> in the transcript */
    actor: text('actor').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('backrooms_turn_idx').on(t.sessionId, t.turn)],
);

/** Visitor input from the public terminal. The agent may answer one publicly on X. */
export const confessions = pgTable(
  'confessions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    body: text('body').notNull(),
    /** optional X handle, so a confession can be answered publicly */
    handle: text('handle'),
    /** hashed, for rate limiting only — never displayed */
    sourceHash: text('source_hash').notNull(),
    /** 'pending' | 'answered' | 'ignored' */
    status: text('status').notNull().default('pending'),
    answeredPostId: bigint('answered_post_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('confessions_status_idx').on(t.status), index('confessions_source_idx').on(t.sourceHash)],
);
