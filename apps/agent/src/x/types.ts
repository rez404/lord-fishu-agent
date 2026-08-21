/**
 * The agent talks to X only through this interface.
 *
 * We are on official API v2 only (decision locked in PLAN.md §1), but the interface
 * stays provider-shaped so that if the read-quota economics force a change later we
 * swap an adapter instead of rewriting the agent.
 */

export interface XUser {
  id: string;
  username: string;
  name?: string;
  followers?: number;
}

export interface XTweet {
  id: string;
  authorId: string;
  authorUsername?: string;
  /** Comes free with the author_id expansion; undefined if X withheld the user object. */
  authorFollowers?: number;
  text: string;
  conversationId?: string;
  createdAt?: Date;
  inReplyToUserId?: string;
}

export interface XPublishResult {
  tweetId: string | null;
  dryRun: boolean;
}

export interface ReadPage<T> {
  items: T[];
  /** newest id in this page, to persist as the next since_id */
  newestId?: string;
  /** how many posts this call actually consumed from the read quota */
  consumed: number;
}

export interface XClient {
  me(): Promise<XUser>;
  fetchMentions(opts: { sinceId?: string; max: number }): Promise<ReadPage<XTweet>>;
  searchRecent(opts: { query: string; max: number; sinceId?: string }): Promise<ReadPage<XTweet>>;
  fetchUserTweets(opts: { userId: string; max: number; sinceId?: string }): Promise<ReadPage<XTweet>>;
  publish(opts: { text: string; inReplyToTweetId?: string; quoteTweetId?: string }): Promise<XPublishResult>;
  like(tweetId: string): Promise<void>;
  follow(targetUserId: string): Promise<void>;
}
