import { createServer } from 'node:http';
import { logger } from '@fishnu/shared';
import type { QuotaManager } from '../quota/manager.js';

export interface HealthState {
  startedAt: Date;
  lastTickAt: Date | null;
  lastTickError: string | null;
  ticks: number;
}

/**
 * Phase 0's definition of done is "survives 72h on the server", which needs something
 * the platform can probe and something we can eyeball. Also exposes the quota ledger so
 * we can reconcile it against X's own usage dashboard.
 */
export function startHealthServer(port: number, state: HealthState, quota: QuotaManager) {
  const server = createServer((req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404).end();
      return;
    }

    void quota
      .snapshot()
      .then((q) => {
        const stale = state.lastTickAt !== null && Date.now() - state.lastTickAt.getTime() > 30 * 60_000;
        const body = {
          ok: !stale,
          uptimeSec: Math.floor((Date.now() - state.startedAt.getTime()) / 1000),
          ticks: state.ticks,
          lastTickAt: state.lastTickAt?.toISOString() ?? null,
          lastTickError: state.lastTickError,
          quota: q,
        };
        res.writeHead(stale ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      });
  });

  server.listen(port, () => logger.info({ port }, 'health server listening'));
  return server;
}
