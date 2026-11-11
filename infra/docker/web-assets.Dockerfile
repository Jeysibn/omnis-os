FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build

WORKDIR /workspace
RUN npm install --global pnpm@12.16.1 \
    && chown node:node /workspace
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile && pnpm --filter @omnis/web build && node scripts/ci/verify-stage2a-artifact.mjs apps/web/dist apps/web/server-dist

# This image carries static assets only. It intentionally does not select or run a web server.
FROM scratch AS assets
WORKDIR /usr/share/omnis-os/web
COPY --from=build /workspace/apps/web/dist/ ./
USER 65532:65532
