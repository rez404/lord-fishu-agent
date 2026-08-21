import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { quotaUsage } from '@fishnu/db';
import type { Env } from '@fishnu/shared';
import { dayKey, logger, monthKey } from '@fishnu/shared';
import { DEGRADED_MODE_THRESHOLD, ESSENTIAL_BUCKETS, READ_ALLOCATION } from './allocations.js';

export type QuotaKind = 'read' | 'write';

export interface QuotaGrant {
  rowId: number;
  granted: number;
  kind: QuotaKind;
  bucket: string;
}

export class QuotaExceededError extends Error {
  constructor(
    readonly kind: QuotaKind,
    readonly bucket: string,
    readonly detail: string,
  ) {
    super(`quota exceeded (${kind}/${bucket}): ${detail}`);
    this.name = 'QuotaExceededError';
  }
}

export interface QuotaSnapshot {
  dayReads: number;
  dayWrites: number;
  monthReads: number;
  monthWrites: number;
  monthReadsRemaining: number;
  monthWritesRemaining: number;
  degraded: boolean;
}

export class QuotaManager {
  constructor(
    private readonly db: Db,
    private readonly env: Env,
  ) {}

  /**
   * Reserves budget and writes the ledger row *before* the API call happens.
   * Over-counting that gets corrected by `reconcile` is recoverable; under-counting
   * because the process died mid-call is not.
   */
  async consume(kind: QuotaKind, bucket: string, endpoint: string, amount: number): Promise<QuotaGrant> {
    const granted = await this.authorize(kind, bucket, amount);
    const now = new Date();
    const [row] = await this.db
      .insert(quotaUsage)
      .values({
        kind,
        bucket,
        endpoint,
        amount: granted,
        dayKey: dayKey(now),
        monthKey: monthKey(now),
      })
      .returning({ id: quotaUsage.id });

    return { rowId: row!.id, granted, kind, bucket };
  }

  /** Corrects a reservation down to what the call actually consumed. */
  async reconcile(grant: QuotaGrant, actual: number): Promise<void> {
    if (actual === grant.granted) return;
    await this.db.update(quotaUsage).set({ amount: actual }).where(eq(quotaUsage.id, grant.rowId));
  }

  async snapshot(): Promise<QuotaSnapshot> {
    const [dayReads, dayWrites, monthReads, monthWrites] = await Promise.all([
      this.sum('read', 'day'),
      this.sum('write', 'day'),
      this.sum('read', 'month'),
      this.sum('write', 'month'),
    ]);

    const monthReadsRemaining = Math.max(0, this.env.QUOTA_MONTHLY_READS - monthReads);
    return {
      dayReads,
      dayWrites,
      monthReads,
      monthWrites,
      monthReadsRemaining,
      monthWritesRemaining: Math.max(0, this.env.QUOTA_MONTHLY_WRITES - monthWrites),
      degraded: monthReadsRemaining / this.env.QUOTA_MONTHLY_READS < DEGRADED_MODE_THRESHOLD,
    };
  }

  /**
   * Returns how much of `amount` may be spent. Reads may be granted partially — asking
   * for 100 mentions with 40 left in the bucket should fetch 40, not fail. Writes are
   * indivisible, so they either pass or throw.
   */
  private async authorize(kind: QuotaKind, bucket: string, amount: number): Promise<number> {
    const snap = await this.snapshot();

    if (kind === 'write') {
      if (snap.monthWritesRemaining < amount) {
        throw new QuotaExceededError(kind, bucket, `monthly writes exhausted (${snap.monthWrites}/${this.env.QUOTA_MONTHLY_WRITES})`);
      }
      if (snap.dayWrites + amount > this.env.QUOTA_DAILY_WRITES) {
        throw new QuotaExceededError(kind, bucket, `daily writes exhausted (${snap.dayWrites}/${this.env.QUOTA_DAILY_WRITES})`);
      }
      return amount;
    }

    if (snap.degraded && !ESSENTIAL_BUCKETS.has(bucket)) {
      throw new QuotaExceededError(kind, bucket, `degraded mode: ${snap.monthReadsRemaining} monthly reads left, essentials only`);
    }
    if (snap.monthReadsRemaining <= 0) {
      throw new QuotaExceededError(kind, bucket, 'monthly reads exhausted');
    }

    const bucketCap = Math.floor(this.env.QUOTA_DAILY_READS * (READ_ALLOCATION[bucket] ?? 0));
    if (bucketCap <= 0) {
      throw new QuotaExceededError(kind, bucket, 'bucket has no read allocation');
    }

    const bucketUsed = await this.sumBucket('read', bucket);
    const room = Math.min(
      bucketCap - bucketUsed,
      this.env.QUOTA_DAILY_READS - snap.dayReads,
      snap.monthReadsRemaining,
    );
    if (room <= 0) {
      throw new QuotaExceededError(kind, bucket, `bucket exhausted for today (${bucketUsed}/${bucketCap})`);
    }

    if (room < amount) {
      logger.debug({ bucket, requested: amount, granted: room }, 'partial read grant');
    }
    return Math.min(amount, room);
  }

  private async sum(kind: QuotaKind, period: 'day' | 'month'): Promise<number> {
    const col = period === 'day' ? quotaUsage.dayKey : quotaUsage.monthKey;
    const key = period === 'day' ? dayKey() : monthKey();
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${quotaUsage.amount}), 0)::int` })
      .from(quotaUsage)
      .where(and(eq(quotaUsage.kind, kind), eq(col, key)));
    return row?.total ?? 0;
  }

  private async sumBucket(kind: QuotaKind, bucket: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${quotaUsage.amount}), 0)::int` })
      .from(quotaUsage)
      .where(and(eq(quotaUsage.kind, kind), eq(quotaUsage.bucket, bucket), eq(quotaUsage.dayKey, dayKey())));
    return row?.total ?? 0;
  }
}
