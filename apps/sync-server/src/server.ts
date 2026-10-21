/** Personal ciphertext store. Operators terminate remote TLS outside this loopback-first listener. */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  frame,
  unframe,
  fingerprint,
  parseDataHeader,
  parentsDigest,
  operationCommitment,
  parseWrapHeader,
  parseRecoveryHeader,
} from '../../../packages/adapters/src/sync-crypto.ts';
import {
  acceptControl,
  parseControlBody,
  parseEnrollmentBody,
  enrollmentHash,
  type AcceptedControl,
  type Certificate,
} from '../../../packages/adapters/src/sync-control.ts';
import {
  parseRecoveryDescriptor,
  recoveryDescriptorDigest,
} from '../../../packages/adapters/src/sync-recovery.ts';
import { syncRequestTranscript } from '../../../packages/adapters/src/sync-transport.ts';
import {
  SYNC_HTTP_MAX,
  SYNC_SUITE,
  SYNC_ZERO,
  isSyncScope,
  isSyncControlPublication,
  isSyncExchangeRequest,
  syncHash,
  syncBytes,
  syncUuid,
  type SyncScope,
  type SyncControlPublication,
  type SyncOperationPublication,
  type SyncOperationEntry,
  type SyncTransportCode,
} from '../../../packages/domain/src/sync.ts';
export interface SyncServerConfig extends SyncScope {
  databasePath: string;
  tokenHash: string;
  host?: string;
  port?: number;
}
export interface SyncServerOptions {
  now?: () => number;
  requestLimit?: number;
  windowMs?: number;
  nonceLimit?: number;
}
class Rejection extends Error {
  constructor(readonly code: SyncTransportCode) {
    super(code);
  }
}
function reject(condition: unknown, code: SyncTransportCode = 'invalid'): asserts condition {
  if (!condition) throw new Rejection(code);
}
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const decode = (s: string) => Buffer.from(s, 'base64url');
const sameScope = (a: SyncScope, b: SyncScope) =>
  a.deploymentId === b.deploymentId && a.accountId === b.accountId && a.vaultId === b.vaultId;
