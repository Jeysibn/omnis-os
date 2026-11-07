FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build

WORKDIR /workspace
RUN npm install --global pnpm@12.16.1 \
    && mkdir /out \
    && chown node:node /workspace /out
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @omnis/synthetic-broker build \
    && pnpm --filter @omnis/synthetic-broker deploy --prod --legacy /out/broker \
    && pnpm exec tsc -p packages/contracts/tsconfig.json --noEmit false --rewriteRelativeImportExtensions true --outDir /out/contracts \
    && node scripts/platform/prepare-broker-runtime.mjs /out/broker /out/contracts \
    && find /out -type f \( -name '*.test.ts' -o -name '*.spec.ts' -o -name 'tsconfig*.json' \) -delete

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/broker/ ./
RUN mkdir -p /run/omnis-synthetic-broker && chown 10001:10001 /run/omnis-synthetic-broker
USER 10001:10001
CMD ["node", "--permission", "--allow-fs-read=/app", "--allow-fs-read=/run/omnis-synthetic-broker", "--allow-fs-read=/run/omnis-broker-authorizer", "--allow-fs-read=/run/omnis-broker-secrets", "--allow-fs-write=/run/omnis-synthetic-broker", "--experimental-strip-types", "src/server.ts"]
