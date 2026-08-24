import Redis from 'ioredis';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { createDb } from '@fishnu/db';
import { loadApiEnv, logger } from '@fishnu/shared';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLedgerRoutes } from './routes/ledger.js';
import { registerTokenRoutes } from './routes/token.js';
import { registerRoutes } from './routes/index.js';

async function main() {
  const env = loadApiEnv();
  const db = createDb(env.DATABASE_URL);

  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  const origins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, {
    // The visitor session is a cookie, so the browser only sends it when credentials are
    // allowed — and allowing them means the origin must be echoed exactly, never '*'.
    credentials: true,
    origin: (origin, cb) => {
      // Same-origin and server-to-server requests arrive without an Origin header.
      if (!origin) return cb(null, true);
      // Vercel preview deploys get a fresh subdomain per commit, so an exact-match list
      // alone would break every preview.
      const ok = origins.some((allowed) =>
        allowed.startsWith('*.')
          ? new URL(origin).hostname.endsWith(allowed.slice(1))
          : origin === allowed,
      );
      cb(ok ? null : new Error(`origin ${origin} not allowed`), ok);
    },
  });

  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(registerRoutes, { db, sessionSecret: env.SESSION_SECRET ?? null });
  // Publish-only, so no subscriber-mode restrictions apply.
  const publisher = env.REDIS_URL ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }) : null;
  const wake = publisher
    ? () => {
        void publisher.publish('fishnu:wake', '1').catch((err) => logger.warn({ err }, 'wake failed'));
      }
    : undefined;

  await app.register(registerAdminRoutes, { db, token: env.ADMIN_TOKEN ?? null, wake });
  await app.register(registerLedgerRoutes, { db, redis: publisher, rpcUrl: env.SOLANA_RPC_URL });
  await app.register(registerTokenRoutes, { db, redis: publisher });
  await app.register(registerAuthRoutes, {
    clientId: env.X_CLIENT_ID ?? null,
    clientSecret: env.X_CLIENT_SECRET ?? null,
    callbackUrl: env.X_CALLBACK_URL ?? null,
    siteUrl: env.SITE_URL,
    sessionSecret: env.SESSION_SECRET ?? null,
    redis: publisher,
  });

  if (!env.REDIS_URL) {
    logger.warn('REDIS_URL is not set — impulses will wait for the agent\'s next tick');
  }

  if (!env.ADMIN_TOKEN) {
    logger.warn('ADMIN_TOKEN is not set — the operator routes are disabled');
  }

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info({ port: env.API_PORT, origins }, 'api listening');
}

main().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
