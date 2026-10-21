import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TeamServer, type TeamServerConfig } from './team-server.ts';
import { isTeamScope } from '../../../packages/domain/src/team.ts';
import {
  syncUuid,
  syncHash,
  syncObject,
  syncInteger,
} from '../../../packages/domain/src/sync.ts';
/** Operator-only bootstrap. Emits a token exactly once and persists only its hash. */
export async function provisionOwnerPrincipalToken(
  configFile: string,
): Promise<{ config: TeamServerConfig; token: string }> {
  const path = resolve(configFile),
    directory = dirname(path),
    databasePath = resolve(directory, 'team.sqlite');
  if (existsSync(path) || existsSync(databasePath))
    throw new Error('Team configuration or database already exists');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32);
  try {
    const config: TeamServerConfig = {
      scope: {
        deploymentId: randomUUID(),
        accountId: randomUUID(),
        teamId: randomUUID(),
        metadataVaultId: randomUUID(),
        credentialVaultId: randomUUID(),
      },
      initialOwnerPrincipalId: randomUUID(),
      initialOwnerTokenHash: createHash('sha256').update(token).digest('hex'),
      databasePath,
      host: '127.0.0.1',
      port: 8788,
    };
    const server = new TeamServer(config);
    await server.close();
    writeFileSync(path, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    return { config, token: token.toString('base64url') };
  } finally {
    token.fill(0);
  }
}
export function loadTeamConfig(configFile: string): TeamServerConfig {
  const value: unknown = JSON.parse(readFileSync(configFile, 'utf8'));
  if (
    !syncObject(value, [
      'scope',
      'initialOwnerPrincipalId',
      'initialOwnerTokenHash',
      'databasePath',
      'host',
      'port',
    ]) ||
    !isTeamScope(value.scope) ||
    !syncUuid(value.initialOwnerPrincipalId) ||
    !syncHash(value.initialOwnerTokenHash) ||
    typeof value.databasePath !== 'string' ||
    !existsSync(value.databasePath) ||
    typeof value.host !== 'string' ||
    !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(value.host) ||
    !syncInteger(value.port, 1, 65535)
  )
    throw new Error('Invalid team configuration');
  return value as unknown as TeamServerConfig;
}
async function main(): Promise<void> {
  const [command, file, ...rest] = process.argv.slice(2);
  if (!file || rest.length || !['init', 'start'].includes(command))
    throw new Error('Usage: init|start <config-file>');
  if (command === 'init') {
    const { config, token } = await provisionOwnerPrincipalToken(file);
    process.stdout.write(
      JSON.stringify({
        scope: config.scope,
        ownerPrincipalId: config.initialOwnerPrincipalId,
        token,
      }) + '\n',
    );
    return;
  }
  const server = new TeamServer(loadTeamConfig(file)),
    origin = await server.listen();
  process.stdout.write(`Team listener ${origin}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void main().catch(() => {
    process.stderr.write(
      'Team command failed. Check command/configuration and owned storage.\n',
    );
    process.exitCode = 1;
  });
