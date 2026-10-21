import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SyncServer, type SyncServerConfig } from './server.ts';
import { isSyncScope, syncHash, syncObject, syncInteger } from '../../../packages/domain/src/sync.ts';
export async function provision(configFile: string): Promise<{ config: SyncServerConfig; token: string }> {
  const target = resolve(configFile);
  if (existsSync(target)) throw new Error('Configuration already exists');
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = resolve(directory, 'sync.sqlite');
  if (existsSync(databasePath)) throw new Error('Database already exists');
  const bytes = randomBytes(32);
  try {
    const config: SyncServerConfig = {
      deploymentId: randomUUID(),
      accountId: randomUUID(),
      vaultId: randomUUID(),
      tokenHash: createHash('sha256').update(bytes).digest('hex'),
      databasePath,
      host: '127.0.0.1',
      port: 8787,
    };
    const server = new SyncServer(config);
    await server.close();
    writeFileSync(target, JSON.stringify(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { config, token: bytes.toString('base64url') };
  } finally {
    bytes.fill(0);
  }
}
export function loadConfig(configFile: string): SyncServerConfig {
  const value: unknown = JSON.parse(readFileSync(configFile, 'utf8'));
  if (
    !syncObject(value, [
      'deploymentId',
      'accountId',
      'vaultId',
      'tokenHash',
      'databasePath',
      'host',
      'port',
    ]) ||
    !isSyncScope({ deploymentId: value.deploymentId, accountId: value.accountId, vaultId: value.vaultId }) ||
    !syncHash(value.tokenHash) ||
    typeof value.databasePath !== 'string' ||
    !existsSync(value.databasePath) ||
    typeof value.host !== 'string' ||
    !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(value.host) ||
    !syncInteger(value.port, 1, 65535)
  )
    throw new Error('Invalid sync configuration');
  return value as unknown as SyncServerConfig;
}
async function main(): Promise<void> {
  const [command, file, ...rest] = process.argv.slice(2);
  if (!file || rest.length || !['init', 'start'].includes(command))
    throw new Error('Usage: init|start <config-file>');
  if (command === 'init') {
    const { config, token } = await provision(file);
    // This explicit provisioning command is the only place that prints an account token.
    process.stdout.write(
      JSON.stringify({
        scope: { deploymentId: config.deploymentId, accountId: config.accountId, vaultId: config.vaultId },
        token,
      }) + '\n',
    );
    return;
  }
  const server = new SyncServer(loadConfig(file));
  const origin = await server.listen();
  process.stdout.write(`Sync listener ${origin}\n`);
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.stderr.write('Sync command failed. Check command/configuration and owned storage.\n');
    process.exitCode = 1;
  });
}
