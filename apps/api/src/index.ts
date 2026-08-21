import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { createDb } from '@fishnu/db';
import { loadApiEnv, logger } from '@fishnu/shared';
import { registerRoutes } from './routes/index.js';

async function main() {
  const env = loadApiEnv();
  const db = createDb(env.DATABASE_URL);

  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  const origins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, {
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
  await app.register(registerRoutes, { db });

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info({ port: env.API_PORT, origins }, 'api listening');
}

main().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
