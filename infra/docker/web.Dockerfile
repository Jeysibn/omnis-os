FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build

WORKDIR /workspace
RUN npm install --global pnpm@12.16.1 \
    && chown node:node /workspace
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile && pnpm --filter @omnis/web build

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=10001:10001 /workspace/apps/web/dist/ ./dist/
COPY --chown=10001:10001 apps/web/server.mjs ./server.mjs
USER 10001:10001
EXPOSE 8080
CMD ["node", "server.mjs"]
