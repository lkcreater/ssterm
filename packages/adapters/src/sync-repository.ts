/** Main-only sync journal. Private keys, tokens and decrypted snapshots never enter this database. */
import { DatabaseSync } from "node:sqlite";
import { closeSync, lstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { privateStore, writable } from "./files.ts";

export interface SyncStoredOperation {
  hash: string;
  operationId: string;
  epoch: number;
  salt: string;
  wire: string;
  parents: string[];
  sequence: number | null;
  direction: "in" | "out";
  verdict: "pending" | "accepted" | "applied" | "conflict";
}
export interface SyncStoredControl {
  hash: string;
  generation: number;
  publication: unknown;
}
export interface SyncMapping {
  type: string;
  syncId: string;
  localId: string;
  materialized?: number;
}
export class SyncRepositoryFault extends Error {
  constructor(readonly code: "too-large" | "conflict" | "unavailable") {
    super("Sync journal operation failed.");
  }
}
const APP_ID = 0x5353594e;
const IDENTITY = "ssterm-personal-sync-v1";
const MAX_JSON = 20 * 1024 * 1024;
const encode = (v: unknown): string => {
  const json = JSON.stringify(v);
  if (!json || Buffer.byteLength(json) > MAX_JSON)
    throw new SyncRepositoryFault("too-large");
  return json;
};
/** SQL identity/pins/journals advance atomically, independently from catalog/OS/provider mutations. */
export class SyncRepository {
  #closed = false;
  constructor(private readonly db: DatabaseSync) {}
  #available(): void {
    if (this.#closed) throw new SyncRepositoryFault("unavailable");
  }
  identity(): string {
    this.#available();
    return this.db
      .prepare("SELECT identity FROM manifest WHERE singleton=1")
      .get()!.identity as string;
  }
  get<T>(key: string): T | null {
    this.#available();
    const row = this.db.prepare("SELECT value FROM state WHERE key=?").get(key);
    return row ? (JSON.parse(row.value as string) as T) : null;
  }
  set(key: string, value: unknown): void {
    this.#available();
    this.db
      .prepare(
        "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, encode(value));
  }
  remove(key: string): void {
    this.#available();
    this.db.prepare("DELETE FROM state WHERE key=?").run(key);
  }
  transaction<T>(run: () => T): T {
    this.#available();
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
  controls(): SyncStoredControl[] {
    this.#available();
    return this.db
      .prepare(
        "SELECT hash,generation,publication FROM control ORDER BY generation",
      )
      .all()
      .map((r) => ({
        hash: r.hash as string,
        generation: r.generation as number,
        publication: JSON.parse(r.publication as string),
      }));
  }
  addControl(row: SyncStoredControl): void {
    this.#available();
    const old = this.db
      .prepare("SELECT hash,publication FROM control WHERE generation=?")
      .get(row.generation);
    const publication = encode(row.publication);
    if (old) {
      if (old.hash !== row.hash) throw new SyncRepositoryFault("conflict");
      return;
    }
    const budget = this.db
      .prepare(
        "SELECT count(*) AS count, COALESCE(SUM(length(CAST(publication AS BLOB))),0) AS bytes FROM control",
      )
      .get()!;
    if (
      Number(budget.count) >= 256 ||
      Number(budget.bytes) + Buffer.byteLength(publication) > 64 * 1024 * 1024
    )
      throw new SyncRepositoryFault("too-large");
    this.db
      .prepare("INSERT INTO control(hash,generation,publication) VALUES(?,?,?)")
      .run(row.hash, row.generation, publication);
  }
  operations(): SyncStoredOperation[] {
    this.#available();
    return this.db
      .prepare("SELECT value FROM operation ORDER BY ordinal")
      .all()
      .map((r) => JSON.parse(r.value as string) as SyncStoredOperation);
  }
  addOperation(row: SyncStoredOperation): void {
    this.#available();
    const old = this.db
      .prepare(
        "SELECT hash,value FROM operation WHERE operation_id=? OR (epoch=? AND salt=?)",
      )
      .all(row.operationId, row.epoch, row.salt);
    if (old.length) {
      if (old.some((r) => r.hash !== row.hash))
        throw new SyncRepositoryFault("conflict");
      return;
    }
    const retained = this.db
      .prepare(
        "SELECT count(*) AS n,coalesce(sum(length(value)),0) AS bytes FROM operation",
      )
      .get()!;
    if (
      (retained.n as number) >= 256 ||
      (retained.bytes as number) + Buffer.byteLength(encode(row)) >
        64 * 1024 * 1024
    )
      throw new SyncRepositoryFault("too-large");
    const count = this.db
      .prepare("SELECT count(*) AS n FROM operation WHERE epoch=?")
      .get(row.epoch)!.n as number;
    if (count >= 0xffffffff) throw new SyncRepositoryFault("too-large");
    this.db
      .prepare(
        "INSERT INTO operation(hash,operation_id,epoch,salt,value) VALUES(?,?,?,?,?)",
      )
      .run(row.hash, row.operationId, row.epoch, row.salt, encode(row));
  }
  updateOperation(
    hash: string,
    patch: Partial<Pick<SyncStoredOperation, "sequence" | "verdict">>,
  ): void {
    this.#available();
    const raw = this.db
      .prepare("SELECT value FROM operation WHERE hash=?")
      .get(hash);
    if (!raw) throw new Error("Missing sync operation.");
    this.db
      .prepare("UPDATE operation SET value=? WHERE hash=?")
      .run(encode({ ...JSON.parse(raw.value as string), ...patch }), hash);
  }
  mappings(): SyncMapping[] {
    this.#available();
    return this.db
      .prepare(
        "SELECT type,sync_id AS syncId,local_id AS localId,materialized FROM mapping ORDER BY type,sync_id",
      )
      .all() as unknown as SyncMapping[];
  }
  map(type: string, localId: string, syncId?: string): string {
    this.#available();
    const old = this.db
      .prepare("SELECT sync_id FROM mapping WHERE type=? AND local_id=?")
      .get(type, localId);
    if (old) {
      if (!syncId)
        this.db
          .prepare(
            "UPDATE mapping SET materialized=1 WHERE type=? AND local_id=?",
          )
          .run(type, localId);
      return old.sync_id as string;
    }
    if (
      (this.db.prepare("SELECT count(*) AS n FROM mapping").get()!
        .n as number) >= 2000
    )
      throw new SyncRepositoryFault("too-large");
    const generated = syncId ?? randomUUID();
    this.db
      .prepare(
        "INSERT INTO mapping(type,sync_id,local_id,materialized) VALUES(?,?,?,?)",
      )
      .run(type, generated, localId, syncId ? 0 : 1);
    return generated;
  }
  remap(type: string, syncId: string, localId: string): void {
    this.#available();
    this.db
      .prepare(
        "UPDATE mapping SET local_id=?,materialized=0 WHERE type=? AND sync_id=?",
      )
      .run(localId, type, syncId);
  }
  markEnrollment(id: string, state: "pending" | "used" | "cancelled"): void {
    this.#available();
    this.db
      .prepare(
        "INSERT INTO enrollment(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      )
      .run(id, state);
  }
  enrollment(id: string): string | null {
    this.#available();
    return (
      (this.db.prepare("SELECT state FROM enrollment WHERE id=?").get(id)
        ?.state as string) ?? null
    );
  }
  cancelEnrollments(): void {
    this.#available();
    this.db.exec(
      "UPDATE enrollment SET state='cancelled' WHERE state='pending'",
    );
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }
}
export function openSyncRepository(path: string): SyncRepository {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new Error("Invalid sync store.");
  privateStore(path);
  writable(path);
  let fresh = false;
  try {
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || !s.size)
      throw new Error("Foreign sync store.");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    fresh = true;
  }
  if (fresh) {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  }
  const db = new DatabaseSync(path, { timeout: 200 });
  try {
    if (fresh) {
      db.exec(
        `BEGIN IMMEDIATE; PRAGMA application_id=${APP_ID}; PRAGMA user_version=1; CREATE TABLE manifest(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format TEXT NOT NULL,identity TEXT NOT NULL); CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE control(hash TEXT PRIMARY KEY,generation INTEGER NOT NULL UNIQUE,publication TEXT NOT NULL); CREATE TABLE operation(ordinal INTEGER PRIMARY KEY,hash TEXT NOT NULL UNIQUE,operation_id TEXT NOT NULL UNIQUE,epoch INTEGER NOT NULL,salt TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(epoch,salt)); CREATE TABLE mapping(type TEXT NOT NULL,sync_id TEXT NOT NULL,local_id TEXT NOT NULL,materialized INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(type,sync_id),UNIQUE(type,local_id)); CREATE TABLE enrollment(id TEXT PRIMARY KEY,state TEXT NOT NULL);`,
      );
      db.prepare("INSERT INTO manifest VALUES(1,?,?)").run(
        IDENTITY,
        randomUUID(),
      );
      db.exec("COMMIT");
    }
    if (
      db.prepare("PRAGMA application_id").get()?.application_id !== APP_ID ||
      db.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
      db.prepare("SELECT format FROM manifest WHERE singleton=1").get()
        ?.format !== IDENTITY ||
      db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw new Error("Unsupported sync store.");
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    const repo = new SyncRepository(db);
    repo.cancelEnrollments();
    return repo;
  } catch {
    db.close();
    throw new Error("Sync store unavailable.");
  }
}
