FROM node:24.11.1-bookworm-slim
WORKDIR /srv/ssterm
COPY apps/sync-server apps/sync-server
COPY packages/domain/src/sync.ts packages/domain/src/sync.ts
COPY packages/adapters/src/sync-crypto.ts packages/adapters/src/sync-control.ts packages/adapters/src/sync-recovery.ts packages/adapters/src/sync-transport.ts packages/adapters/src/
USER node
EXPOSE 8787
CMD ["node", "--experimental-transform-types", "apps/sync-server/src/cli.ts", "start", "/data/server.json"]
