# One image, three entrypoints (agent, api, migrations). Keeps the build cache shared and
# guarantees all three run identical code.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Baked in at build time. Without `prepare`, corepack downloads pnpm on every container
# start, so a registry hiccup on the server becomes a service that will not boot.
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter '!@fishnu/web...'

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/apps/agent/node_modules ./apps/agent/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY apps/agent apps/agent
COPY apps/api apps/api
EXPOSE 8080 8081
CMD ["pnpm", "--filter", "@fishnu/agent", "start"]
