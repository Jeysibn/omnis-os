FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build

WORKDIR /workspace
RUN npm install --global pnpm@12.16.1 \
    && mkdir /out \
    && chown node:node /workspace /out
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @omnis/worker build \
    && pnpm --filter @omnis/worker deploy --prod --legacy /out/worker \
    && node scripts/container-images/compile-workspace-runtime.mjs /out/worker \
    && find /out -type f \( -name '*.test.ts' -o -name '*.spec.ts' -o -name 'tsconfig*.json' \) -delete

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/worker/ ./
USER 10001:10001
CMD ["node", "--experimental-strip-types", "src/server.ts"]
