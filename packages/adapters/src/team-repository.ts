/** Main-only team journal. Persist ciphertext, public policy and opaque refs, never decrypted records. */
import { DatabaseSync } from "node:sqlite";
import { closeSync, lstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { privateStore, writable } from "./files.ts";
import type { TeamPolicyCheckpoint } from "../../domain/src/team.ts";
import type { SyncOperationPublication } from "../../domain/src/sync.ts";

export class TeamRepositoryFault extends Error {
  constructor(readonly code: "too-large" | "conflict" | "unavailable") {
    super("Team journal operation failed.");
  }
}
export interface TeamBinding {
  virtualHostId: string;
  teamId: string;
  recordId: string;
  retired: boolean;
}
export interface TeamStoredCheckpoint {
  hash: string;
  generation: number;
  checkpoint: TeamPolicyCheckpoint;
}
const APP_ID = 0x5353544d;
const FORMAT = "ssterm-team-client-v1";
const encode = (value: unknown): string => {
  const wire = JSON.stringify(value);
  if (!wire || Buffer.byteLength(wire) > 12 * 1024 * 1024)
    throw new TeamRepositoryFault("too-large");
  return wire;
};
export class TeamRepository {
  #closed = false;
  constructor(private readonly db: DatabaseSync) {}
  #check(): void {
    if (this.#closed) throw new TeamRepositoryFault("unavailable");
  }
  identity(): string {
    this.#check();
    return this.db
      .prepare("SELECT identity FROM manifest WHERE singleton=1")
      .get()!.identity as string;
  }
  get<T>(key: string): T | null {
    this.#check();
    const row = this.db.prepare("SELECT value FROM state WHERE key=?").get(key);
    return row ? (JSON.parse(row.value as string) as T) : null;
  }
  set(key: string, value: unknown): void {
    this.#check();
    this.db
      .prepare(
        "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, encode(value));
  }
  remove(key: string): void {
    this.#check();
    this.db.prepare("DELETE FROM state WHERE key=?").run(key);
  }
  transaction<T>(run: () => T): T {
    this.#check();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  checkpoints(): TeamStoredCheckpoint[] {
    this.#check();
    return this.db
      .prepare(
        "SELECT hash,generation,wire FROM checkpoint ORDER BY generation",
      )
      .all()
      .map((row) => ({
        hash: row.hash as string,
        generation: Number(row.generation),
        checkpoint: JSON.parse(row.wire as string),
      }));
  }
  addCheckpoint(row: TeamStoredCheckpoint): void {
    this.#check();
    const wire = encode(row.checkpoint);
    const old = this.db
      .prepare("SELECT hash,wire FROM checkpoint WHERE generation=? OR hash=?")
      .all(row.generation, row.hash);
    if (old.length) {
      if (old.length !== 1 || old[0].hash !== row.hash || old[0].wire !== wire)
        throw new TeamRepositoryFault("conflict");
      return;
    }
    const budget = this.db
      .prepare(
        "SELECT count(*) AS n,coalesce(sum(length(CAST(wire AS BLOB))),0) AS bytes FROM checkpoint",
      )
      .get()!;
    if (
      Number(budget.n) >= 256 ||
      Number(budget.bytes) + Buffer.byteLength(wire) > 64 * 1024 * 1024
    )
      throw new TeamRepositoryFault("too-large");
    this.db
      .prepare("INSERT INTO checkpoint VALUES(?,?,?)")
      .run(row.hash, row.generation, wire);
  }
  operation(
    domain: "metadata" | "credentials",
    hash: string,
  ): SyncOperationPublication | null {
    this.#check();
    const row = this.db
      .prepare("SELECT wire FROM operation WHERE domain=? AND hash=?")
      .get(domain, hash);
    return row ? JSON.parse(row.wire as string) : null;
  }
  addOperation(
    domain: "metadata" | "credentials",
    hash: string,
    operation: SyncOperationPublication,
  ): void {
    this.#check();
    const wire = encode(operation);
    const old = this.db
      .prepare("SELECT wire FROM operation WHERE domain=? AND hash=?")
      .get(domain, hash);
    if (old) {
      if (old.wire !== wire) throw new TeamRepositoryFault("conflict");
      return;
    }
    const budget = this.db
      .prepare(
        "SELECT count(*) AS n,coalesce(sum(length(CAST(wire AS BLOB))),0) AS bytes FROM operation WHERE domain=?",
      )
      .get(domain)!;
    if (
      Number(budget.n) >= 256 ||
      Number(budget.bytes) + Buffer.byteLength(wire) > 64 * 1024 * 1024
    )
      throw new TeamRepositoryFault("too-large");
    this.db
      .prepare("INSERT INTO operation VALUES(?,?,?)")
      .run(domain, hash, wire);
  }
  binding(virtualHostId: string): TeamBinding | null {
    this.#check();
    const row = this.db
      .prepare(
        "SELECT virtual_id AS virtualHostId,team_id AS teamId,record_id AS recordId,retired FROM binding WHERE virtual_id=?",
      )
      .get(virtualHostId);
    return row
      ? {
          virtualHostId: row.virtualHostId as string,
          teamId: row.teamId as string,
          recordId: row.recordId as string,
          retired: Boolean(row.retired),
        }
      : null;
  }
  bindings(): TeamBinding[] {
    this.#check();
    return this.db
      .prepare(
        "SELECT virtual_id AS virtualHostId,team_id AS teamId,record_id AS recordId,retired FROM binding ORDER BY virtual_id",
      )
      .all()
      .map((row) => ({
        virtualHostId: row.virtualHostId as string,
        teamId: row.teamId as string,
        recordId: row.recordId as string,
        retired: Boolean(row.retired),
      }));
  }
  bind(teamId: string, recordId: string): string {
    this.#check();
    const old = this.db
      .prepare(
        "SELECT virtual_id,retired FROM binding WHERE team_id=? AND record_id=?",
      )
      .get(teamId, recordId);
    if (old) {
      if (old.retired) throw new TeamRepositoryFault("conflict");
      return old.virtual_id as string;
    }
    // Tombstones are permanent. Refuse admission at the bound rather than pruning bindings.
    if (
      Number(this.db.prepare("SELECT count(*) AS n FROM binding").get()!.n) >=
      4096
    )
      throw new TeamRepositoryFault("too-large");
    const raw = randomUUID();
    const id = `7ea03700-${raw.slice(9, 14)}8${raw.slice(15)}`;
    this.db
      .prepare("INSERT INTO binding VALUES(?,?,?,0)")
      .run(id, teamId, recordId);
    return id;
  }
  retireMissing(teamId: string, currentRecordIds: readonly string[]): void {
    this.#check();
    const current = new Set(currentRecordIds);
    for (const binding of this.bindings())
      if (binding.teamId === teamId && !current.has(binding.recordId))
        this.db
          .prepare("UPDATE binding SET retired=1 WHERE virtual_id=?")
          .run(binding.virtualHostId);
  }
  markEnrollment(id: string, state: "pending" | "used" | "cancelled"): void {
    this.#check();
    const old = this.enrollment(id);
    if (old && old !== "pending" && old !== state)
      throw new TeamRepositoryFault("conflict");
    this.db
      .prepare(
        "INSERT INTO enrollment VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      )
      .run(id, state);
  }
  enrollment(id: string): string | null {
    this.#check();
    return (
      (this.db.prepare("SELECT state FROM enrollment WHERE id=?").get(id)
        ?.state as string) ?? null
    );
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }
}
export function openTeamRepository(path: string): TeamRepository {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new Error("Invalid team store.");
  privateStore(path);
  writable(path);
  let fresh = false;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size)
      throw new Error("Foreign team store.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fresh = true;
  }
  if (fresh) {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  }
  const db = new DatabaseSync(path, { timeout: 200 });
  try {
    if (fresh) {
      db.exec(`BEGIN IMMEDIATE; PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;
        CREATE TABLE manifest(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format TEXT NOT NULL,identity TEXT NOT NULL);
        CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE checkpoint(hash TEXT PRIMARY KEY,generation INTEGER NOT NULL UNIQUE,wire TEXT NOT NULL);
        CREATE TABLE operation(domain TEXT NOT NULL CHECK(domain IN ('metadata','credentials')),hash TEXT NOT NULL,wire TEXT NOT NULL,PRIMARY KEY(domain,hash));
        CREATE TABLE binding(virtual_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,record_id TEXT NOT NULL,retired INTEGER NOT NULL,UNIQUE(team_id,record_id));
        CREATE TABLE enrollment(id TEXT PRIMARY KEY,state TEXT NOT NULL);`);
      db.prepare("INSERT INTO manifest VALUES(1,?,?)").run(
        FORMAT,
        randomUUID(),
      );
      db.exec("COMMIT");
    }
    if (
      db.prepare("PRAGMA application_id").get()?.application_id !== APP_ID ||
      db.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
      db.prepare("SELECT format FROM manifest WHERE singleton=1").get()
        ?.format !== FORMAT ||
      db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw new Error("Unsupported team store.");
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; UPDATE enrollment SET state='cancelled' WHERE state='pending'",
    );
    return new TeamRepository(db);
  } catch {
    db.close();
    throw new Error("Team store unavailable.");
  }
}
