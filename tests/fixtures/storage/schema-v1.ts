import type { DatabaseSync } from "node:sqlite";

/**
 * Rewrites a fresh store into the layouts earlier builds shipped, starting from the DDL stored in the database:
 * - schema 2 (SST-031): `host` without the SST-030 jump/proxy columns;
 * - schema 1 (SST-025–028): additionally the local-only, loopback-only `tunnel_rule`.
 * Only the changed parts are replaced; id/label/uuid checks, keys and foreign keys stay as stored.
 */
const CHAIN_COLUMNS = /, jumpHostId TEXT CHECK\(.*?REFERENCES host\(id\) DEFERRABLE INITIALLY DEFERRED, proxyType TEXT CHECK\(.*?\), proxyHost TEXT CHECK\(.*?\), proxyPort INTEGER CHECK\(\(proxyType IS NULL AND proxyPort IS NULL\) OR \(proxyType IS NOT NULL AND proxyPort IS NOT NULL AND proxyPort BETWEEN 1 AND 65535\)\)/u;
const V1_TUNNEL_COLUMNS = "type TEXT NOT NULL CHECK(type='local'), bindAddress TEXT NOT NULL CHECK(bindAddress IN ('127.0.0.1','::1')), bindPort INTEGER NOT NULL CHECK(bindPort BETWEEN 1 AND 65535), destinationHost TEXT NOT NULL CHECK(length(destinationHost)>0), destinationPort INTEGER NOT NULL CHECK(destinationPort BETWEEN 1 AND 65535), FOREIGN KEY(vaultId,hostId)";

function stored(db: DatabaseSync, table: string): string {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
  if (typeof sql !== "string") throw new Error(`SCHEMA_FIXTURE_NO_${table}`);
  return sql;
}
function renamed(sql: string, table: string, temporary: string): string {
  const next = sql.replace(new RegExp(`^CREATE TABLE "?${table}"? \\(`, "u"), `CREATE TABLE ${temporary} (`);
  if (!next.startsWith(`CREATE TABLE ${temporary} (`)) throw new Error("SCHEMA_FIXTURE_UNEXPECTED_NAME");
  return next;
}

export function downgradeToSchemaV2(db: DatabaseSync): void {
  if (db.prepare("PRAGMA user_version").get()?.user_version !== 3) throw new Error("SCHEMA_FIXTURE_NOT_V3");
  const host = stored(db, "host");
  if (!CHAIN_COLUMNS.test(host)) throw new Error("SCHEMA_FIXTURE_UNEXPECTED_HOST_DDL");
  const v2 = renamed(host.replace(CHAIN_COLUMNS, ""), "host", "host_v2");
  const columns = "id,vaultId,revision,createdAt,updatedAt,label,address,groupId,environment,portMode,portValue,authMode,identityId";
  // Other tables reference host by name, so it is rebuilt with foreign keys off (outside the transaction) and checked.
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN; ${v2};
    INSERT INTO host_v2 (${columns}) SELECT ${columns} FROM host;
    DROP INDEX host_jump_idx; DROP TABLE host; ALTER TABLE host_v2 RENAME TO host;
    CREATE INDEX host_group_idx ON host(vaultId,groupId); CREATE INDEX host_identity_idx ON host(vaultId,identityId);
    PRAGMA user_version=2; COMMIT; PRAGMA foreign_keys=ON;`);
  if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SCHEMA_FIXTURE_FK");
}

export function downgradeToSchemaV1(db: DatabaseSync): void {
  if (db.prepare("PRAGMA user_version").get()?.user_version === 3) downgradeToSchemaV2(db);
  const tunnel = stored(db, "tunnel_rule");
  const start = tunnel.indexOf("type TEXT NOT NULL CHECK(type IN ('local','remote','dynamic'))");
  const end = tunnel.indexOf("FOREIGN KEY(vaultId,hostId)");
  if (start < 0 || end < start) throw new Error("SCHEMA_FIXTURE_UNEXPECTED_DDL");
  const v1 = renamed(`${tunnel.slice(0, start)}${V1_TUNNEL_COLUMNS}${tunnel.slice(end + "FOREIGN KEY(vaultId,hostId)".length)}`, "tunnel_rule", "tunnel_rule_v1");
  db.exec(`PRAGMA foreign_keys=ON; BEGIN; ${v1};
    INSERT INTO tunnel_rule_v1 SELECT id,vaultId,revision,createdAt,updatedAt,label,hostId,type,bindAddress,bindPort,destinationHost,destinationPort FROM tunnel_rule;
    DROP INDEX tunnel_host_idx; DROP TABLE tunnel_rule; ALTER TABLE tunnel_rule_v1 RENAME TO tunnel_rule; CREATE INDEX tunnel_host_idx ON tunnel_rule(vaultId,hostId);
    PRAGMA user_version=1; COMMIT;`);
}
