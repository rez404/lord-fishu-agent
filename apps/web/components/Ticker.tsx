'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '../lib/api';

/**
 * The token, on the front page.
 *
 * Block characters rather than a drawn chart: it is the only shape that belongs on a
 * terminal, it needs no library, and it reads at a glance without pretending to a
 * precision the data does not have.
 *
 * The chart appears only when there are candles. GeckoTerminal indexes new pools on a
 * delay, so a token that launched an hour ago has none — and an empty axis would say the
 * price went nowhere, which is a different claim from having nothing to show.
 */

interface Token {
  live: boolean;
  symbol: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  txns24h: { buys: number; sells: number } | null;
  candles: Array<{ t: number; o: number; h: number; l: number; c: number }>;
  url: string | null;
  error?: string;
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function Ticker() {
  const [token, setToken] = useState<Token | null>(null);

  useEffect(() => {
    const load = () =>
      fetch(`${API_URL}/api/token`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then(setToken)
        .catch(() => {});
    void load();
    const t = setInterval(load, 45_000);
    return () => clearInterval(t);
  }, []);

  if (!token?.live || token.priceUsd === null) return null;

  const up = (token.change.h24 ?? 0) >= 0;

  return (
    <div className="ticker">
      <div className="ticker-head">
        <span className="bio">{token.symbol ?? 'TOKEN'}</span>
        <span className="ticker-price">${formatPrice(token.priceUsd)}</span>
        <span className={up ? 'bio' : 'coral'}>
          {up ? '▲' : '▼'} {Math.abs(token.change.h24 ?? 0).toFixed(1)}% 24h
        </span>
        {token.url && (
          <a href={token.url} target="_blank" rel="noreferrer">
            chart →
          </a>
        )}
      </div>

      {token.candles.length >= 3 && <Spark candles={token.candles} up={up} />}

      <div className="ticker-stats">
        <span>mcap {usd(token.marketCap)}</span>
        <span>liquidity {usd(token.liquidityUsd)}</span>
        <span>volume {usd(token.volume24h)}</span>
        {token.txns24h && (
          <span>
            <span className="bio">{token.txns24h.buys}</span> bought ·{' '}
            <span className="coral">{token.txns24h.sells}</span> sold
          </span>
        )}
      </div>
    </div>
  );
}

function Spark({ candles, up }: { candles: Token['candles']; up: boolean }) {
  const closes = candles.map((c) => c.c);
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const span = high - low;

  // A flat series would otherwise divide by zero and come out as the bottom row, which
  // reads as a collapse rather than as nothing happening.
  const line = closes
    .map((c) => BLOCKS[span === 0 ? 3 : Math.min(BLOCKS.length - 1, Math.floor(((c - low) / span) * BLOCKS.length))])
    .join('');

  const hours = Math.round((candles[candles.length - 1]!.t - candles[0]!.t) / 3600);

  return (
    <div className="spark">
      <span className={up ? 'spark-line' : 'spark-line spark-down'}>{line}</span>
      <span className="entry-meta">
        {formatPrice(low)} — {formatPrice(high)} · last {hours < 1 ? '<1' : hours}h
      </span>
    </div>
  );
}

/** Sub-cent tokens need every digit; anything else needs two. */
function formatPrice(v: number): string {
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return v.toPrecision(3).replace(/e-(\d+)/, 'e-$1');
}

function usd(v: number | null): string {
  if (v === null) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}m`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}
