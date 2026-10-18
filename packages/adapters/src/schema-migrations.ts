import type { MigrationStep } from './migrations.ts';
import { hostChainColumns, tunnelColumns } from './schema.ts';

/**
 * Production migration chain. Each step runs in its own transaction after a verified backup. Steps that do not touch
 * protected content (snippet ciphertext, secret refs, the vault key) declare `preservesProtection`, so vaults that
 * already hold encrypted snippets can upgrade.
 */
export const MIGRATIONS: readonly MigrationStep[] = [{
  from: 1,
  to: 2,
  preservesProtection: true,
  preservesJournal: true,
  // SST-031: rebuild tunnel_rule with remote/dynamic types; every v1 row is a valid local rule in v2.
  apply(db) {
    db.exec(`CREATE TABLE tunnel_rule_v2 (${tunnelColumns}, UNIQUE(vaultId,id), FOREIGN KEY(vaultId) REFERENCES local_vault(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
      INSERT INTO tunnel_rule_v2 (id,vaultId,revision,createdAt,updatedAt,label,hostId,type,bindAddress,bindPort,destinationHost,destinationPort)
        SELECT id,vaultId,revision,createdAt,updatedAt,label,hostId,type,bindAddress,bindPort,destinationHost,destinationPort FROM tunnel_rule;
      DROP INDEX tunnel_host_idx;
      DROP TABLE tunnel_rule;
      ALTER TABLE tunnel_rule_v2 RENAME TO tunnel_rule;
      CREATE INDEX tunnel_host_idx ON tunnel_rule(vaultId,hostId);`);
  },
}, {
  from: 2,
  to: 3,
  preservesProtection: true,
  preservesJournal: true,
  // SST-030: jump host / proxy columns, all NULL for existing hosts (a direct connection, as before).
  apply(db) {
    for (const column of hostChainColumns) db.exec(`ALTER TABLE host ADD COLUMN ${column}`);
    db.exec('CREATE INDEX host_jump_idx ON host(jumpHostId)');
  },
}];
