# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /repo

# pnpm via corepack — pinned via packageManager in root package.json
RUN corepack enable

# Copy workspace manifests first for better layer caching.
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/sdk-js/package.json packages/sdk-js/

RUN pnpm install --frozen-lockfile=false --filter @syrotp/server...

# Copy sources and build.
COPY apps/server apps/server
COPY packages packages
RUN pnpm --filter @syrotp/server build

# Prune dev deps for the runtime image.
RUN pnpm --filter @syrotp/server --prod deploy /out

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

# Run as non-root.
RUN addgroup -S syrotp && adduser -S -G syrotp syrotp
WORKDIR /app

COPY --from=builder --chown=syrotp:syrotp /out/dist ./dist
COPY --from=builder --chown=syrotp:syrotp /out/node_modules ./node_modules
COPY --from=builder --chown=syrotp:syrotp /out/package.json ./package.json
COPY --from=builder --chown=syrotp:syrotp /repo/apps/server/migrations ./migrations

USER syrotp
EXPOSE 3000

# Healthcheck hits /v1/health every 15s.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
