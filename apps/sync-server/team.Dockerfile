FROM node:24.11.1-bookworm-slim
WORKDIR /srv/ssterm
COPY apps/sync-server/src/team-server.ts apps/sync-server/src/team-cli.ts apps/sync-server/src/
COPY packages/domain/src/sync.ts packages/domain/src/team.ts packages/domain/src/
COPY packages/adapters/src/sync-crypto.ts packages/adapters/src/sync-control.ts packages/adapters/src/sync-recovery.ts packages/adapters/src/sync-transport.ts packages/adapters/src/team-policy.ts packages/adapters/src/team-transport.ts packages/adapters/src/
USER node
EXPOSE 8788
CMD ["node", "--experimental-transform-types", "apps/sync-server/src/team-cli.ts", "start", "/data/team.json"]
