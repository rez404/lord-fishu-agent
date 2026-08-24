import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import type { Db } from '@fishnu/db';
import { settings } from '@fishnu/db';

/**
 * What the wallet holds, read straight from the chain.
 *
 * Read-only and deliberately so: no key is involved, nothing is signed, and the server
 * cannot move a lamport. This is the one page on the site whose claims can be checked by
 * a stranger against a block explorer, which is exactly why it should exist before
 * anything that spends money does.
 */

const CACHE_KEY = 'fishnu:ledger';
const CACHE_SECONDS = 60;
const MAX_SIGNATURES = 12;
const MAX_HOLDINGS = 12;
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface LedgerPayload {
  wallet: string | null;
  holdings: Array<{ symbol: string; amount: string; usd: number | null }>;
  transactions: Array<{ signature: string; kind: string; summary: string; at: string }>;
  live: boolean;
  fetchedAt?: string;
  error?: string;
}

export async function registerLedgerRoutes(
  app: FastifyInstance,
  opts: { db: Db; redis: Redis | null; rpcUrl: string },
) {
  const { db, redis, rpcUrl } = opts;

  app.get('/api/ledger', async () => {
    const knowledge = await readKnowledge(db);
    const wallet = knowledge.wallet;
    if (!wallet) return { wallet: null, holdings: [], transactions: [], live: false } satisfies LedgerPayload;

    // Public RPC endpoints rate-limit hard, and this page is the one people refresh.
    const cached = await redis?.get(CACHE_KEY).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as LedgerPayload;
        if (parsed.wallet === wallet) return parsed;
      } catch {
        /* fall through and refetch */
      }
    }

    let payload: LedgerPayload;
    try {
      payload = await readChain(rpcUrl, wallet, knowledge.contract);
    } catch (err) {
      app.log.warn({ err }, 'could not read the chain');
      // The address is still true even when the RPC is not answering, and saying so beats
      // showing an empty wallet as though it were empty.
      payload = {
        wallet,
        holdings: [],
        transactions: [],
        live: false,
        error: 'the chain did not answer',
      };
    }

    await redis?.setex(CACHE_KEY, CACHE_SECONDS, JSON.stringify(payload)).catch(() => {});
    return payload;
  });
}

async function readKnowledge(db: Db): Promise<{
  wallet: string | null;
  contract: { address: string; symbol: string } | null;
}> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'knowledge')).limit(1);
  const value = row?.value as
    | { wallet?: { address?: string } | null; contract?: { address?: string; symbol?: string } | null }
    | undefined;

  const wallet = typeof value?.wallet?.address === 'string' ? value.wallet.address : null;
  const contract =
    value?.contract && typeof value.contract.address === 'string'
      ? { address: value.contract.address, symbol: value.contract.symbol ?? '' }
      : null;
  return { wallet, contract };
}

async function readChain(
  rpcUrl: string,
  wallet: string,
  contract: { address: string; symbol: string } | null,
): Promise<LedgerPayload> {
  const [balance, tokens, signatures] = await Promise.all([
    rpc<{ value: number }>(rpcUrl, 'getBalance', [wallet]),
    rpc<{ value: Array<{ account: { data: { parsed: { info: TokenInfo } } } }> }>(
      rpcUrl,
      'getTokenAccountsByOwner',
      [wallet, { programId: SPL_TOKEN_PROGRAM }, { encoding: 'jsonParsed' }],
    ),
    rpc<Array<{ signature: string; blockTime: number | null; err: unknown }>>(
      rpcUrl,
      'getSignaturesForAddress',
      [wallet, { limit: MAX_SIGNATURES }],
    ),
  ]);

  const holdings: LedgerPayload['holdings'] = [
    { symbol: 'SOL', amount: (balance.value / 1e9).toFixed(4), usd: null },
  ];

  for (const entry of tokens.value) {
    const info = entry.account.data.parsed.info;
    const amount = info.tokenAmount?.uiAmountString ?? '0';
    // Dust and closed accounts are noise on a page meant to be read at a glance.
    if (Number(amount) === 0) continue;
    holdings.push({
      symbol:
        contract && info.mint === contract.address && contract.symbol
          ? contract.symbol
          : `${info.mint.slice(0, 4)}…${info.mint.slice(-4)}`,
      amount,
      usd: null,
    });
  }

  // Biggest first after SOL, and capped: a wallet with a long tail of dust turns the page
  // into a scroll nobody reads to the bottom of.
  const [sol, ...rest] = holdings;
  rest.sort((a, b) => Number(b.amount) - Number(a.amount));
  const shown = [sol!, ...rest.slice(0, MAX_HOLDINGS)];
  if (rest.length > MAX_HOLDINGS) {
    shown.push({ symbol: `+${rest.length - MAX_HOLDINGS} more`, amount: '', usd: null });
  }

  return {
    wallet,
    holdings: shown,
    transactions: signatures.map((s) => ({
      signature: s.signature,
      kind: s.err ? 'failed' : 'transaction',
      summary: s.err ? 'failed on chain' : '',
      at: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : '',
    })),
    live: true,
    fetchedAt: new Date().toISOString(),
  };
}

interface TokenInfo {
  mint: string;
  tokenAmount?: { uiAmountString?: string };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`${method}: ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  if (json.result === undefined) throw new Error(`${method}: no result`);
  return json.result;
}