const APP_ID = 0x5353594e;
export class SyncServer {
  readonly server: Server;
  private readonly db: DatabaseSync;
  private current?: AcceptedControl;
  private readonly scope: SyncScope;
  private readonly now: () => number;
  private inFlightBodies = 0;
  private readonly rates = new Map<string, { start: number; count: number }>();
  constructor(
    readonly config: SyncServerConfig,
    private readonly options: SyncServerOptions = {},
  ) {
    this.scope = { deploymentId: config.deploymentId, accountId: config.accountId, vaultId: config.vaultId };
    if (!isSyncScope(this.scope) || !syncHash(config.tokenHash) || !config.databasePath)
      throw new Error('Invalid sync configuration');
    this.now = options.now ?? Date.now;
    if (config.databasePath !== ':memory:') {
      mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
    }
    const existed = existsSync(config.databasePath);
    if (config.databasePath !== ':memory:') {
      if (existed && !lstatSync(config.databasePath).isFile()) throw new Error('Invalid sync storage');
      if (!existed) writeFileSync(config.databasePath, '', { mode: 0o600, flag: 'wx' });
    }
    this.db = new DatabaseSync(config.databasePath);
    const app = this.db.prepare('PRAGMA application_id').get()?.application_id;
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    const tables = this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n;
    if ((app !== APP_ID || version !== 1) && (app !== 0 || version !== 0 || tables !== 0)) {
      this.db.close();
      throw new Error('Unsupported sync database');
    }
    if (!existed || tables === 0) {
      this.db.exec(`BEGIN; PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;
      CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope TEXT NOT NULL,tokenHash TEXT NOT NULL);
      CREATE TABLE controls (generation INTEGER PRIMARY KEY,hash TEXT UNIQUE NOT NULL,publication TEXT NOT NULL);
      CREATE TABLE operations (sequence INTEGER PRIMARY KEY AUTOINCREMENT,operationId TEXT UNIQUE NOT NULL,hash TEXT UNIQUE NOT NULL,epoch INTEGER NOT NULL,salt TEXT NOT NULL,publication TEXT NOT NULL,UNIQUE(epoch,salt));
      CREATE TABLE admissions (requestId TEXT PRIMARY KEY,nonce TEXT UNIQUE NOT NULL,hash TEXT UNIQUE NOT NULL);
      CREATE TABLE nonces (nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);
      COMMIT;`);
      this.db
        .prepare('INSERT INTO identity VALUES (1,?,?)')
        .run(JSON.stringify(this.scope), config.tokenHash);
    }
    const identity = this.db.prepare('SELECT scope,tokenHash FROM identity WHERE singleton=1').get();
    if (identity?.scope !== JSON.stringify(this.scope) || identity?.tokenHash !== config.tokenHash) {
      this.db.close();
      throw new Error('Foreign sync database');
    }
    if (config.databasePath !== ':memory:') chmodSync(config.databasePath, 0o600);
    // Validate durable authority before serving. Never trust serialized public-key objects.
    try {
      for (const row of this.db.prepare('SELECT publication FROM controls ORDER BY generation').iterate()) {
        const pub = JSON.parse(row.publication as string) as SyncControlPublication;
        reject(isSyncControlPublication(pub));
        const wire = decode(pub.controlWire);
        const control = parseControlBody(unframe(wire, 3, 1024, 2048)[0]);
        this.current = acceptControl(
          wire,
          decode(pub.rosterWire),
          this.scope,
          control.newOwnerKey,
          this.current,
        );
      }
    } catch {
      this.db.close();
      throw new Error('Invalid sync database');
    }
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; DELETE FROM nonces;',
    );
    this.server = createServer(
      { maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 },
      (req, res) => {
        void this.handle(req, res);
      },
    );
    this.server.maxRequestsPerSocket = 120;
    this.server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
  }
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port ?? 0, this.config.host ?? '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Sync listener unavailable');
    return `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
  }
  async close(): Promise<void> {
    if (!this.server.listening) {
      this.db.close();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeIdleConnections();
    });
    this.db.close();
  }
  private reply(res: ServerResponse, status: number, value: unknown): void {
    let body = JSON.stringify(value);
    if (Buffer.byteLength(body) > SYNC_HTTP_MAX) {
      status = 413;
      body = JSON.stringify({ ok: false, code: 'too-large' });
    }
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }
  private rate(key: string): void {
    const now = this.now();
    for (const [id, entry] of this.rates)
      if (entry.start + (this.options.windowMs ?? 60000) <= now) this.rates.delete(id);
    if (!this.rates.has(key) && this.rates.size >= 1024) throw new Rejection('rate-limited');
    const entry = this.rates.get(key) ?? { start: now, count: 0 };
    entry.count++;
    this.rates.set(key, entry);
    reject(entry.count <= (this.options.requestLimit ?? 120), 'rate-limited');
  }
  private auth(req: IncomingMessage): void {
    const token = req.headers.authorization;
    reject(typeof token === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(token), 'unauthorized');
    const raw = token.slice(7);
    reject(syncBytes(raw, 32, 32), 'unauthorized');
    const actual = Buffer.from(sha(decode(raw)), 'hex');
    const expected = Buffer.from(this.config.tokenHash, 'hex');
    reject(
      timingSafeEqual(actual, expected) &&
        req.headers['x-ssterm-deployment'] === this.scope.deploymentId &&
        req.headers['x-ssterm-account'] === this.scope.accountId &&
        req.headers['x-ssterm-vault'] === this.scope.vaultId,
      'unauthorized',
    );
  }
  private signed(req: IncomingMessage, path: string, body: Buffer): Certificate {
    const nonce = req.headers['x-ssterm-nonce'];
    reject(syncHash(nonce), 'unauthorized');
    const stored = this.db.prepare('DELETE FROM nonces WHERE nonce=? RETURNING expires').get(nonce);
    reject(stored && Number(stored.expires) > this.now(), 'unauthorized');
    const id = req.headers['x-ssterm-device'];
    const signature = req.headers['x-ssterm-signature'];
    reject(syncUuid(id) && syncBytes(signature, 64, 64), 'unauthorized');
    const cert = this.current?.certificates.find((c) => c.deviceId === id);
    reject(cert, 'forbidden');
    reject(
      verify(
        null,
        syncRequestTranscript(req.method!, path, this.scope, nonce, body),
        cert.signingKey,
        decode(signature),
      ),
      'unauthorized',
    );
    return cert;
  }
  private async body(req: IncomingMessage): Promise<Buffer> {
    const length = req.headers['content-length'];
    reject(!length || (/^\d+$/.test(length) && Number(length) <= SYNC_HTTP_MAX), 'too-large');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      reject(size <= SYNC_HTTP_MAX, 'too-large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  }
  private json(body: Buffer): unknown {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const parsed: unknown = JSON.parse(raw);
    reject(JSON.stringify(parsed) === raw);
    return parsed;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let bodyPermit = false;
    const timer = setTimeout(() => {
      this.reply(res, 408, { ok: false, code: 'unavailable' });
      req.destroy();
    }, 15000);
    timer.unref();
    try {
      this.rate(`ip:${req.socket.remoteAddress ?? ''}`);
      reject(!req.headers.origin, 'forbidden');
      const path = req.url ?? '';
      reject(/^\/v1\/[a-z]+(?:\/(?:0|[1-9][0-9]*))?$/.test(path), 'unsupported');
      if (req.method === 'GET' && path === '/v1/info') {
        this.reply(res, 200, {
          ok: true,
          value: { ...this.scope, protocol: 'ssterm-sync-v1', suite: SYNC_SUITE },
        });
        return;
      }
      this.auth(req);
      this.rate('account');
      // Bound simultaneous body buffers independently of the per-minute budget.
      reject(this.inFlightBodies < 4, 'rate-limited');
      this.inFlightBodies++;
      bodyPermit = true;
      const body = await this.body(req);
      reject(req.method === 'POST' || body.length === 0);
      let value: unknown;
      if (req.method === 'GET' && path === '/v1/challenge') {
        this.db.prepare('DELETE FROM nonces WHERE expires<=?').run(this.now());
        reject(
          Number(this.db.prepare('SELECT count(*) AS n FROM nonces').get()?.n) <
            (this.options.nonceLimit ?? 128),
          'rate-limited',
        );
        const nonce = randomBytes(32).toString('hex');
        const expiresAt = Math.floor(this.now() / 1000) + 60;
        this.db.prepare('INSERT INTO nonces VALUES (?,?)').run(nonce, expiresAt * 1000);
        value = { nonce, expiresAt };
      } else if (req.method === 'POST' && path === '/v1/controls') {
        reject(req.headers['content-type'] === 'application/json');
        const parsed = this.json(body);
        reject(isSyncControlPublication(parsed));
        value = this.publishControl(parsed);
      } else if (req.method === 'GET' && path.startsWith('/v1/controls/')) {
        const after = Number(path.slice('/v1/controls/'.length));
        reject(Number.isSafeInteger(after) && after >= 0 && after <= 0xffffffff);
        const rows = this.db
          .prepare(
            'SELECT generation,publication FROM controls WHERE generation>? ORDER BY generation LIMIT 9',
          )
          .all(after);
        const controls: SyncControlPublication[] = [];
        let nextGeneration = after;
        for (const row of rows.slice(0, 8)) {
          const p = JSON.parse(row.publication as string) as SyncControlPublication;
          p.wraps = [];
          p.recoveryWire = null;
          if (
            Buffer.byteLength(
              JSON.stringify({
                controls: [...controls, p],
                nextGeneration: Number(row.generation),
                hasMore: true,
              }),
            ) +
              64 >
            SYNC_HTTP_MAX
          )
            break;
          controls.push(p);
          nextGeneration = Number(row.generation);
        }
        value = { controls, nextGeneration, hasMore: rows.length > controls.length };
      } else if (req.method === 'POST' && path === '/v1/exchange') {
        const cert = this.signed(req, path, body);
        reject(req.headers['content-type'] === 'application/json');
        const parsed = this.json(body);
        reject(isSyncExchangeRequest(parsed));
        reject(cert.role !== 'reader' || parsed.operations.length === 0, 'forbidden');
        value = this.exchange(parsed.afterSequence, parsed.operations, cert);
      } else if (req.method === 'GET' && path.startsWith('/v1/wraps/')) {
        const cert = this.signed(req, path, body);
        const epoch = Number(path.slice('/v1/wraps/'.length));
        reject(
          Number.isSafeInteger(epoch) && epoch >= 1 && epoch <= (this.current?.control.activeEpoch ?? 0),
        );
        const wraps = new Map<string, string>();
        for (const row of this.db
          .prepare('SELECT publication FROM controls ORDER BY generation DESC')
          .iterate()) {
          const p = JSON.parse(row.publication as string) as SyncControlPublication;
          for (const wrap of p.wraps) {
            const h = parseWrapHeader(unframe(decode(wrap), 3, 1024, 2048)[0]);
            if (
              h.epoch === epoch &&
              h.recipientDeviceId === cert.deviceId &&
              h.recipientFingerprint === fingerprint(cert.wrappingKey)
            )
              wraps.set(h.controlHash, wrap);
          }
          if (wraps.size) break;
        }
        value = { wraps: [...wraps.values()] };
      } else if (req.method === 'GET' && path === '/v1/recovery') {
        let publication: SyncControlPublication | null = null;
        const wanted = this.current?.control.recoveryDescriptorDigest;
        if (wanted && wanted !== SYNC_ZERO)
          for (const row of this.db
            .prepare('SELECT publication FROM controls ORDER BY generation DESC')
            .iterate()) {
            const p = JSON.parse(row.publication as string) as SyncControlPublication;
            if (
              p.recoveryDescriptorWire &&
              p.recoveryWire &&
              recoveryDescriptorDigest(decode(p.recoveryDescriptorWire)) === wanted
            ) {
              p.wraps = [];
              publication = p;
              break;
            }
          }
        value = { publication };
      } else throw new Rejection('unsupported');
      this.reply(res, 200, { ok: true, value });
    } catch (error) {
      if (!res.headersSent) {
        const code =
          error instanceof Rejection
            ? error.code
            : error instanceof SyntaxError ||
                error instanceof TypeError ||
                (error instanceof Error && error.name === 'SyncCryptoError')
              ? 'invalid'
              : 'unavailable';
        const status =
          code === 'unauthorized'
            ? 401
            : code === 'forbidden'
              ? 403
              : code === 'conflict' || code === 'stale-control'
                ? 409
                : code === 'rate-limited'
                  ? 429
                  : code === 'too-large'
                    ? 413
                    : code === 'unavailable'
                      ? 503
                      : 400;
        this.reply(res, status, { ok: false, code });
      }
    } finally {
      if (bodyPermit) this.inFlightBodies--;
      clearTimeout(timer);
    }
  }
  private publishControl(p: SyncControlPublication): { controlHash: string; generation: number } {
    const wire = decode(p.controlWire);
    const c = parseControlBody(unframe(wire, 3, 1024, 2048)[0]);
    const existing = this.db
      .prepare('SELECT hash,publication FROM controls WHERE generation=?')
      .get(c.generation);
    if (existing) {
      reject(existing.publication === JSON.stringify(p), 'conflict');
      return { controlHash: existing.hash as string, generation: c.generation };
    }
    reject(c.generation === (this.current?.control.generation ?? 0) + 1, 'stale-control');
    const next = acceptControl(wire, decode(p.rosterWire), this.scope, c.newOwnerKey, this.current);
    const owner = next.certificates.find((x) => x.role === 'owner')!;
    const wrapKeys = new Set<string>();
    for (const encoded of p.wraps) {
      const [header, ciphertext, sig] = unframe(decode(encoded), 3, 1024, 2048);
      const h = parseWrapHeader(header);
      const recipient = next.certificates.find((x) => x.deviceId === h.recipientDeviceId);
      reject(recipient);
      reject(
        sameScope(h, this.scope) &&
          h.epoch <= c.activeEpoch &&
          h.controlHash === next.commitment &&
          h.issuerDeviceId === owner.deviceId &&
          h.issuerFingerprint === fingerprint(owner.signingKey) &&
          h.recipientFingerprint === fingerprint(recipient.wrappingKey),
      );
      reject(
        ciphertext.length === 384 &&
          sig.length === 64 &&
          verify(null, frame('ssterm-sync-wrap-sign-v1', header, ciphertext), owner.signingKey, sig),
      );
      const key = `${h.epoch}/${h.recipientDeviceId}`;
      reject(!wrapKeys.has(key));
      wrapKeys.add(key);
    }
    reject(next.certificates.every((cert) => wrapKeys.has(`${c.activeEpoch}/${cert.deviceId}`)));
    const admissions: Array<{ requestId: string; nonce: string; hash: string }> = [];
    const newCerts = next.certificates.filter(
      (cert) =>
        !this.current?.certificates.some(
          (old) =>
            old.deviceId === cert.deviceId &&
            fingerprint(old.signingKey) === fingerprint(cert.signingKey) &&
            fingerprint(old.wrappingKey) === fingerprint(cert.wrappingKey),
        ) && c.generation !== 1,
    );
    // Owner-loss recovery cannot obtain a live-owner enrollment challenge. The old
    // authority still signs this exact new authority/roster, and the new owner-device
    // proves signing-key possession through every wrap. Bind its admission to an
    // already published descriptor-bound kit rather than permitting general bypass.
    let recoveryAdmission = false;
    if (
      this.current &&
      newCerts.length === 1 &&
      newCerts[0].role === 'owner' &&
      p.enrollmentProofs.length === 0 &&
      c.ownerDeviceId !== this.current.control.ownerDeviceId &&
      fingerprint(c.newOwnerKey) !== fingerprint(this.current.control.newOwnerKey) &&
      c.activeEpoch === this.current.control.activeEpoch + 1 &&
      !next.certificates.some((cert) => cert.deviceId === this.current!.control.ownerDeviceId)
    ) {
      for (const row of this.db
        .prepare('SELECT publication FROM controls ORDER BY generation DESC')
        .iterate()) {
        const old = JSON.parse(row.publication as string) as SyncControlPublication;
        if (old.recoveryWire && old.recoveryDescriptorWire) {
          const descriptor = parseRecoveryDescriptor(decode(old.recoveryDescriptorWire));
          if (
            sameScope(descriptor, this.scope) &&
            descriptor.recoveryEnvelopeHash === newCerts[0].enrollmentHash &&
            sha(decode(old.recoveryWire)) === descriptor.recoveryEnvelopeHash
          ) {
            recoveryAdmission = true;
            break;
          }
        }
      }
    }
    reject(recoveryAdmission || p.enrollmentProofs.length === newCerts.length);
    for (const proof of p.enrollmentProofs) {
      const [body, challenge, proofHash, sig] = unframe(decode(proof), 4, 1536, 4096);
      const enrollment = parseEnrollmentBody(body);
      const hash = enrollmentHash(body, challenge);
      const cert = newCerts.find((x) => x.deviceId === enrollment.newDeviceId && x.enrollmentHash === hash);
      reject(cert);
      reject(
        sameScope(enrollment, this.scope) &&
          enrollment.baseControlHash === this.current?.commitment &&
          enrollment.issuerOwnerFingerprint === fingerprint(this.current.control.newOwnerKey),
      );
      reject(
        enrollment.expiresAtUnix > Math.floor(this.now() / 1000) &&
          enrollment.expiresAtUnix <= Math.floor(this.now() / 1000) + 300,
      );
      reject(
        fingerprint(enrollment.signingKey) === fingerprint(cert.signingKey) &&
          fingerprint(enrollment.wrappingKey) === fingerprint(cert.wrappingKey) &&
          enrollment.requestedRole === cert.role,
      );
      reject(
        challenge.length === 384 &&
          syncHash(proofHash.toString('ascii')) &&
          sig.length === 64 &&
          verify(
            null,
            frame('ssterm-sync-enroll-sign-proof-v1', body, challenge, proofHash),
            cert.signingKey,
            sig,
          ),
      );
      reject(
        !admissions.some(
          (x) => x.hash === hash || x.requestId === enrollment.requestId || x.nonce === enrollment.nonce,
        ),
      );
      reject(
        !this.db
          .prepare('SELECT 1 FROM admissions WHERE requestId=? OR nonce=? OR hash=?')
          .get(enrollment.requestId, enrollment.nonce, hash),
        'conflict',
      );
      admissions.push({ requestId: enrollment.requestId, nonce: enrollment.nonce, hash });
    }
    if (c.recoveryDescriptorDigest === SYNC_ZERO)
      reject(p.recoveryDescriptorWire === null && p.recoveryWire === null);
    else {
      reject(p.recoveryDescriptorWire !== null);
      const descriptor = decode(p.recoveryDescriptorWire);
      reject(recoveryDescriptorDigest(descriptor) === c.recoveryDescriptorDigest);
      const d = parseRecoveryDescriptor(descriptor);
      reject(sameScope(d, this.scope));
      if (p.recoveryWire) {
        const recovery = decode(p.recoveryWire);
        reject(sha(recovery) === d.recoveryEnvelopeHash);
        const [header, ciphertext] = unframe(recovery, 2);
        const h = parseRecoveryHeader(header);
        reject(
          sameScope(h, this.scope) &&
            h.recoveryId === d.recoveryId &&
            ciphertext.length === h.plaintextLength + 16,
        );
        reject(this.db.prepare('SELECT 1 FROM controls WHERE hash=?').get(h.controlHash));
      } else {
        reject(this.current?.control.recoveryDescriptorDigest === c.recoveryDescriptorDigest);
        let retainedKit = false;
        for (const row of this.db.prepare('SELECT publication FROM controls').iterate()) {
          const old = JSON.parse(row.publication as string) as SyncControlPublication;
          if (old.recoveryWire && old.recoveryDescriptorWire === p.recoveryDescriptorWire) {
            retainedKit = true;
            break;
          }
        }
        reject(retainedKit);
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO controls VALUES (?,?,?)')
        .run(c.generation, next.commitment, JSON.stringify(p));
      for (const a of admissions)
        this.db.prepare('INSERT INTO admissions VALUES (?,?,?)').run(a.requestId, a.nonce, a.hash);
      this.db.exec('COMMIT');
      this.current = next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { controlHash: next.commitment, generation: c.generation };
  }
  private exchange(
    afterSequence: number,
    operations: SyncOperationPublication[],
    requester: Certificate,
  ): { operations: SyncOperationEntry[]; nextSequence: number; hasMore: boolean } {
    reject(this.current, 'stale-control');
    const ceiling = Number(this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM operations').get()?.n);
    reject(afterSequence <= ceiling);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of operations) {
        const wire = decode(p.wire);
        const [header, ciphertext, sig] = unframe(wire, 3, 1048576 + 16, 1048576 + 2048);
        const h = parseDataHeader(header);
        const hash = operationCommitment(wire);
        reject(sameScope(h, this.scope));
        const old = this.db
          .prepare('SELECT hash,publication FROM operations WHERE operationId=?')
          .get(h.operationId);
        if (old) {
          reject(old.hash === hash && old.publication === JSON.stringify(p), 'conflict');
          continue;
        }
        reject(h.authorDeviceId === requester.deviceId, 'forbidden');
        reject(
          h.controlHash === this.current.commitment && h.epoch === this.current.control.activeEpoch,
          'stale-control',
        );
        reject(
          h.parentsDigest === parentsDigest(p.parents) &&
            ciphertext.length === h.plaintextLength + 16 &&
            sig.length === 64 &&
            verify(null, frame('ssterm-sync-data-sign-v1', header, ciphertext), requester.signingKey, sig),
        );
        reject(
          !this.db.prepare('SELECT 1 FROM operations WHERE epoch=? AND salt=?').get(h.epoch, h.salt),
          'conflict',
        );
        reject(
          p.parents.every((parent) => this.db.prepare('SELECT 1 FROM operations WHERE hash=?').get(parent)),
          'conflict',
        );
        reject(
          Number(this.db.prepare('SELECT count(*) AS n FROM operations WHERE epoch=?').get(h.epoch)?.n) <
            0xffffffff,
          'conflict',
        );
        this.db
          .prepare('INSERT INTO operations (operationId,hash,epoch,salt,publication) VALUES (?,?,?,?,?)')
          .run(h.operationId, hash, h.epoch, h.salt, JSON.stringify(p));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const rows = this.db
      .prepare('SELECT sequence,publication FROM operations WHERE sequence>? ORDER BY sequence LIMIT 9')
      .all(afterSequence);
    const result: SyncOperationEntry[] = [];
    let nextSequence = afterSequence;
    for (const row of rows.slice(0, 8)) {
      const p = {
        ...(JSON.parse(row.publication as string) as SyncOperationPublication),
        sequence: Number(row.sequence),
      };
      if (
        Buffer.byteLength(
          JSON.stringify({ operations: [...result, p], nextSequence: p.sequence, hasMore: true }),
        ) +
          64 >
        SYNC_HTTP_MAX
      )
        break;
      result.push(p);
      nextSequence = p.sequence;
    }
    return { operations: result, nextSequence, hasMore: rows.length > result.length };
  }
}
