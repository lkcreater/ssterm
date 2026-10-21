/** Separate one-team ciphertext authority; never stores host labels or plaintext passwords. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { createHash, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import * as T from "../../../packages/domain/src/team.ts";
import {
  SYNC_HTTP_MAX,
  SYNC_SUITE,
  syncHash,
  syncUuid,
  syncBytes,
  type SyncTransportCode,
  type SyncControlPublication,
  type SyncOperationPublication,
} from "../../../packages/domain/src/sync.ts";
import {
  acceptTeamCheckpoint,
  teamOwnerKey,
  teamPolicyHash,
  verifyTeamOperation,
  verifyTeamWraps,
  type AcceptedTeamCheckpoint,
} from "../../../packages/adapters/src/team-policy.ts";
import { teamRequestTranscript } from "../../../packages/adapters/src/team-transport.ts";
import {
  fingerprint,
  unframe,
  parseWrapHeader,
  parseRecoveryHeader,
  type DataHeader,
} from "../../../packages/adapters/src/sync-crypto.ts";
import { parseEnrollmentBody } from "../../../packages/adapters/src/sync-control.ts";
import { parseRecoveryDescriptor } from "../../../packages/adapters/src/sync-recovery.ts";
export interface TeamServerConfig {
  scope: T.TeamScope;
  databasePath: string;
  initialOwnerPrincipalId: string;
  initialOwnerTokenHash: string;
  host?: string;
  port?: number;
}
export interface TeamServerOptions {
  now?: () => number;
  requestLimit?: number;
  windowMs?: number;
  nonceLimit?: number;
  auditLimit?: number;
}
class Rejection extends Error {
  constructor(readonly code: SyncTransportCode) {
    super(code);
  }
}
function requireValue(
  ok: unknown,
  code: SyncTransportCode = "invalid",
): asserts ok {
  if (!ok) throw new Rejection(code);
}
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const decode = (s: string) => Buffer.from(s, "base64url");
const checkpoint = (p: T.TeamAtomicPublication): T.TeamPolicyCheckpoint => ({
  policy: p.policy,
  metadataControl: p.metadata.control,
  credentialControl: p.credentials.control,
});
const sanitize = (p: T.TeamPolicyCheckpoint): T.TeamPolicyCheckpoint => ({
  policy: p.policy,
  metadataControl: { ...p.metadataControl, wraps: [], recoveryWire: null },
  credentialControl: { ...p.credentialControl, wraps: [], recoveryWire: null },
});
const APP_ID = 0x53544541;
type Actor = { principalId: string; deviceId: string | null; role: T.TeamRole };
export class TeamServer {
  readonly server: Server;
  private readonly db: DatabaseSync;
  private current?: AcceptedTeamCheckpoint;
  private currentPublication?: T.TeamAtomicPublication;
  private metadataHead: string | null = null;
  private credentialHead: string | null = null;
  private readonly now: () => number;
  private bodies = 0;
  private closed = false;
  private readonly rates = new Map<string, { start: number; count: number }>();
  constructor(
    readonly config: TeamServerConfig,
    private readonly options: TeamServerOptions = {},
  ) {
    requireValue(
      T.isTeamScope(config.scope) &&
        syncUuid(config.initialOwnerPrincipalId) &&
        syncHash(config.initialOwnerTokenHash) &&
        typeof config.databasePath === "string" &&
        config.databasePath.length > 0,
    );
    this.now = options.now ?? Date.now;
    if (config.databasePath !== ":memory:") {
      mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
      if (existsSync(config.databasePath))
        requireValue(lstatSync(config.databasePath).isFile());
      else writeFileSync(config.databasePath, "", { flag: "wx", mode: 0o600 });
    }
    this.db = new DatabaseSync(config.databasePath);
    try {
      const app = this.db
          .prepare("PRAGMA application_id")
          .get()?.application_id,
        version = this.db.prepare("PRAGMA user_version").get()?.user_version,
        tables = this.db
          .prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'")
          .get()?.n;
      requireValue(
        (app === APP_ID && version === 1) ||
          (app === 0 && version === 0 && tables === 0),
        "unsupported",
      );
      if (tables === 0) {
        this.db
          .exec(`BEGIN;PRAGMA application_id=${APP_ID};PRAGMA user_version=1;
    CREATE TABLE identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),config TEXT NOT NULL);
    CREATE TABLE policies(generation INTEGER PRIMARY KEY,hash TEXT UNIQUE NOT NULL,publication TEXT NOT NULL,receipt TEXT NOT NULL);
    CREATE TABLE operations(domain TEXT NOT NULL,hash TEXT NOT NULL,operationId TEXT NOT NULL,epoch INTEGER NOT NULL,salt TEXT NOT NULL,publication TEXT NOT NULL,PRIMARY KEY(domain,hash),UNIQUE(domain,operationId),UNIQUE(domain,epoch,salt));
    CREATE TABLE heads(domain TEXT PRIMARY KEY,hash TEXT NOT NULL);
    CREATE TABLE bindings(deviceId TEXT PRIMARY KEY,principalId TEXT NOT NULL,signing TEXT NOT NULL,wrapping TEXT NOT NULL);
    CREATE TABLE admissions(requestId TEXT PRIMARY KEY,nonce TEXT UNIQUE NOT NULL,hash TEXT UNIQUE NOT NULL);
    CREATE TABLE nonces(nonce TEXT PRIMARY KEY,principalId TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,entry TEXT NOT NULL);
    CREATE TABLE events(eventId TEXT PRIMARY KEY,principalId TEXT NOT NULL,deviceId TEXT NOT NULL,event TEXT NOT NULL);
    COMMIT;`);
        this.db.prepare("INSERT INTO identity VALUES(1,?)").run(
          JSON.stringify({
            scope: config.scope,
            initialOwnerPrincipalId: config.initialOwnerPrincipalId,
            initialOwnerTokenHash: config.initialOwnerTokenHash,
          }),
        );
      }
      requireValue(
        this.db.prepare("SELECT config FROM identity WHERE singleton=1").get()
          ?.config ===
          JSON.stringify({
            scope: config.scope,
            initialOwnerPrincipalId: config.initialOwnerPrincipalId,
            initialOwnerTokenHash: config.initialOwnerTokenHash,
          }),
        "unsupported",
      );
      for (const row of this.db
        .prepare("SELECT publication FROM policies ORDER BY generation")
        .iterate()) {
        const pub = JSON.parse(
          row.publication as string,
        ) as T.TeamAtomicPublication;
        requireValue(T.isTeamAtomicPublication(pub));
        this.current = acceptTeamCheckpoint(
          checkpoint(pub),
          config.scope,
          teamOwnerKey(pub.policy.body),
          this.current,
        );
        this.currentPublication = pub;
      }
      if (this.current) {
        this.metadataHead = this.db
          .prepare("SELECT hash FROM heads WHERE domain='metadata'")
          .get()?.hash as string;
        this.credentialHead = this.db
          .prepare("SELECT hash FROM heads WHERE domain='credentials'")
          .get()?.hash as string;
        requireValue(
          syncHash(this.metadataHead) && syncHash(this.credentialHead),
        );
        for (const [domain, head, control] of [
          ["metadata", this.metadataHead, this.current.metadata],
          ["credentials", this.credentialHead, this.current.credentials],
        ] as const) {
          const stored = this.db
            .prepare(
              "SELECT publication FROM operations WHERE domain=? AND hash=?",
            )
            .get(domain, head);
          requireValue(stored);
          verifyTeamOperation(
            JSON.parse(stored.publication as string),
            control,
          );
        }
      }
      this.db.exec(
        "PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;DELETE FROM nonces;",
      );
      if (config.databasePath !== ":memory:")
        chmodSync(config.databasePath, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.server = createServer(
      { maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 },
      (req, res) => {
        void this.handle(req, res);
      },
    );
    this.server.maxRequestsPerSocket = 120;
    this.server.on("clientError", (_error, socket) =>
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      ),
    );
  }
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(
        this.config.port ?? 0,
        this.config.host ?? "127.0.0.1",
        () => {
          this.server.off("error", reject);
          resolve();
        },
      );
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Team listener unavailable");
    return `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.server.listening)
      await new Promise<void>((resolve, reject) => {
        this.server.close((e) => (e ? reject(e) : resolve()));
        this.server.closeIdleConnections();
      });
    this.db.close();
  }
  private rate(key: string): void {
    const now = this.now();
    for (const [id, e] of this.rates)
      if (e.start + (this.options.windowMs ?? 60000) <= now)
        this.rates.delete(id);
    requireValue(this.rates.has(key) || this.rates.size < 1024, "rate-limited");
    const entry = this.rates.get(key) ?? { start: now, count: 0 };
    this.rates.set(key, entry);
    requireValue(
      ++entry.count <= (this.options.requestLimit ?? 120),
      "rate-limited",
    );
  }
  private auth(req: IncomingMessage): Actor {
    const p = req.headers["x-ssterm-principal"],
      authorization = req.headers.authorization;
    requireValue(
      syncUuid(p) &&
        typeof authorization === "string" &&
        /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization),
      "unauthorized",
    );
    requireValue(
      req.headers["x-ssterm-deployment"] === this.config.scope.deploymentId &&
        req.headers["x-ssterm-account"] === this.config.scope.accountId &&
        req.headers["x-ssterm-team"] === this.config.scope.teamId,
      "unauthorized",
    );
    const token = authorization.slice(7);
    requireValue(syncBytes(token, 32, 32), "unauthorized");
    const principal = this.current?.policy.policy.body.principals.find(
      (x) => x.principalId === p && x.status === "active",
    );
    requireValue(
      principal || (!this.current && p === this.config.initialOwnerPrincipalId),
      "unauthorized",
    );
    const expected = principal?.tokenHash ?? this.config.initialOwnerTokenHash;
    requireValue(
      timingSafeEqual(
        Buffer.from(sha(decode(token)), "hex"),
        Buffer.from(expected, "hex"),
      ),
      "unauthorized",
    );
    this.rate(`principal:${p}`);
    return { principalId: p, deviceId: null, role: principal?.role ?? "Owner" };
  }
  private signed(
    req: IncomingMessage,
    path: string,
    body: Buffer,
    actor: Actor,
  ): Actor {
    const nonce = req.headers["x-ssterm-nonce"];
    requireValue(syncHash(nonce), "unauthorized");
    const n = this.db
      .prepare("DELETE FROM nonces WHERE nonce=? RETURNING principalId,expires")
      .get(nonce);
    requireValue(
      n &&
        n.principalId === actor.principalId &&
        Number(n.expires) > this.now(),
      "unauthorized",
    );
    const id = req.headers["x-ssterm-device"],
      sig = req.headers["x-ssterm-signature"];
    requireValue(syncUuid(id) && syncBytes(sig, 64, 64), "unauthorized");
    requireValue(
      this.current?.policy.policy.body.devices.some(
        (d) => d.deviceId === id && d.principalId === actor.principalId,
      ),
      "forbidden",
    );
    const cert = this.current!.metadata.certificates.find(
      (c) => c.deviceId === id,
    );
    requireValue(cert, "forbidden");
    requireValue(
      verify(
        null,
        teamRequestTranscript(
          req.method!,
          path,
          this.config.scope,
          actor.principalId,
          nonce,
          body,
          id,
        ),
        cert.signingKey,
        decode(sig),
      ),
      "unauthorized",
    );
    return { ...actor, deviceId: id };
  }
  private async body(req: IncomingMessage): Promise<Buffer> {
    const length = req.headers["content-length"];
    requireValue(
      !length || (/^\d+$/.test(length) && Number(length) <= SYNC_HTTP_MAX),
      "too-large",
    );
    const parts: Buffer[] = [];
    let total = 0;
    for await (const part of req) {
      total += part.length;
      requireValue(total <= SYNC_HTTP_MAX, "too-large");
      parts.push(Buffer.from(part));
    }
    return Buffer.concat(parts);
  }
  private json(b: Buffer): unknown {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(b),
      v: unknown = JSON.parse(raw);
    requireValue(JSON.stringify(v) === raw);
    return v;
  }
  private reply(res: ServerResponse, status: number, value: unknown): void {
    let wire = JSON.stringify(value);
    if (Buffer.byteLength(wire) > SYNC_HTTP_MAX) {
      status = 413;
      wire = JSON.stringify({ ok: false, code: "too-large" });
    }
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(wire),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(wire);
  }
  private transaction<V>(f: () => V): V {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = f();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private audit(
    actor: Actor | null,
    action: T.TeamAuditEntry["action"],
    outcome: "accepted" | "denied",
    extra: { recordId?: string; requestId?: string; policyHash?: string } = {},
  ): void {
    const entry = {
      time: this.now(),
      principalId: actor?.principalId ?? null,
      deviceId: actor?.deviceId ?? null,
      recordId: extra.recordId ?? null,
      policyHash: extra.policyHash ?? this.current?.policy.commitment ?? null,
      requestId: extra.requestId ?? null,
      action,
      outcome,
    };
    this.db
      .prepare("INSERT INTO audit(entry) VALUES(?)")
      .run(JSON.stringify(entry));
    this.db
      .prepare(
        "DELETE FROM audit WHERE sequence <= (SELECT coalesce(max(sequence),0) FROM audit)-?",
      )
      .run(Math.min(10000, this.options.auditLimit ?? 10000));
  }
  private currentSnapshot(domain: string): SyncOperationPublication {
    const head =
      domain === "metadata" ? this.metadataHead : this.credentialHead;
    const row = this.db
      .prepare("SELECT publication FROM operations WHERE domain=? AND hash=?")
      .get(domain, head);
    requireValue(row, "stale-control");
    return JSON.parse(row.publication as string);
  }
  private wrapsFor(
    domain: "metadata" | "credentials",
    deviceId: string,
  ): string[] {
    const pub =
      domain === "metadata"
        ? this.currentPublication!.metadata.control
        : this.currentPublication!.credentials.control;
    return pub.wraps.filter(
      (w) =>
        parseWrapHeader(unframe(decode(w), 3, 1024, 2048)[0])
          .recipientDeviceId === deviceId,
    );
  }
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let permitted = false,
      actor: Actor | null = null;
    const timer = setTimeout(() => {
      if (!res.headersSent)
        this.reply(res, 408, { ok: false, code: "unavailable" });
      req.destroy();
    }, 15000);
    timer.unref();
    try {
      this.rate(`ip:${req.socket.remoteAddress ?? ""}`);
      requireValue(!req.headers.origin, "forbidden");
      const path = req.url ?? "";
      requireValue(
        /^\/team\/v1\/[a-z]+(?:\/(?:0|[1-9][0-9]*))?$/.test(path) ||
          /^\/team\/v1\/operations\/(metadata|credentials)\/[0-9a-f]{64}$/.test(
            path,
          ),
        "unsupported",
      );
      if (req.method === "GET" && path === "/team/v1/info") {
        this.reply(res, 200, {
          ok: true,
          value: {
            protocol: "ssterm-team-v1",
            scope: this.config.scope,
            suite: SYNC_SUITE,
          },
        });
        return;
      }
      actor = this.auth(req);
      requireValue(this.bodies < 4, "rate-limited");
      this.bodies++;
      permitted = true;
      const body = await this.body(req);
      requireValue(req.method === "POST" || body.length === 0);
      if (req.method === "POST")
        requireValue(req.headers["content-type"] === "application/json");
      let value: unknown;
      if (req.method === "GET" && path === "/team/v1/challenge") {
        this.db.prepare("DELETE FROM nonces WHERE expires<=?").run(this.now());
        requireValue(
          Number(this.db.prepare("SELECT count(*) n FROM nonces").get()?.n) <
            (this.options.nonceLimit ?? 128),
          "rate-limited",
        );
        const nonce = randomBytes(32).toString("hex"),
          expiresAt = Math.floor(this.now() / 1000) + 60;
        this.db
          .prepare("INSERT INTO nonces VALUES(?,?,?)")
          .run(nonce, actor.principalId, expiresAt * 1000);
        value = { nonce, expiresAt };
      } else if (
        req.method === "GET" &&
        path.startsWith("/team/v1/policies/")
      ) {
        const after = Number(path.slice("/team/v1/policies/".length));
        requireValue(
          Number.isSafeInteger(after) && after >= 0 && after <= 0xffffffff,
        );
        const rows = this.db
          .prepare(
            "SELECT generation,publication FROM policies WHERE generation>? ORDER BY generation LIMIT 9",
          )
          .all(after);
        const cps: T.TeamPolicyCheckpoint[] = [];
        let nextGeneration = after;
        for (const row of rows.slice(0, 8)) {
          const cp = sanitize(
            checkpoint(JSON.parse(row.publication as string)),
          );
          if (
            Buffer.byteLength(JSON.stringify([...cps, cp])) >
            SYNC_HTTP_MAX - 1024
          )
            break;
          cps.push(cp);
          nextGeneration = Number(row.generation);
        }
        value = {
          checkpoints: cps,
          nextGeneration,
          hasMore: rows.length > cps.length,
        };
      } else if (req.method === "POST" && path === "/team/v1/publish") {
        requireValue(actor.role === "Owner", "forbidden");
        const v = this.json(body);
        requireValue(T.isTeamPublishRequest(v));
        value = this.publish(v, actor);
      } else if (req.method === "GET" && path === "/team/v1/recovery") {
        requireValue(
          actor.role === "Owner" && this.current && this.currentPublication,
          "forbidden",
        );
        let kit: T.TeamRecoveryKit | null = null;
        const md =
            this.currentPublication.metadata.control.recoveryDescriptorWire,
          cd =
            this.currentPublication.credentials.control.recoveryDescriptorWire;
        if (md && cd) {
          const mh = parseRecoveryDescriptor(decode(md)).recoveryEnvelopeHash,
            ch = parseRecoveryDescriptor(decode(cd)).recoveryEnvelopeHash;
          for (const row of this.db
            .prepare(
              "SELECT publication FROM policies ORDER BY generation DESC",
            )
            .iterate()) {
            const p = JSON.parse(
              row.publication as string,
            ) as T.TeamAtomicPublication;
            if (
              p.recovery &&
              sha(decode(p.recovery.metadataRecoveryWire)) === mh &&
              sha(decode(p.recovery.credentialRecoveryWire)) === ch
            ) {
              kit = p.recovery;
              break;
            }
          }
        }
        value = {
          kit,
          checkpoint: sanitize(checkpoint(this.currentPublication)),
          metadataHead: this.metadataHead,
          credentialHead: this.credentialHead,
          metadataSnapshot: this.currentSnapshot("metadata"),
          credentialSnapshot: this.currentSnapshot("credentials"),
        };
      } else {
        actor = this.signed(req, path, body, actor);
        requireValue(this.current && this.currentPublication, "stale-control");
        if (req.method === "POST" && path === "/team/v1/state") {
          const v = this.json(body);
          requireValue(T.isTeamStateRequest(v));
          value = {
            checkpoint: sanitize(checkpoint(this.currentPublication)),
            metadataHead: this.metadataHead,
            credentialHead: this.credentialHead,
            metadataSnapshot: this.currentSnapshot("metadata"),
            credentialSnapshot:
              actor.role === "Viewer"
                ? null
                : this.currentSnapshot("credentials"),
            metadataWraps: this.wrapsFor("metadata", actor.deviceId!),
            credentialWraps:
              actor.role === "Viewer"
                ? []
                : this.wrapsFor("credentials", actor.deviceId!),
          };
        } else if (
          req.method === "POST" &&
          ["/team/v1/metadata", "/team/v1/credentials"].includes(path)
        ) {
          const domain = path.endsWith("/metadata")
            ? "metadata"
            : "credentials";
          requireValue(
            domain === "metadata"
              ? T.teamCanEdit(actor.role)
              : actor.role === "Owner" &&
                  actor.deviceId ===
                    this.current.policy.policy.body.ownerDeviceId,
            "forbidden",
          );
          const v = this.json(body);
          requireValue(T.isTeamWriteRequest(v));
          value = this.write(domain, v, actor);
        } else if (
          req.method === "GET" &&
          path.startsWith("/team/v1/operations/")
        ) {
          const match =
            /^\/team\/v1\/operations\/(metadata|credentials)\/([0-9a-f]{64})$/.exec(
              path,
            );
          requireValue(match);
          requireValue(
            match[1] === "metadata" || actor.role !== "Viewer",
            "forbidden",
          );
          const row = this.db
            .prepare(
              "SELECT publication FROM operations WHERE domain=? AND hash=?",
            )
            .get(match[1], match[2]);
          requireValue(row, "stale-control");
          value = JSON.parse(row.publication as string);
        } else if (req.method === "POST" && path === "/team/v1/connect") {
          requireValue(T.teamCanConnect(actor.role), "forbidden");
          const v = this.json(body);
          requireValue(T.isTeamConnectRequest(v));
          requireValue(
            v.policyHash === this.current.policy.commitment &&
              v.metadataHash === this.metadataHead &&
              v.credentialHash === this.credentialHead,
            "stale-control",
          );
          value = { ...v, expiresAt: Math.floor(this.now() / 1000) + 15 };
          this.audit(actor, "connect-authorized", "accepted", v);
        } else if (req.method === "GET" && path.startsWith("/team/v1/audit/")) {
          requireValue(
            actor.role === "Owner" &&
              actor.deviceId === this.current.policy.policy.body.ownerDeviceId,
            "forbidden",
          );
          const after = Number(path.slice("/team/v1/audit/".length));
          requireValue(Number.isSafeInteger(after) && after >= 0);
          const rows = this.db
            .prepare(
              "SELECT sequence,entry FROM audit WHERE sequence>? ORDER BY sequence LIMIT 101",
            )
            .all(after);
          value = {
            entries: rows.slice(0, 100).map((r) => ({
              sequence: Number(r.sequence),
              ...JSON.parse(r.entry as string),
            })),
            firstAvailableSequence: Number(
              this.db
                .prepare("SELECT coalesce(min(sequence),1) n FROM audit")
                .get()?.n,
            ),
            nextSequence: rows.length
              ? Number(rows[Math.min(rows.length, 100) - 1].sequence)
              : after,
            hasMore: rows.length > 100,
          };
        } else if (req.method === "POST" && path === "/team/v1/events") {
          requireValue(T.teamCanConnect(actor.role), "forbidden");
          const v = this.json(body);
          requireValue(T.isTeamEventsRequest(v));
          value = this.transaction(() => {
            let accepted = 0;
            for (const e of v.events) {
              requireValue(
                e.policyHash === this.current!.policy.commitment,
                "stale-control",
              );
              const old = this.db
                .prepare(
                  "SELECT principalId,deviceId,event FROM events WHERE eventId=?",
                )
                .get(e.eventId);
              if (old) {
                requireValue(
                  old.principalId === actor!.principalId &&
                    old.deviceId === actor!.deviceId &&
                    old.event === JSON.stringify(e),
                  "conflict",
                );
                continue;
              }
              requireValue(
                Number(
                  this.db.prepare("SELECT count(*) n FROM events").get()?.n,
                ) < 10000,
                "too-large",
              );
              this.db
                .prepare("INSERT INTO events VALUES(?,?,?,?)")
                .run(
                  e.eventId,
                  actor!.principalId,
                  actor!.deviceId,
                  JSON.stringify(e),
                );
              this.audit(
                actor,
                `client-${e.action}` as T.TeamAuditEntry["action"],
                "accepted",
                e,
              );
              accepted++;
            }
            return { accepted };
          });
        } else throw new Rejection("unsupported");
      }
      this.reply(res, 200, { ok: true, value });
    } catch (error) {
      const code =
        error instanceof Rejection
          ? error.code
          : error instanceof SyntaxError ||
              error instanceof TypeError ||
              (error instanceof Error && error.name === "SyncCryptoError")
            ? "invalid"
            : "unavailable";
      if (code !== "rate-limited" && code !== "unavailable")
        try {
          this.audit(actor, "request-denied", "denied");
        } catch {}
      if (!res.headersSent)
        this.reply(
          res,
          code === "unauthorized"
            ? 401
            : code === "forbidden"
              ? 403
              : code === "conflict" || code === "stale-control"
                ? 409
                : code === "rate-limited"
                  ? 429
                  : code === "too-large"
                    ? 413
                    : code === "unavailable"
                      ? 503
                      : 400,
          { ok: false, code },
        );
    } finally {
      if (permitted) this.bodies--;
      clearTimeout(timer);
    }
  }
  private persistOperation(
    domain: "metadata" | "credentials",
    p: SyncOperationPublication,
    h: DataHeader,
    hash: string,
  ): void {
    const old = this.db
      .prepare("SELECT publication FROM operations WHERE domain=? AND hash=?")
      .get(domain, hash);
    if (old) {
      requireValue(old.publication === JSON.stringify(p), "conflict");
      return;
    }
    const stats = this.db
      .prepare(
        "SELECT count(*) n,coalesce(sum(length(publication)),0) bytes FROM operations WHERE domain=?",
      )
      .get(domain)!;
    requireValue(
      Number(stats.n) < 256 &&
        Number(stats.bytes) + Buffer.byteLength(JSON.stringify(p)) <=
          64 * 1024 * 1024,
      "too-large",
    );
    requireValue(
      !this.db
        .prepare(
          "SELECT 1 FROM operations WHERE domain=? AND (operationId=? OR (epoch=? AND salt=?))",
        )
        .get(domain, h.operationId, h.epoch, h.salt),
      "conflict",
    );
    this.db
      .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?)")
      .run(domain, hash, h.operationId, h.epoch, h.salt, JSON.stringify(p));
  }
  private validateRecovery(
    p: T.TeamAtomicPublication,
    next: AcceptedTeamCheckpoint,
  ): void {
    const kit = p.recovery;
    if (kit) {
      const base = this.db
        .prepare("SELECT publication FROM policies WHERE hash=?")
        .get(teamPolicyHash(kit.basePolicy));
      requireValue(base);
      const old = JSON.parse(
        base.publication as string,
      ) as T.TeamAtomicPublication;
      requireValue(
        JSON.stringify(old.policy) === JSON.stringify(kit.basePolicy),
      );
      for (const [wire, control, descriptor] of [
        [
          kit.metadataRecoveryWire,
          old.metadata.control,
          p.metadata.control.recoveryDescriptorWire,
        ],
        [
          kit.credentialRecoveryWire,
          old.credentials.control,
          p.credentials.control.recoveryDescriptorWire,
        ],
      ] as const) {
        requireValue(descriptor);
        const d = parseRecoveryDescriptor(decode(descriptor));
        requireValue(d.recoveryEnvelopeHash === sha(decode(wire)));
        const [raw, cipher] = unframe(decode(wire), 2, 128 * 1024, 128 * 1024),
          h = parseRecoveryHeader(raw);
        const accepted =
          control === old.metadata.control ? next.metadata : next.credentials;
        requireValue(
          h.deploymentId === accepted.control.deploymentId &&
            h.accountId === accepted.control.accountId &&
            h.vaultId === accepted.control.vaultId &&
            h.recoveryId === d.recoveryId &&
            h.controlHash ===
              (control === old.metadata.control
                ? kit.basePolicy.body.metadataControlHash
                : kit.basePolicy.body.credentialControlHash) &&
            cipher.length === h.plaintextLength + 16,
        );
      }
    }
    let pairedKit: T.TeamRecoveryKit | null = kit;
    const recovering =
      !!this.current &&
      next.policy.policy.body.ownerDeviceId !==
        this.current.policy.policy.body.ownerDeviceId;
    const metadataDescriptor = recovering
      ? this.currentPublication?.metadata.control.recoveryDescriptorWire
      : p.metadata.control.recoveryDescriptorWire;
    const credentialDescriptor = recovering
      ? this.currentPublication?.credentials.control.recoveryDescriptorWire
      : p.credentials.control.recoveryDescriptorWire;
    if (!pairedKit && metadataDescriptor && credentialDescriptor) {
      const mh = parseRecoveryDescriptor(
          decode(metadataDescriptor),
        ).recoveryEnvelopeHash,
        ch = parseRecoveryDescriptor(
          decode(credentialDescriptor),
        ).recoveryEnvelopeHash;
      for (const row of this.db
        .prepare("SELECT publication FROM policies ORDER BY generation DESC")
        .iterate()) {
        const old = JSON.parse(
          row.publication as string,
        ) as T.TeamAtomicPublication;
        if (
          old.recovery &&
          sha(decode(old.recovery.metadataRecoveryWire)) === mh &&
          sha(decode(old.recovery.credentialRecoveryWire)) === ch
        ) {
          pairedKit = old.recovery;
          break;
        }
      }
    }
    for (const [pub, wire] of [
      [p.metadata.control, pairedKit?.metadataRecoveryWire],
      [p.credentials.control, pairedKit?.credentialRecoveryWire],
    ] as const) {
      if (pub.recoveryDescriptorWire) {
        requireValue(wire);
        requireValue(
          parseRecoveryDescriptor(decode(pub.recoveryDescriptorWire))
            .recoveryEnvelopeHash === sha(decode(wire)),
        );
        requireValue(pub.recoveryWire === null || pub.recoveryWire === wire);
      } else requireValue(pub.recoveryWire === null);
    }
    if (
      this.current &&
      next.policy.policy.body.ownerDeviceId !==
        this.current.policy.policy.body.ownerDeviceId
    ) {
      requireValue(pairedKit && !kit); // Recovery admission must reference an already accepted kit.
      const oldMeta = this.current.metadata.certificates.map((c) => c.deviceId),
        oldCred = this.current.credentials.certificates.map((c) => c.deviceId);
      const freshMeta = next.metadata.certificates.filter(
          (c) => !oldMeta.includes(c.deviceId),
        ),
        freshCred = next.credentials.certificates.filter(
          (c) => !oldCred.includes(c.deviceId),
        );
      requireValue(
        freshMeta.length === 1 &&
          freshCred.length === 1 &&
          freshMeta[0].role === "owner" &&
          freshCred[0].role === "owner" &&
          freshMeta[0].enrollmentHash ===
            sha(decode(pairedKit.metadataRecoveryWire)) &&
          freshCred[0].enrollmentHash ===
            sha(decode(pairedKit.credentialRecoveryWire)),
      );
    }
  }
  private publish(request: T.TeamPublishRequest, actor: Actor): T.TeamReceipt {
    const p = request.publication,
      hash = teamPolicyHash(p.policy),
      existing = this.db
        .prepare("SELECT publication,receipt FROM policies WHERE hash=?")
        .get(hash);
    if (existing) {
      requireValue(existing.publication === JSON.stringify(p), "conflict");
      return JSON.parse(existing.receipt as string);
    }
    requireValue(
      request.expectedPolicyHash ===
        (this.current?.policy.commitment ?? null) &&
        request.expectedMetadataHash === this.metadataHead &&
        request.expectedCredentialHash === this.credentialHead,
      "conflict",
    );
    requireValue(
      p.policy.body.ownerPrincipalId === actor.principalId &&
        (this.current ||
          actor.principalId === this.config.initialOwnerPrincipalId),
      "forbidden",
    );
    if (!this.current)
      requireValue(
        p.policy.body.principals[0].principalId ===
          this.config.initialOwnerPrincipalId &&
          p.policy.body.principals[0].tokenHash ===
            this.config.initialOwnerTokenHash,
        "forbidden",
      );
    const next = acceptTeamCheckpoint(
      checkpoint(p),
      this.config.scope,
      teamOwnerKey(p.policy.body),
      this.current,
    );
    verifyTeamWraps(p.metadata.control, next.metadata);
    verifyTeamWraps(p.credentials.control, next.credentials);
    const metadata = verifyTeamOperation(p.metadata.snapshot, next.metadata),
      credentials = verifyTeamOperation(
        p.credentials.snapshot,
        next.credentials,
      );
    for (const [op, expected, header] of [
      [p.metadata.snapshot, this.metadataHead, metadata.header],
      [p.credentials.snapshot, this.credentialHead, credentials.header],
    ] as const)
      requireValue(
        header.authorDeviceId === p.policy.body.ownerDeviceId &&
          (expected
            ? op.parents.length === 1 && op.parents[0] === expected
            : op.parents.length === 0),
      );
    const stats = this.db
      .prepare(
        "SELECT count(*) n,coalesce(sum(length(publication)),0) bytes FROM policies",
      )
      .get()!;
    requireValue(
      Number(stats.n) < 256 &&
        Number(stats.bytes) + Buffer.byteLength(JSON.stringify(p)) <=
          64 * 1024 * 1024,
      "too-large",
    );
    for (const a of next.admissions) {
      requireValue(
        !this.db
          .prepare(
            "SELECT 1 FROM admissions WHERE requestId=? OR nonce=? OR hash=?",
          )
          .get(a.requestId, a.nonce, a.hash),
        "conflict",
      );
    }
    for (const proof of p.metadata.control.enrollmentProofs) {
      const e = parseEnrollmentBody(unframe(decode(proof), 4, 1536, 4096)[0]);
      requireValue(
        e.expiresAtUnix > Math.floor(this.now() / 1000) &&
          e.expiresAtUnix <= Math.floor(this.now() / 1000) + 300,
      );
    }
    this.validateRecovery(p, next);
    for (const d of p.policy.body.devices) {
      const c = next.metadata.certificates.find(
        (c) => c.deviceId === d.deviceId,
      )!;
      const old = this.db
        .prepare(
          "SELECT deviceId,principalId,signing,wrapping FROM bindings WHERE deviceId=? OR signing=? OR wrapping=?",
        )
        .all(d.deviceId, fingerprint(c.signingKey), fingerprint(c.wrappingKey));
      requireValue(
        old.every(
          (o) =>
            o.deviceId === d.deviceId &&
            o.principalId === d.principalId &&
            o.signing === fingerprint(c.signingKey) &&
            o.wrapping === fingerprint(c.wrappingKey),
        ),
      );
    }
    const receipt: T.TeamReceipt = {
      policyHash: hash,
      generation: p.policy.body.generation,
      metadataHash: metadata.hash,
      credentialHash: credentials.hash,
    };
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO policies VALUES(?,?,?,?)")
        .run(
          p.policy.body.generation,
          hash,
          JSON.stringify(p),
          JSON.stringify(receipt),
        );
      this.persistOperation(
        "metadata",
        p.metadata.snapshot,
        metadata.header,
        metadata.hash,
      );
      this.persistOperation(
        "credentials",
        p.credentials.snapshot,
        credentials.header,
        credentials.hash,
      );
      this.db
        .prepare(
          "INSERT INTO heads VALUES(?,?) ON CONFLICT(domain) DO UPDATE SET hash=excluded.hash",
        )
        .run("metadata", metadata.hash);
      this.db
        .prepare(
          "INSERT INTO heads VALUES(?,?) ON CONFLICT(domain) DO UPDATE SET hash=excluded.hash",
        )
        .run("credentials", credentials.hash);
      for (const a of next.admissions)
        this.db
          .prepare("INSERT INTO admissions VALUES(?,?,?)")
          .run(a.requestId, a.nonce, a.hash);
      for (const d of p.policy.body.devices) {
        const c = next.metadata.certificates.find(
          (c) => c.deviceId === d.deviceId,
        )!;
        this.db
          .prepare("INSERT OR IGNORE INTO bindings VALUES(?,?,?,?)")
          .run(
            d.deviceId,
            d.principalId,
            fingerprint(c.signingKey),
            fingerprint(c.wrappingKey),
          );
      }
      this.audit(
        { ...actor, deviceId: p.policy.body.ownerDeviceId },
        "policy-published",
        "accepted",
        { policyHash: hash },
      );
    });
    this.current = next;
    this.currentPublication = p;
    this.metadataHead = metadata.hash;
    this.credentialHead = credentials.hash;
    return receipt;
  }
  private write(
    domain: "metadata" | "credentials",
    v: T.TeamWriteRequest,
    actor: Actor,
  ): T.TeamWriteReceipt {
    requireValue(this.current, "stale-control");
    const control =
      domain === "metadata" ? this.current.metadata : this.current.credentials;
    requireValue(
      v.policyHash === this.current.policy.commitment,
      "stale-control",
    );
    const { hash, header } = verifyTeamOperation(v.operation, control);
    requireValue(header.authorDeviceId === actor.deviceId, "forbidden");
    const old = this.db
      .prepare("SELECT publication FROM operations WHERE domain=? AND hash=?")
      .get(domain, hash);
    if (old) {
      requireValue(old.publication === JSON.stringify(v.operation), "conflict");
      return { policyHash: v.policyHash, head: hash };
    }
    requireValue(
      v.expectedHead ===
        (domain === "metadata" ? this.metadataHead : this.credentialHead),
      "conflict",
    );
    requireValue(
      v.operation.parents.length === 1 &&
        v.operation.parents[0] === v.expectedHead,
    );
    this.transaction(() => {
      this.persistOperation(domain, v.operation, header, hash);
      this.db
        .prepare("UPDATE heads SET hash=? WHERE domain=?")
        .run(hash, domain);
      this.audit(
        actor,
        domain === "metadata" ? "metadata-written" : "credential-written",
        "accepted",
      );
    });
    if (domain === "metadata") this.metadataHead = hash;
    else this.credentialHead = hash;
    return { policyHash: v.policyHash, head: hash };
  }
}
