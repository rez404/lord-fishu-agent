import { TwitterApi, ApiResponseError } from 'twitter-api-v2';
import type { Env } from '@fishnu/shared';
import { logger } from '@fishnu/shared';
import type { QuotaManager } from '../quota/manager.js';
import type { ReadPage, XClient, XPublishResult, XTweet, XUser } from './types.js';

const TWEET_FIELDS = ['created_at', 'conversation_id', 'author_id', 'in_reply_to_user_id'] as const;

/** X v2 rejects max_results below 5 on timeline/search endpoints. */
const MIN_RESULTS = 5;
const MAX_RESULTS = 100;

type RawUser = {
  id: string;
  username: string;
  name?: string;
  public_metrics?: { followers_count?: number };
};

type RawPage = {
  data?: Array<{
    id: string;
    text: string;
    author_id?: string;
    conversation_id?: string;
    created_at?: string;
    in_reply_to_user_id?: string;
  }>;
  includes?: { users?: RawUser[] };
  meta?: { newest_id?: string; result_count?: number };
};

function toTweets(page: RawPage): XTweet[] {
  const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
  return (page.data ?? []).map((t) => {
    const author = t.author_id ? users.get(t.author_id) : undefined;
    return {
      id: t.id,
      authorId: t.author_id ?? '',
      authorUsername: author?.username,
      authorFollowers: author?.public_metrics?.followers_count,
      text: t.text,
      conversationId: t.conversation_id,
      createdAt: t.created_at ? new Date(t.created_at) : undefined,
      inReplyToUserId: t.in_reply_to_user_id,
    };
  });
}

function clampResults(n: number): number {
  return Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, n));
}

export class OfficialXClient implements XClient {
  private readonly rw: TwitterApi;
  private readonly env: Env;
  private readonly quota: QuotaManager;

  constructor(env: Env, quota: QuotaManager) {
    this.env = env;
    this.quota = quota;
    this.rw = new TwitterApi({
      appKey: env.X_APP_KEY,
      appSecret: env.X_APP_SECRET,
      accessToken: env.X_ACCESS_TOKEN,
      accessSecret: env.X_ACCESS_SECRET,
    });
  }

  async me(): Promise<XUser> {
    const res = await this.rw.v2.me();
    return { id: res.data.id, username: res.data.username, name: res.data.name };
  }

  async fetchMentions({ sinceId, max }: { sinceId?: string; max: number }): Promise<ReadPage<XTweet>> {
    return this.read('mentions', 'GET /2/users/:id/mentions', max, async (n) => {
      const res = await this.rw.v2.userMentionTimeline(this.env.X_USER_ID, {
        max_results: n,
        ...(sinceId ? { since_id: sinceId } : {}),
        'tweet.fields': [...TWEET_FIELDS],
        expansions: ['author_id'],
        'user.fields': ['username', 'public_metrics'],
      });
      return res.data as RawPage;
    });
  }

  async searchRecent({ query, max, sinceId }: { query: string; max: number; sinceId?: string }): Promise<ReadPage<XTweet>> {
    return this.read('search', 'GET /2/tweets/search/recent', max, async (n) => {
      const res = await this.rw.v2.search(query, {
        max_results: n,
        ...(sinceId ? { since_id: sinceId } : {}),
        'tweet.fields': [...TWEET_FIELDS],
        expansions: ['author_id'],
        'user.fields': ['username', 'public_metrics'],
      });
      return res.data as RawPage;
    });
  }

  async fetchUserTweets({ userId, max, sinceId }: { userId: string; max: number; sinceId?: string }): Promise<ReadPage<XTweet>> {
    return this.read('watchlist', 'GET /2/users/:id/tweets', max, async (n) => {
      const res = await this.rw.v2.userTimeline(userId, {
        max_results: n,
        ...(sinceId ? { since_id: sinceId } : {}),
        'tweet.fields': [...TWEET_FIELDS],
        expansions: ['author_id'],
        'user.fields': ['username', 'public_metrics'],
      });
      return res.data as RawPage;
    });
  }

  async publish({
    text,
    inReplyToTweetId,
    quoteTweetId,
  }: {
    text: string;
    inReplyToTweetId?: string;
    quoteTweetId?: string;
  }): Promise<XPublishResult> {
    const bucket = inReplyToTweetId ? 'reply' : quoteTweetId ? 'quote' : 'post';
    await this.quota.consume('write', bucket, 'POST /2/tweets', 1);

    if (this.env.DRY_RUN) {
      logger.info({ text, inReplyToTweetId, quoteTweetId }, 'DRY_RUN: would publish');
      return { tweetId: null, dryRun: true };
    }

    const res = await this.rw.v2.tweet(text, {
      ...(inReplyToTweetId ? { reply: { in_reply_to_tweet_id: inReplyToTweetId } } : {}),
      ...(quoteTweetId ? { quote_tweet_id: quoteTweetId } : {}),
    });
    return { tweetId: res.data.id, dryRun: false };
  }

  async like(tweetId: string): Promise<void> {
    await this.quota.consume('write', 'like', 'POST /2/users/:id/likes', 1);
    if (this.env.DRY_RUN) {
      logger.info({ tweetId }, 'DRY_RUN: would like');
      return;
    }
    await this.rw.v2.like(this.env.X_USER_ID, tweetId);
  }

  async follow(targetUserId: string): Promise<void> {
    await this.quota.consume('write', 'follow', 'POST /2/users/:id/following', 1);
    if (this.env.DRY_RUN) {
      logger.info({ targetUserId }, 'DRY_RUN: would follow');
      return;
    }
    await this.rw.v2.follow(this.env.X_USER_ID, targetUserId);
  }

  /**
   * Reserves quota for the *requested* page size, makes the call, then reconciles the
   * ledger against how many posts actually came back. Reserving up front is deliberate:
   * a crash mid-call must never leave the budget under-counted.
   */
  private async read(
    bucket: string,
    endpoint: string,
    max: number,
    call: (n: number) => Promise<RawPage>,
  ): Promise<ReadPage<XTweet>> {
    const requested = clampResults(max);
    const grant = await this.quota.consume('read', bucket, endpoint, requested);

    try {
      const page = await call(grant.granted);
      const items = toTweets(page);
      await this.quota.reconcile(grant, items.length);
      return { items, newestId: page.meta?.newest_id, consumed: items.length };
    } catch (err) {
      await this.quota.reconcile(grant, 0);
      if (err instanceof ApiResponseError && err.rateLimitError) {
        logger.warn({ endpoint, rateLimit: err.rateLimit }, 'X rate limit hit');
      }
      throw err;
    }
  }
}
