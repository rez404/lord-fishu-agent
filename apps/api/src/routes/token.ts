import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import type { Db } from '@fishnu/db';
import { settings } from '@fishnu/db';

/**
 * The token, from DexScreener.
 *
 * Price, market cap, liquidity, volume and the change buckets come from DexScreener.
 * Candles come from GeckoTerminal, which indexes new pools on a delay — so a token that
 * launched an hour ago returns an empty series and the page shows the ticker without a
 * chart until it fills. Drawing a line from DexScreener's four change figures instead
 * would be an invention: each is measured from now backwards, not a series.
 */

const CACHE_KEY = 'fishnu:token';
const CACHE_SECONDS = 45;

export interface TokenPayload {
  live: boolean;
  address: string | null;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  txns24h: { buys: number; sells: number } | null;
  /** Oldest first. Empty until the pool has been indexed. */
  candles: Array<{ t: number; o: number; h: number; l: number; c: number }>;
  url: string | null;
  fetchedAt?: string;
  error?: string;
}

const EMPTY: TokenPayload = {
  live: false,
  address: null,
  symbol: null,
  name: null,
  priceUsd: null,
  marketCap: null,
  liquidityUsd: null,
  volume24h: null,
  change: { m5: null, h1: null, h6: null, h24: null },
  txns24h: null,
  candles: [],
  url: null,
};

export async function registerTokenRoutes(app: FastifyInstance, opts: { db: Db; redis: Redis | null }) {
  const { db, redis } = opts;

  app.get('/api/token', async () => {
    const contract = await readContract(db);
    if (!contract) return EMPTY;

    const cached = await redis?.get(CACHE_KEY).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as TokenPayload;
        if (parsed.address === contract.address) return parsed;
      } catch {
        /* refetch */
      }
    }

    let payload: TokenPayload;
    try {
      payload = await fetchPair(contract.address, contract.symbol);
    } catch (err) {
      app.log.warn({ err }, 'dexscreener did not answer');
      payload = { ...EMPTY, address: contract.address, symbol: contract.symbol, error: 'no quote' };
    }

    await redis?.setex(CACHE_KEY, CACHE_SECONDS, JSON.stringify(payload)).catch(() => {});
    return payload;
  });
}

async function readContract(db: Db): Promise<{ address: string; symbol: string } | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'knowledge')).limit(1);
  const c = (row?.value as { contract?: { address?: string; symbol?: string } | null } | undefined)?.contract;
  return c?.address ? { address: c.address, symbol: c.symbol ?? '' } : null;
}

async function fetchPair(address: string, symbol: string): Promise<TokenPayload> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`dexscreener: ${res.status}`);

  const json = (await res.json()) as { pairs?: RawPair[] | null };
  const pairs = json.pairs ?? [];
  if (pairs.length === 0) {
    return { ...EMPTY, address, symbol, error: 'not trading yet' };
  }

  // A token can list on several pairs, most of them thin. The deepest one is the price
  // anybody actually gets.
  const pair = pairs.reduce((best, p) =>
    Number(p.liquidity?.usd ?? 0) > Number(best.liquidity?.usd ?? 0) ? p : best,
  );

  const candles = pair.pairAddress ? await fetchCandles(pair.pairAddress) : [];

  return {
    live: true,
    address,
    symbol: pair.baseToken?.symbol ?? symbol,
    name: pair.baseToken?.name ?? null,
    priceUsd: num(pair.priceUsd),
    marketCap: num(pair.marketCap ?? pair.fdv),
    liquidityUsd: num(pair.liquidity?.usd),
    volume24h: num(pair.volume?.h24),
    change: {
      m5: num(pair.priceChange?.m5),
      h1: num(pair.priceChange?.h1),
      h6: num(pair.priceChange?.h6),
      h24: num(pair.priceChange?.h24),
    },
    txns24h: pair.txns?.h24 ? { buys: pair.txns.h24.buys, sells: pair.txns.h24.sells } : null,
    candles,
    url: pair.url ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Candles, newest-first from the API and reversed here.
 *
 * Falls through the timeframes: a pool minutes old has no hourly bars, and one that has
 * been trading for a week has too many minute bars to be a shape. Whichever answers first
 * with something is the one worth drawing.
 */
async function fetchCandles(pool: string): Promise<TokenPayload['candles']> {
  const timeframes = ['hour?aggregate=1&limit=48', 'minute?aggregate=15&limit=48', 'minute?aggregate=1&limit=60'];

  for (const tf of timeframes) {
    try {
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${tf}`,
        { signal: AbortSignal.timeout(6_000) },
      );
      if (!res.ok) continue;

      const json = (await res.json()) as {
        data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
      };
      const list = json.data?.attributes?.ohlcv_list ?? [];
      if (list.length < 3) continue;

      return list
        .map(([t, o, h, l, c]) => ({ t, o, h, l, c }))
        .reverse();
    } catch {
      // A missing chart is not a reason to lose the price.
    }
  }
  return [];
}

interface RawPair {
  pairAddress?: string;
  url?: string;
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  baseToken?: { symbol?: string; name?: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: { h24?: { buys: number; sells: number } };
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
