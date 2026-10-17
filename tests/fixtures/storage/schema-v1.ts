import type { DatabaseSync } from "node:sqlite";

/**
 * Rewrites a fresh schema-2 store into the schema-1 layout that SST-025–028 shipped. Only `tunnel_rule` changed
 * between the two: its stored v2 DDL is taken from the database and the type/bind/destination constraints are
 * replaced with the exact schema-1 text (id/label/uuid checks, keys and the vault foreign key stay as stored).
 */
const V1_COLUMNS = "type TEXT NOT NULL CHECK(type='local'), bindAddress TEXT NOT NULL CHECK(bindAddress IN ('127.0.0.1','::1')), bindPort INTEGER NOT NULL CHECK(bindPort BETWEEN 1 AND 65535), destinationHost TEXT NOT NULL CHECK(length(destinationHost)>0), destinationPort INTEGER NOT NULL CHECK(destinationPort BETWEEN 1 AND 65535), FOREIGN KEY(vaultId,hostId)";

export function downgradeToSchemaV1(db: DatabaseSync): void {
  const stored = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tunnel_rule'").get()?.sql;
  if (typeof stored !== "string") throw new Error("SCHEMA_V1_NO_TABLE");
  const start = stored.indexOf("type TEXT NOT NULL CHECK(type IN ('local','remote','dynamic'))");
  const end = stored.indexOf("FOREIGN KEY(vaultId,hostId)");
  if (start < 0 || end < start) throw new Error("SCHEMA_V1_UNEXPECTED_DDL");
  const v1 = `${stored.slice(0, start)}${V1_COLUMNS}${stored.slice(end + "FOREIGN KEY(vaultId,hostId)".length)}`
    .replace(/^CREATE TABLE "?tunnel_rule"? \(/u, "CREATE TABLE tunnel_rule_v1 (");
  if (!v1.startsWith("CREATE TABLE tunnel_rule_v1 (")) throw new Error("SCHEMA_V1_UNEXPECTED_NAME");
  db.exec(`PRAGMA foreign_keys=ON; BEGIN; ${v1};
    INSERT INTO tunnel_rule_v1 SELECT id,vaultId,revision,createdAt,updatedAt,label,hostId,type,bindAddress,bindPort,destinationHost,destinationPort FROM tunnel_rule;
    DROP INDEX tunnel_host_idx; DROP TABLE tunnel_rule; ALTER TABLE tunnel_rule_v1 RENAME TO tunnel_rule; CREATE INDEX tunnel_host_idx ON tunnel_rule(vaultId,hostId);
    PRAGMA user_version=1; COMMIT;`);
}
