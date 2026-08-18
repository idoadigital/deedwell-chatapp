# Deedwell API — runs via tsx at runtime, matching local dev (no separate build step).
# Build context is the repo root (pnpm workspace needs every package.json + the root lockfile).
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Workspace manifests first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/site-router/package.json apps/site-router/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/browser-research/package.json packages/browser-research/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/grant-domain/package.json packages/grant-domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY packages/website-domain/package.json packages/website-domain/package.json
COPY packages/workflows/package.json packages/workflows/package.json

RUN pnpm install --frozen-lockfile --prod=false

COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["pnpm", "exec", "tsx", "apps/api/src/main.ts"]
