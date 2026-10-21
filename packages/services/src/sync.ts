/** Personal sync orchestration. All plaintext/key work stays main-side and all network writes are explicit. */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import type { MetadataRepository } from "@ssterm/domain";
import {
  isSyncScope,
  SYNC_ZERO,
  type SyncScope,
  type SyncControlPublication,
  type SyncOperationPublication,
  type SyncTransportResult,
} from "../../domain/src/sync.ts";
import {
  createSyncTransport,
  validSyncEndpoint,
  type SyncTransport,
  type SyncTransportOptions,
} from "../../adapters/src/sync-transport.ts";
import {
  SyncRepository,
  SyncRepositoryFault,
  type SyncStoredOperation,
} from "../../adapters/src/sync-repository.ts";
import type { SyncKeyStore } from "../../adapters/src/sync-keychain.ts";
import {
  fingerprint,
  freshEntropy,
  generateDeviceKeys,
  generateEpochKey,
  generateRecoverySecret,
  generateSigningKey,
  openOperation,
  operationCommitment,
  parentsDigest,
  parseDataHeader,
  parseRecoveryHeader,
  parseWrapHeader,
  sealOperation,
  sealRecovery,
  openRecovery,
  unframe,
  unwrapEpoch,
  wrapEpoch,
} from "../../adapters/src/sync-crypto.ts";
import {
  acceptControl,
  operationDisposition,
  acceptRecoveryControl,
  challengeEnrollment as challengeCrypto,
  controlCommitment,
  enrollmentBody,
  enrollmentHash,
  parseEnrollmentBody,
  proveEnrollment as proveCrypto,
  readCertificate,
  rosterBytes,
  rosterCommitment,
  rosterEntries,
  sealCertificate,
  sealControl,
  verifyEnrollment,
  type AcceptedControl,
  type Certificate,
  type Enrollment,
  type EnrollmentApproval,
} from "../../adapters/src/sync-control.ts";
import {
  decodeRecoveryPayload,
  encodeRecoveryPayload,
  recoveryDescriptor,
  recoveryDescriptorDigest,
} from "../../adapters/src/sync-recovery.ts";
import {
  emptySyncSnapshot,
  encodeSyncSnapshot,
  exportSyncSnapshot,
  mergeSyncSnapshots,
  parseSyncSnapshot,
  prepareSyncCatalogImport,
  syncCanonical,
  syncDigest,
  syncGraphConflicts,
  syncRecordPreview,
  type SyncConflict,
  type SyncResolution,
  type SyncSnapshot,
  type SyncSnippetSeam,
  type SyncTombstone,
} from "./sync-catalog.ts";

export type SyncResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string };
export interface SyncState {
  needsToken: boolean;
  canCancelSetup: boolean;
  status:
    | "disabled"
    | "pending"
    | "enrolled"
    | "revoked"
    | "locked"
    | "key-unavailable"
    | "reconcile";
  endpoint: string | null;
  scope: SyncScope | null;
  deviceId: string | null;
  role: "owner" | "writer" | "reader" | null;
  generation: number;
  epoch: number;
  ownerFingerprint: string | null;
  recoveryReady: boolean;
  outbox: number;
  inbox: number;
  conflicts: number;
  devices: {
    deviceId: string;
    role: "owner" | "writer" | "reader";
    fingerprint: string;
  }[];
  warnings: string[];
}
export interface SyncReview {
  reviewToken: string;
  expiresAt: number;
  records: number;
  deletions: number;
  conflicts: SyncConflict[];
  warnings: string[];
}
export type { SyncResolution };
interface Configuration {
  endpoint: string;
  scope: SyncScope;
  deviceId: string;
  ownerSpki: string;
  expectedOwnerFingerprint: string;
  phase: "preparing" | "joining" | "enrolled";
  refs: Record<string, string>;
  repositoryIdentity: string;
  anchor?: { publication: SyncControlPublication; previousOwnerSpki: string };
}
interface Context {
  config: Configuration;
  accepted: AcceptedControl;
  signing: KeyObject;
  wrapping: KeyObject;
  owner: KeyObject | null;
  epochs: Map<number, Buffer>;
}
interface ReviewPlan {
  expiresAt: number;
  generation: number;
  catalogRevision: number;
  controlHash: string;
  sourceHashes: string[];
  staleKeys: string[];
  localDigest: string;
  base: SyncSnapshot;
  local: SyncSnapshot;
  remote: SyncSnapshot;
  warnings: string[];
}
interface RecoveryDraft {
  token: string;
  expiresAt: number;
  secret: Buffer;
  kit: Buffer;
  descriptor: Buffer;
  controlHash: string;
}
class SyncFault {
  constructor(readonly code: string) {}
}
const fail = (code: string): never => {
  throw new SyncFault(code);
};
function check(value: unknown, code = "invalid"): asserts value {
  if (!value) fail(code);
}
const bytes = (v: string) => Buffer.from(v, "base64url");
const b64 = (v: Uint8Array) => Buffer.from(v).toString("base64url");
const spki = (k: KeyObject) =>
  b64(
    (k.type === "public" ? k : createPublicKey(k)).export({
      format: "der",
      type: "spki",
    }),
  );
const publicKey = (v: string) =>
  createPublicKey({ key: bytes(v), format: "der", type: "spki" });
const privateKey = (v: Uint8Array) =>
  createPrivateKey({ key: Buffer.from(v), format: "der", type: "pkcs8" });
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function textObject(text: string, max = 16384): Record<string, unknown> {
  check(typeof text === "string" && Buffer.byteLength(text) <= max);
  const obj: unknown = JSON.parse(text);
  check(
    !!obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      syncCanonical(obj) === text,
  );
  return obj as Record<string, unknown>;
}
function strictKeys(obj: Record<string, unknown>, keys: string[]): void {
  check(
    Object.keys(obj).length === keys.length &&
      keys.every((k) => Object.hasOwn(obj, k)),
  );
}
export class SyncClient {
  #locked = false;
  #generation = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #abort = new AbortController();
  #reviews = new Map<string, ReviewPlan>();
  #reviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #approvals = new Map<
    string,
    { approval: EnrollmentApproval; body: Buffer; challenge: Buffer }
  >();
  #recovery: RecoveryDraft | null = null;
  #recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  #statusFault: SyncState["status"] | null = null;
  readonly #now: () => number;
  readonly #monotonic: () => number;
  constructor(
    private readonly options: {
      repository: SyncRepository;
      catalog: MetadataRepository;
      keyStore: SyncKeyStore;
      secrets: SyncSnippetSeam;
      transportFactory?: (options: SyncTransportOptions) => SyncTransport;
      now?: () => number;
      monotonicNow?: () => number;
    },
  ) {
    this.#now = options.now ?? Date.now;
    this.#monotonic = options.monotonicNow ?? (() => performance.now() / 1000);
  }
  #config(): Configuration | null {
    return this.options.repository.get<Configuration>("configuration");
  }
  #guard(g: number): void {
    check(!this.#locked && g === this.#generation, "fenced");
  }
  async #wait<T>(promise: Promise<T>, g: number): Promise<T> {
    const value = await promise;
    if (this.#locked || g !== this.#generation) {
      if (value instanceof Uint8Array) value.fill(0);
      else if (
        value &&
        typeof value === "object" &&
        "value" in value &&
        (value as { value?: unknown }).value instanceof Uint8Array
      )
        (value as { value: Uint8Array }).value.fill(0);
      fail("fenced");
    }
    return value;
  }
  #run<T>(run: (g: number) => Promise<T>): Promise<SyncResult<T>> {
    if (this.#pending >= 8) return Promise.resolve({ ok: false, code: "busy" });
    this.#pending++;
    const g = this.#generation;
    const result = this.#tail.then(async () => {
      try {
        this.#guard(g);
        const value = await run(g);
        this.#guard(g);
        return { ok: true as const, value };
      } catch (error) {
        const code =
          error instanceof SyncFault || error instanceof SyncRepositoryFault
            ? error.code
            : "invalid";
        if (code === "key-unavailable") this.#statusFault = "key-unavailable";
        return { ok: false as const, code };
      }
    });
    const settled = result.finally(() => {
      this.#pending--;
    });
    this.#tail = settled.then(() => undefined);
    return settled;
  }
  #account(c: Configuration, kind: string, ref: string): string {
    return `sync/v1/${c.scope.deploymentId}/${c.scope.accountId}/${c.scope.vaultId}/${c.deviceId}/${kind}/${ref}`;
  }
  async #put(
    c: Configuration,
    slot: string,
    kind: string,
    value: Uint8Array,
    g: number,
  ): Promise<void> {
    // Reserve exact immutable ref before touching Keychain; ambiguous writes are reconciled by exact lookup.
    const ref = c.refs[slot] ?? randomUUID();
    c.refs[slot] = ref;
    this.options.repository.set("configuration", c);
    this.options.repository.set(`provider/${ref}`, {
      state: "staged",
      slot,
      kind,
      digest: sha(value),
      account: this.#account(c, kind, ref),
    });
    await this.#wait(
      this.options.keyStore.write(this.#account(c, kind, ref), value),
      g,
    );
    const observed = await this.#wait(
      this.options.keyStore.read(this.#account(c, kind, ref)),
      g,
    );
    try {
      check(
        observed.status === "present" &&
          observed.value &&
          observed.value.length === value.length &&
          timingSafeEqual(observed.value, value),
        "key-unavailable",
      );
    } finally {
      observed.value?.fill(0);
    }
    this.options.repository.set(`provider/${ref}`, {
      state: "confirmed",
      slot,
      kind,
      digest: sha(value),
      account: this.#account(c, kind, ref),
    });
  }
  async #get(
    c: Configuration,
    slot: string,
    kind: string,
    g: number,
  ): Promise<Buffer> {
    const ref = c.refs[slot];
    check(ref, "key-unavailable");
    const read = await this.#wait(
      this.options.keyStore.read(this.#account(c, kind, ref)),
      g,
    );
    check(read.status === "present" && read.value, "key-unavailable");
    const v = Buffer.from(read.value);
    read.value.fill(0);
    const journal = this.options.repository.get<{
      state: string;
      digest: string;
    }>(`provider/${ref}`);
    if (!journal || sha(v) !== journal.digest) {
      v.fill(0);
      return fail("key-unavailable");
    }
    if (journal.state === "staged")
      this.options.repository.set(`provider/${ref}`, {
        ...journal,
        state: "confirmed",
      });
    return v;
  }
  async #storeKey(
    c: Configuration,
    slot: string,
    kind: string,
    key: KeyObject,
    g: number,
  ): Promise<void> {
    const raw = key.export({ format: "der", type: "pkcs8" });
    try {
      await this.#put(c, slot, kind, raw, g);
    } finally {
      raw.fill(0);
    }
  }
  #accepted(c: Configuration): AcceptedControl | null {
    let current: AcceptedControl | undefined;
    const controls = this.options.repository.controls();
    for (const row of controls) {
      const p = row.publication as SyncControlPublication;
      if (!current && c.anchor) {
        check(
          row.hash ===
            controlCommitment(bytes(c.anchor.publication.controlWire)),
          "untrusted-authority",
        );
        current = acceptRecoveryControl(
          bytes(p.controlWire),
          bytes(p.rosterWire),
          c.scope,
          publicKey(c.anchor.previousOwnerSpki),
          c.expectedOwnerFingerprint,
        );
      } else
        current = acceptControl(
          bytes(p.controlWire),
          bytes(p.rosterWire),
          c.scope,
          publicKey(c.ownerSpki),
          current,
        );
      check(current.commitment === row.hash, "untrusted-authority");
    }
    return current ?? null;
  }
  #transport(c: Configuration, g: number): SyncTransport {
    return (this.options.transportFactory ?? createSyncTransport)({
      endpoint: { url: c.endpoint, scope: c.scope },
      readToken: () => this.#get(c, "token", "transport-token", g),
      signRequest: async (transcript) => {
        const raw = await this.#get(c, "signing", "device-signing", g);
        try {
          this.#guard(g);
          return {
            deviceId: c.deviceId,
            signature: sign(null, transcript, privateKey(raw)),
          };
        } finally {
          raw.fill(0);
        }
      },
    });
  }
  async #checkpoint(
    c: Configuration,
    g: number,
  ): Promise<{
    repositoryIdentity: string;
    generation: number;
    hash: string;
  } | null> {
    const read = await this.#wait(
      this.options.keyStore.read(this.#account(c, "checkpoint", c.deviceId)),
      g,
    );
    if (read.status === "missing") return null;
    check(read.status === "present" && read.value, "key-unavailable");
    try {
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(read.value),
      ) as { repositoryIdentity: string; generation: number; hash: string };
      check(
        parsed.repositoryIdentity === c.repositoryIdentity &&
          Number.isSafeInteger(parsed.generation) &&
          parsed.generation >= 1 &&
          /^[0-9a-f]{64}$/.test(parsed.hash),
        "untrusted-authority",
      );
      return parsed;
    } finally {
      read.value.fill(0);
    }
  }
  async #pin(c: Configuration, a: AcceptedControl, g: number): Promise<void> {
    const old = await this.#checkpoint(c, g);
    if (old && old.generation >= a.control.generation) {
      if (old.generation === a.control.generation)
        check(old.hash === a.commitment, "untrusted-authority");
      return;
    }
    const value = Buffer.from(
      JSON.stringify({
        repositoryIdentity: c.repositoryIdentity,
        generation: a.control.generation,
        hash: a.commitment,
      }),
    );
    try {
      await this.#wait(
        this.options.keyStore.write(
          this.#account(c, "checkpoint", c.deviceId),
          value,
        ),
        g,
      );
      const observed = await this.#checkpoint(c, g);
      check(
        observed &&
          observed.generation === a.control.generation &&
          observed.hash === a.commitment,
        "key-unavailable",
      );
    } finally {
      value.fill(0);
    }
  }
  async #checkPin(
    c: Configuration,
    a: AcceptedControl,
    g: number,
  ): Promise<void> {
    const pin = await this.#checkpoint(c, g);
    check(pin, "key-unavailable");
    check(
      pin.generation === a.control.generation && pin.hash === a.commitment,
      "stale-control",
    );
  }
  #unwrap<T>(result: SyncTransportResult<T>): T {
    if (!result.ok) return fail(result.code);
    return result.value;
  }
  async #context(g: number, allowPending = false): Promise<Context> {
    const c = this.#config();
    check(c && (allowPending || c.phase === "enrolled"), "unavailable");
    check(
      c.repositoryIdentity === this.options.repository.identity(),
      "untrusted-authority",
    );
    const accepted = this.#accepted(c);
    check(accepted, "untrusted-authority");
    await this.#checkPin(c, accepted, g);
    const signing = await this.#private(c, "signing", "device-signing", g);
    const wrapping = await this.#private(c, "wrapping", "device-wrapping", g);
    const owner = c.refs.owner
      ? await this.#private(c, "owner", "owner-signing", g)
      : null;
    const epochs = new Map<number, Buffer>();
    try {
      for (const slot of Object.keys(c.refs).filter((s) =>
        s.startsWith("epoch/"),
      )) {
        const epoch = Number(slot.slice(6));
        const raw = await this.#get(c, slot, "epoch", g);
        if (raw.length !== 32) {
          raw.fill(0);
          fail("key-unavailable");
        }
        epochs.set(epoch, raw);
      }
      this.#statusFault = null;
      return { config: c, accepted, signing, wrapping, owner, epochs };
    } catch (error) {
      for (const key of epochs.values()) key.fill(0);
      throw error;
    }
  }

  async #private(
    c: Configuration,
    slot: string,
    kind: string,
    g: number,
  ): Promise<KeyObject> {
    const bytes = await this.#get(c, slot, kind, g);
    try {
      return privateKey(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  #clear(ctx: Context): void {
    for (const key of ctx.epochs.values()) key.fill(0);
  }
  state(): SyncState {
    const c = this.#config();
    let a: AcceptedControl | null = null;
    try {
      if (c) a = this.#accepted(c);
    } catch {
      this.#statusFault = "reconcile";
    }
    const ops = this.options.repository.operations();
    return {
      status: this.#locked
        ? "locked"
        : c?.phase === "enrolled" &&
            a &&
            !a.certificates.some((cert) => cert.deviceId === c.deviceId)
          ? "revoked"
          : (this.#statusFault ??
            (!c
              ? "disabled"
              : c.phase === "enrolled"
                ? "enrolled"
                : "pending")),
      endpoint: c?.endpoint ?? null,
      scope: c?.scope ?? null,
      deviceId: c?.deviceId ?? null,
      role:
        a?.certificates.find((r) => r.deviceId === c?.deviceId)?.role ?? null,
      generation: a?.control.generation ?? 0,
      epoch: a?.control.activeEpoch ?? 0,
      ownerFingerprint: a
        ? fingerprint(a.control.newOwnerKey)
        : c?.expectedOwnerFingerprint || null,
      needsToken: !!c && !c.refs.token,
      canCancelSetup:
        c?.phase === "preparing" &&
        this.options.repository.controls().length === 0 &&
        !this.options.repository.get("pendingControl"),
      recoveryReady: !!this.options.repository.get("recoveryReady"),
      outbox: ops.filter(
        (o) => o.direction === "out" && o.verdict === "pending",
      ).length,
      inbox: ops.filter((o) => o.direction === "in" && o.verdict === "pending")
        .length,
      conflicts: ops.filter((o) => o.verdict === "conflict").length,
      devices:
        a?.certificates.map((r) => ({
          deviceId: r.deviceId,
          role: r.role,
          fingerprint: fingerprint(r.signingKey),
        })) ?? [],
      warnings: this.options.repository.get<string[]>("warnings") ?? [],
    };
  }
  async #setup(
    input: { endpoint: string; token: string; expectedScope: SyncScope },
    g: number,
  ): Promise<Configuration> {
    check(!this.#config(), "conflict");
    check(
      isSyncScope(input.expectedScope) &&
        validSyncEndpoint({ url: input.endpoint, scope: input.expectedScope }),
    );
    check(
      typeof input.token === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(input.token) &&
        b64(bytes(input.token)) === input.token,
    );
    const c: Configuration = {
      endpoint: input.endpoint,
      scope: structuredClone(input.expectedScope),
      deviceId: randomUUID(),
      ownerSpki: "",
      expectedOwnerFingerprint: "",
      phase: "preparing",
      refs: {},
      repositoryIdentity: this.options.repository.identity(),
    };
    this.options.repository.set("configuration", c);
    const token = bytes(input.token);
    try {
      await this.#put(c, "token", "transport-token", token, g);
    } finally {
      token.fill(0);
    }
    const info = this.#unwrap(
      await this.#wait(this.#transport(c, g).info(this.#abort.signal), g),
    );
    check(
      isSyncScope(input.expectedScope) &&
        info.deploymentId === c.scope.deploymentId &&
        info.accountId === c.scope.accountId &&
        info.vaultId === c.scope.vaultId,
      "untrusted-authority",
    );
    const keys = await this.#wait(generateDeviceKeys(), g);
    await this.#storeKey(c, "signing", "device-signing", keys.signingKey, g);
    await this.#storeKey(c, "wrapping", "device-wrapping", keys.wrappingKey, g);
    return c;
  }
  #publication(
    ctx: Context,
    certificates: Certificate[],
    owner: KeyObject,
    epoch: number,
    proofs: string[] = [],
    recovery: { descriptor: string; wire: string } | null = null,
  ): SyncControlPublication {
    const scope = ctx.config.scope;
    const generation = ctx.accepted.control.generation + 1;
    const fp = fingerprint(owner);
    const roster = rosterBytes(
      certificates
        .map((cert) =>
          sealCertificate({ ...cert, ownerFingerprint: fp }, owner),
        )
        .sort((a, b) =>
          readCertificate(a, owner).deviceId.localeCompare(
            readCertificate(b, owner).deviceId,
          ),
        ),
    );
    const control = sealControl(
      {
        ...scope,
        generation,
        previousHash: ctx.accepted.commitment,
        previousOwnerFingerprint: fingerprint(ctx.accepted.control.newOwnerKey),
        newOwnerKey: owner,
        ownerDeviceId: certificates.find((c) => c.role === "owner")!.deviceId,
        activeEpoch: epoch,
        rosterDigest: rosterCommitment(roster),
        recoveryDescriptorDigest: recovery
          ? recoveryDescriptorDigest(bytes(recovery.descriptor))
          : SYNC_ZERO,
      },
      ctx.owner!,
      owner,
    );
    const controlHash = controlCommitment(control);
    const issuer = certificates.find((c) => c.role === "owner")!;
    const issuerKey =
      issuer.deviceId === ctx.config.deviceId ? ctx.signing : null;
    check(issuerKey, "untrusted-authority");
    const wraps: string[] = [];
    for (const cert of certificates)
      for (const [n, key] of ctx.epochs) {
        wraps.push(
          b64(
            wrapEpoch(
              {
                ...scope,
                epoch: n,
                recipientDeviceId: cert.deviceId,
                recipientFingerprint: fingerprint(cert.wrappingKey),
                issuerDeviceId: issuer.deviceId,
                issuerFingerprint: fingerprint(issuer.signingKey),
                controlHash,
              },
              key,
              cert.wrappingKey,
              issuerKey,
            ),
          ),
        );
      }
    check(wraps.length <= 256, "too-large");
    return {
      controlWire: b64(control),
      rosterWire: b64(roster),
      wraps,
      recoveryDescriptorWire: recovery?.descriptor ?? null,
      recoveryWire: recovery?.wire ?? null,
      enrollmentProofs: proofs,
    };
  }
  async #publishControl(
    c: Configuration,
    publication: SyncControlPublication,
    g: number,
  ): Promise<void> {
    const hash = controlCommitment(bytes(publication.controlWire));
    this.options.repository.set("pendingControl", { hash, publication });
    this.#guard(g);
    const receipt = this.#unwrap(
      await this.#wait(
        this.#transport(c, g).publishControl(publication, this.#abort.signal),
        g,
      ),
    );
    check(receipt.controlHash === hash, "untrusted-authority");
    const current = this.#accepted(c);
    const verified =
      current?.commitment === hash
        ? current
        : acceptControl(
            bytes(publication.controlWire),
            bytes(publication.rosterWire),
            c.scope,
            publicKey(c.ownerSpki),
            current ?? undefined,
          );
    check(
      receipt.generation === verified.control.generation,
      "untrusted-authority",
    );
    await this.#pin(c, verified, g);
    this.options.repository.transaction(() => {
      this.options.repository.addControl({
        hash,
        generation: receipt.generation,
        publication,
      });
      this.options.repository.remove("pendingControl");
      this.options.repository.set("recoveryReady", false);
    });
  }
  create(input: {
    endpoint: string;
    token: string;
    expectedScope: SyncScope;
    deviceLabel?: string;
  }): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      const c = await this.#setup(input, g);
      const owner = generateSigningKey();
      c.ownerSpki = spki(owner);
      c.expectedOwnerFingerprint = fingerprint(owner);
      await this.#storeKey(c, "owner", "owner-signing", owner, g);
      const epoch = generateEpochKey();
      try {
        await this.#put(c, "epoch/1", "epoch", epoch, g);
      } finally {
        epoch.fill(0);
      }
      const sig = await this.#get(c, "signing", "device-signing", g),
        wrap = await this.#get(c, "wrapping", "device-wrapping", g);
      try {
        const signing = privateKey(sig),
          wrapping = privateKey(wrap);
        const cert: Certificate = {
          ...c.scope,
          deviceId: c.deviceId,
          signingKey: createPublicKey(signing),
          wrappingKey: createPublicKey(wrapping),
          role: "owner",
          enrollmentHash: SYNC_ZERO,
          ownerFingerprint: c.expectedOwnerFingerprint,
          firstGeneration: 1,
        };
        const roster = rosterBytes([sealCertificate(cert, owner)]);
        const control = sealControl(
          {
            ...c.scope,
            generation: 1,
            previousHash: SYNC_ZERO,
            previousOwnerFingerprint: c.expectedOwnerFingerprint,
            newOwnerKey: owner,
            ownerDeviceId: c.deviceId,
            activeEpoch: 1,
            rosterDigest: rosterCommitment(roster),
            recoveryDescriptorDigest: SYNC_ZERO,
          },
          owner,
          owner,
        );
        const hash = controlCommitment(control);
        const ek = await this.#get(c, "epoch/1", "epoch", g);
        let w: Buffer;
        try {
          w = wrapEpoch(
            {
              ...c.scope,
              epoch: 1,
              recipientDeviceId: c.deviceId,
              recipientFingerprint: fingerprint(wrapping),
              issuerDeviceId: c.deviceId,
              issuerFingerprint: fingerprint(signing),
              controlHash: hash,
            },
            ek,
            wrapping,
            signing,
          );
        } finally {
          ek.fill(0);
        }
        const publication: SyncControlPublication = {
          controlWire: b64(control),
          rosterWire: b64(roster),
          wraps: [b64(w)],
          recoveryDescriptorWire: null,
          recoveryWire: null,
          enrollmentProofs: [],
        };
        acceptControl(control, roster, c.scope, owner);
        await this.#publishControl(c, publication, g);
        c.phase = "enrolled";
        this.options.repository.set("configuration", c);
        return this.state();
      } finally {
        sig.fill(0);
        wrap.fill(0);
      }
    });
  }
  beginJoin(input: {
    endpoint: string;
    token: string;
    expectedScope: SyncScope;
    expectedOwnerFingerprint: string;
    role: "writer" | "reader" | "owner";
  }): Promise<SyncResult<{ candidateText: string }>> {
    return this.#run(async (g) => {
      check(input.role === "writer" || input.role === "reader");
      check(/^[0-9a-f]{64}$/.test(input.expectedOwnerFingerprint));
      const c = await this.#setup(input, g);
      c.phase = "joining";
      c.expectedOwnerFingerprint = input.expectedOwnerFingerprint;
      this.options.repository.set("configuration", c);
      await this.#syncControls(c, g);
      const a = this.#accepted(c);
      check(a, "untrusted-authority");
      const raw = await this.#get(c, "signing", "device-signing", g),
        wrap = await this.#get(c, "wrapping", "device-wrapping", g);
      try {
        const candidateText = syncCanonical({
          format: "ssterm-sync-candidate-v1",
          scope: c.scope,
          newDeviceId: c.deviceId,
          signingSpki: spki(privateKey(raw)),
          wrappingSpki: spki(privateKey(wrap)),
          requestedRole: input.role,
        });
        return { candidateText };
      } finally {
        raw.fill(0);
        wrap.fill(0);
      }
    });
  }
  challengeEnrollment(input: { candidateText: string }): Promise<
    SyncResult<{
      challengeText: string;
      requestId: string;
      fingerprint: string;
      expiresAt: number;
    }>
  > {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        check(
          ctx.owner &&
            ctx.accepted.control.ownerDeviceId === ctx.config.deviceId,
          "forbidden",
        );
        const candidate = textObject(input.candidateText);
        strictKeys(candidate, [
          "format",
          "scope",
          "newDeviceId",
          "signingSpki",
          "wrappingSpki",
          "requestedRole",
        ]);
        check(
          candidate.format === "ssterm-sync-candidate-v1" &&
            syncCanonical(candidate.scope) === syncCanonical(ctx.config.scope),
        );
        check(
          candidate.requestedRole === "writer" ||
            candidate.requestedRole === "reader",
        );
        check(
          typeof candidate.newDeviceId === "string" &&
            typeof candidate.signingSpki === "string" &&
            typeof candidate.wrappingSpki === "string",
        );
        check(this.#approvals.size < 16, "busy");
        const request: Enrollment = {
          ...ctx.config.scope,
          requestId: randomUUID(),
          newDeviceId: candidate.newDeviceId,
          signingKey: publicKey(candidate.signingSpki),
          wrappingKey: publicKey(candidate.wrappingSpki),
          requestedRole: candidate.requestedRole,
          issuerOwnerFingerprint: fingerprint(ctx.owner),
          baseControlHash: ctx.accepted.commitment,
          nonce: randomBytes(32).toString("hex"),
          expiresAtUnix: Math.floor(this.#now() / 1000) + 300,
        };
        const body = enrollmentBody(request);
        const secret = randomBytes(32);
        const challenge = challengeCrypto(request, secret);
        const fp = enrollmentHash(body, challenge);
        this.options.repository.markEnrollment(request.requestId, "pending");
        this.options.repository.markEnrollment(request.nonce, "pending");
        this.#approvals.set(request.requestId, {
          body,
          challenge,
          approval: {
            enrollmentHash: fp,
            challengeSecret: secret,
            nowUnix: Math.floor(this.#now() / 1000),
            monotonicNow: this.#monotonic(),
            monotonicDeadline: this.#monotonic() + 300,
            used: false,
          },
        });
        const approvalTimer = setTimeout(() => {
          const pending = this.#approvals.get(request.requestId);
          pending?.approval.challengeSecret.fill(0);
          this.#approvals.delete(request.requestId);
          this.#approvalTimers.delete(request.requestId);
          this.options.repository.markEnrollment(
            request.requestId,
            "cancelled",
          );
          this.options.repository.markEnrollment(request.nonce, "cancelled");
        }, 5 * 60_000);
        approvalTimer.unref();
        this.#approvalTimers.set(request.requestId, approvalTimer);
        return {
          challengeText: syncCanonical({
            format: "ssterm-sync-challenge-v1",
            body: b64(body),
            challenge: b64(challenge),
          }),
          requestId: request.requestId,
          fingerprint: fp,
          expiresAt: request.expiresAtUnix * 1000,
        };
      } finally {
        this.#clear(ctx);
      }
    });
  }
  proveEnrollment(input: {
    challengeText: string;
  }): Promise<SyncResult<{ proofText: string; fingerprint: string }>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g, true);
      try {
        check(ctx.config.phase === "joining", "conflict");
        const raw = textObject(input.challengeText);
        strictKeys(raw, ["format", "body", "challenge"]);
        check(
          raw.format === "ssterm-sync-challenge-v1" &&
            typeof raw.body === "string" &&
            typeof raw.challenge === "string",
        );
        const body = bytes(raw.body),
          challenge = bytes(raw.challenge),
          e = parseEnrollmentBody(body);
        check(
          syncCanonical({
            deploymentId: e.deploymentId,
            accountId: e.accountId,
            vaultId: e.vaultId,
          }) === syncCanonical(ctx.config.scope) &&
            e.newDeviceId === ctx.config.deviceId &&
            fingerprint(e.signingKey) === fingerprint(ctx.signing) &&
            fingerprint(e.wrappingKey) === fingerprint(ctx.wrapping),
          "untrusted-authority",
        );
        check(
          e.issuerOwnerFingerprint ===
            fingerprint(ctx.accepted.control.newOwnerKey) &&
            e.baseControlHash === ctx.accepted.commitment,
          "stale-control",
        );
        check(
          e.expiresAtUnix > Math.floor(this.#now() / 1000) &&
            e.expiresAtUnix <= Math.floor(this.#now() / 1000) + 300,
        );
        const wire = proveCrypto(body, challenge, ctx.signing, ctx.wrapping);
        return {
          proofText: syncCanonical({
            format: "ssterm-sync-proof-v1",
            wire: b64(wire),
          }),
          fingerprint: enrollmentHash(body, challenge),
        };
      } finally {
        this.#clear(ctx);
      }
    });
  }
  approveEnrollment(input: {
    proofText: string;
    confirmedFingerprint: string;
  }): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        check(
          ctx.owner &&
            ctx.accepted.control.ownerDeviceId === ctx.config.deviceId,
          "forbidden",
        );
        const raw = textObject(input.proofText);
        strictKeys(raw, ["format", "wire"]);
        check(
          raw.format === "ssterm-sync-proof-v1" && typeof raw.wire === "string",
        );
        const wire = bytes(raw.wire);
        const [body] = unframe(wire, 4, 1536, 4096);
        const request = parseEnrollmentBody(body);
        const pending = this.#approvals.get(request.requestId);
        check(
          pending &&
            this.options.repository.enrollment(request.requestId) ===
              "pending" &&
            this.options.repository.enrollment(request.nonce) === "pending",
          "invalid",
        );
        check(
          input.confirmedFingerprint === pending.approval.enrollmentHash,
          "untrusted-authority",
        );
        const e = verifyEnrollment(wire, ctx.accepted, {
          ...pending.approval,
          nowUnix: Math.floor(this.#now() / 1000),
          monotonicNow: this.#monotonic(),
        });
        // Consume the ID and nonce before any asynchronous publication; restart never restores challenge secrets.
        this.options.repository.transaction(() => {
          this.options.repository.markEnrollment(e.requestId, "used");
          this.options.repository.markEnrollment(e.nonce, "used");
        });
        pending.approval.used = true;
        pending.approval.challengeSecret.fill(0);
        this.#approvals.delete(e.requestId);
        const timer = this.#approvalTimers.get(e.requestId);
        if (timer) clearTimeout(timer);
        this.#approvalTimers.delete(e.requestId);
        const cert: Certificate = {
          ...ctx.config.scope,
          deviceId: e.newDeviceId,
          signingKey: e.signingKey,
          wrappingKey: e.wrappingKey,
          role: e.requestedRole,
          enrollmentHash: pending.approval.enrollmentHash,
          ownerFingerprint: fingerprint(ctx.owner),
          firstGeneration: ctx.accepted.control.generation + 1,
        };
        const publication = this.#publication(
          ctx,
          [...ctx.accepted.certificates, cert],
          ctx.owner,
          ctx.accepted.control.activeEpoch,
          [b64(wire)],
        );
        await this.#publishControl(ctx.config, publication, g);
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  async #syncControls(c: Configuration, g: number): Promise<void> {
    const transport = this.#transport(c, g);
    let accepted = this.#accepted(c);
    let generation = accepted?.control.generation ?? 0;
    for (let pages = 0; pages < 512; pages++) {
      const response = this.#unwrap(
        await this.#wait(transport.controls(generation, this.#abort.signal), g),
      );
      if (!response.controls.length) {
        check(
          !response.hasMore && response.nextGeneration === generation,
          "stale-control",
        );
        if (accepted) await this.#checkPin(c, accepted, g);
        return;
      }
      for (const publication of response.controls) {
        const wire = bytes(publication.controlWire),
          roster = bytes(publication.rosterWire);
        if (!accepted) {
          const [body] = unframe(wire, 3, 1024, 2048);
          const controlFields = unframe(body, 14, 1024, 1024);
          const owner = createPublicKey({
            key: controlFields[9],
            format: "der",
            type: "spki",
          });
          check(
            fingerprint(owner) === c.expectedOwnerFingerprint,
            "untrusted-authority",
          );
          c.ownerSpki = spki(owner);
          this.options.repository.set("configuration", c);
          accepted = acceptControl(wire, roster, c.scope, owner);
        } else
          accepted = acceptControl(
            wire,
            roster,
            c.scope,
            publicKey(c.ownerSpki),
            accepted,
          );
        await this.#pin(c, accepted, g);
        this.#guard(g);
        this.options.repository.addControl({
          hash: accepted.commitment,
          generation: accepted.control.generation,
          publication,
        });
        generation = accepted.control.generation;
        this.options.repository.set("recoveryReady", false);
      }
      check(response.nextGeneration === generation, "invalid");
      if (!response.hasMore) {
        if (accepted) await this.#checkPin(c, accepted, g);
        return;
      }
    }
    fail("too-large");
  }
  async #resumePublication(c: Configuration, g: number): Promise<void> {
    const pending = this.options.repository.get<{
      hash: string;
      publication: SyncControlPublication;
    }>("pendingControl");
    if (!pending) return;
    await this.#publishControl(c, pending.publication, g);
    if (c.phase === "preparing") {
      c.phase = "enrolled";
      this.options.repository.set("configuration", c);
    }
  }
  async #fetchEpochs(ctx: Context, g: number): Promise<void> {
    const cert = ctx.accepted.certificates.find(
      (c) => c.deviceId === ctx.config.deviceId,
    );
    check(
      cert &&
        fingerprint(cert.signingKey) === fingerprint(ctx.signing) &&
        fingerprint(cert.wrappingKey) === fingerprint(ctx.wrapping),
      "forbidden",
    );
    for (let epoch = 1; epoch <= ctx.accepted.control.activeEpoch; epoch++) {
      if (ctx.epochs.has(epoch)) continue;
      const response = this.#unwrap(
        await this.#wait(
          this.#transport(ctx.config, g).wraps(epoch, this.#abort.signal),
          g,
        ),
      );
      let loaded = false;
      for (const encoded of response.wraps) {
        const wire = bytes(encoded),
          [header] = unframe(wire, 3, 1024, 2048);
        const h = parseWrapHeader(header);
        if (h.recipientDeviceId !== ctx.config.deviceId || h.epoch !== epoch)
          continue;
        const referenced = this.#acceptedAt(h.controlHash, ctx.config);
        const issuer = referenced.certificates.find(
          (c) => c.deviceId === h.issuerDeviceId && c.role === "owner",
        );
        check(
          issuer && h.issuerDeviceId === referenced.control.ownerDeviceId,
          "untrusted-authority",
        );
        const key = unwrapEpoch(wire, h, ctx.wrapping, issuer.signingKey);
        try {
          await this.#put(ctx.config, `epoch/${epoch}`, "epoch", key, g);
          ctx.epochs.set(epoch, Buffer.from(key));
          loaded = true;
        } finally {
          key.fill(0);
        }
        break;
      }
      check(loaded, "key-unavailable");
    }
  }
  #acceptedAt(hash: string, c: Configuration): AcceptedControl {
    let previous: AcceptedControl | undefined;
    for (const row of this.options.repository.controls()) {
      const p = row.publication as SyncControlPublication;
      if (!previous && c.anchor)
        previous = acceptRecoveryControl(
          bytes(p.controlWire),
          bytes(p.rosterWire),
          c.scope,
          publicKey(c.anchor.previousOwnerSpki),
          c.expectedOwnerFingerprint,
        );
      else
        previous = acceptControl(
          bytes(p.controlWire),
          bytes(p.rosterWire),
          c.scope,
          publicKey(c.ownerSpki),
          previous,
        );
      if (row.hash === hash) return previous;
    }
    return fail("untrusted-authority");
  }
  finishJoin(): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      const c = this.#config();
      check(c && c.phase === "joining", "conflict");
      await this.#syncControls(c, g);
      const ctx = await this.#context(g, true);
      try {
        await this.#fetchEpochs(ctx, g);
        c.refs = ctx.config.refs;
        c.phase = "enrolled";
        this.options.repository.set("configuration", c);
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  #ingest(
    operations: { wire: string; parents: string[]; sequence: number }[],
    ctx: Context,
  ): void {
    const c = ctx.config;
    for (const op of operations) {
      const wire = bytes(op.wire),
        [rawHeader] = unframe(wire, 3, 1024 * 1024 + 16, 1024 * 1024 + 2048);
      const header = parseDataHeader(rawHeader);
      const checkpoint = this.#acceptedAt(header.controlHash, c);
      check(
        header.deploymentId === c.scope.deploymentId &&
          header.accountId === c.scope.accountId &&
          header.vaultId === c.scope.vaultId &&
          header.epoch === checkpoint.control.activeEpoch,
        "untrusted-authority",
      );
      const signer = checkpoint.certificates.find(
        (cert) =>
          cert.deviceId === header.authorDeviceId && cert.role !== "reader",
      );
      check(signer, "untrusted-authority");
      check(header.parentsDigest === parentsDigest(op.parents));
      const hash = operationCommitment(wire);
      const epochKey = ctx.epochs.get(header.epoch);
      check(epochKey, "key-unavailable");
      const opened = openOperation(
        wire,
        header,
        op.parents,
        epochKey,
        signer.signingKey,
      );
      try {
        parseSyncSnapshot(opened);
      } finally {
        opened.fill(0);
      }
      this.options.repository.addOperation({
        hash,
        operationId: header.operationId,
        epoch: header.epoch,
        salt: header.salt,
        wire: op.wire,
        parents: op.parents,
        sequence: op.sequence,
        direction: "in",
        verdict:
          operationDisposition(header, ctx.accepted) === "materialize"
            ? "pending"
            : "conflict",
      });
      const current = this.options.repository
        .operations()
        .find((o) => o.hash === hash)!;
      this.options.repository.updateOperation(hash, {
        sequence: op.sequence,
        ...(current.direction === "out"
          ? { verdict: "accepted" as const }
          : {}),
      });
    }
  }
  async #fetchOperations(
    ctx: Context,
    g: number,
    operations: SyncOperationPublication[] = [],
  ): Promise<void> {
    let cursor = this.options.repository.get<number>("cursor") ?? 0;
    for (let pages = 0; pages < 2048; pages++) {
      const response = this.#unwrap(
        await this.#wait(
          this.#transport(ctx.config, g).exchange(
            {
              afterSequence: cursor,
              operations: pages === 0 ? operations : [],
            },
            this.#abort.signal,
          ),
          g,
        ),
      );
      check(response.nextSequence >= cursor, "stale-control");
      this.#guard(g);
      this.options.repository.transaction(() => {
        this.#ingest(response.operations, ctx);
        this.options.repository.set("cursor", response.nextSequence);
      });
      cursor = response.nextSequence;
      if (!response.hasMore) return;
    }
    fail("too-large");
  }
  fetch(): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      const c = this.#config();
      check(c, "unavailable");
      await this.#resumePublication(c, g);
      await this.#syncControls(c, g);
      if (
        c.phase === "preparing" &&
        this.#accepted(c)?.certificates.some(
          (cert) => cert.deviceId === c.deviceId && cert.role === "owner",
        ) &&
        c.refs.signing &&
        c.refs.wrapping &&
        c.refs.owner
      ) {
        c.phase = "enrolled";
        this.options.repository.set("configuration", c);
      }
      const ctx = await this.#context(g);
      try {
        await this.#fetchEpochs(ctx, g);
        await this.#fetchOperations(ctx, g);
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  #snapshotOperation(row: SyncStoredOperation, ctx: Context): SyncSnapshot {
    const wire = bytes(row.wire),
      [raw] = unframe(wire, 3, 1024 * 1024 + 16, 1024 * 1024 + 2048),
      header = parseDataHeader(raw);
    const checkpoint = this.#acceptedAt(header.controlHash, ctx.config);
    check(
      header.epoch === checkpoint.control.activeEpoch,
      "untrusted-authority",
    );
    const cert = checkpoint.certificates.find(
      (c) => c.deviceId === header.authorDeviceId && c.role !== "reader",
    );
    check(cert, "untrusted-authority");
    const epoch = ctx.epochs.get(header.epoch);
    check(epoch, "key-unavailable");
    const plaintext = openOperation(
      wire,
      header,
      row.parents,
      epoch,
      cert.signingKey,
    );
    try {
      return parseSyncSnapshot(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }
  #tombstones(): SyncTombstone[] {
    return this.options.repository.get<SyncTombstone[]>("tombstones") ?? [];
  }
  #heads(): string[] {
    return this.options.repository.get<string[]>("materializedHeads") ?? [];
  }
  #ancestors(hash: string, ops: SyncStoredOperation[]): Set<string> {
    const seen = new Set<string>();
    const visit = (h: string) => {
      if (seen.has(h)) return;
      const row = ops.find((o) => o.hash === h);
      check(row, "conflict");
      seen.add(h);
      for (const p of row.parents) visit(p);
    };
    visit(hash);
    return seen;
  }
  async #reconcileMaterialization(g: number): Promise<void> {
    const journal = this.options.repository.get<{
      sourceHashes: string[];
      expectedCatalogRevision: number;
      beforePortableDigest: string;
      projectedPortableDigest: string;
      targetTombstones: SyncTombstone[];
    }>("materialization");
    if (!journal) return;
    const catalog = this.options.catalog.snapshot();
    check(catalog.ok, "unavailable");
    if (catalog.value.catalogRevision === journal.expectedCatalogRevision) {
      this.options.repository.remove("materialization");
      return;
    }
    const actual = await this.#wait(
      exportSyncSnapshot(
        this.options.catalog,
        this.options.repository,
        this.options.secrets,
        journal.targetTombstones,
        () => !this.#locked && g === this.#generation,
      ),
      g,
    );
    const digest = syncDigest(actual.snapshot);
    if (digest === journal.projectedPortableDigest) {
      this.options.repository.transaction(() => {
        this.options.repository.set("materializedHeads", journal.sourceHashes);
        this.options.repository.set("tombstones", journal.targetTombstones);
        this.options.repository.remove("materialization");
        for (const hash of journal.sourceHashes)
          this.options.repository.updateOperation(hash, { verdict: "applied" });
      });
    } else if (digest === journal.beforePortableDigest)
      this.options.repository.remove("materialization");
    else {
      this.#statusFault = "reconcile";
      fail("conflict");
    }
  }
  publish(): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      await this.#reconcileMaterialization(g);
      const ctx = await this.#context(g);
      try {
        const cert = ctx.accepted.certificates.find(
          (c) => c.deviceId === ctx.config.deviceId,
        );
        check(cert && cert.role !== "reader", "forbidden");
        const exported = await this.#wait(
          exportSyncSnapshot(
            this.options.catalog,
            this.options.repository,
            this.options.secrets,
            this.#tombstones(),
            () => !this.#locked && g === this.#generation,
          ),
          g,
        );
        const plaintext = encodeSyncSnapshot(exported.snapshot);
        let row: SyncStoredOperation | null = null;
        try {
          const digest = syncDigest(exported.snapshot);
          if (
            this.options.repository.get<string>("lastPublishedDigest") !==
            digest
          ) {
            const parents = this.#heads().sort();
            check(parents.length <= 64, "conflict");
            const entropy = freshEntropy();
            const header = {
              ...ctx.config.scope,
              epoch: ctx.accepted.control.activeEpoch,
              operationId: randomUUID(),
              authorDeviceId: ctx.config.deviceId,
              controlHash: ctx.accepted.commitment,
              parentsDigest: parentsDigest(parents),
              ...entropy,
              plaintextLength: plaintext.length,
            };
            const key = ctx.epochs.get(header.epoch);
            check(key, "key-unavailable");
            const wire = sealOperation(
              header,
              parents,
              key,
              plaintext,
              ctx.signing,
            );
            row = {
              hash: operationCommitment(wire),
              operationId: header.operationId,
              epoch: header.epoch,
              salt: header.salt,
              wire: b64(wire),
              parents,
              sequence: null,
              direction: "out",
              verdict: "pending",
            };
            this.#guard(g);
            this.options.repository.transaction(() => {
              this.options.repository.addOperation(row!);
              this.options.repository.set("materializedHeads", [row!.hash]);
              this.options.repository.set(
                "tombstones",
                exported.snapshot.tombstones,
              );
              this.options.repository.set("lastPublishedDigest", digest);
              this.options.repository.set("warnings", exported.warnings);
            });
          }
        } finally {
          plaintext.fill(0);
        }
        const pending = this.options.repository
          .operations()
          .filter((o) => o.direction === "out" && o.verdict === "pending");
        for (const op of pending) {
          const response = await this.#wait(
            this.#transport(ctx.config, g).exchange(
              {
                afterSequence:
                  this.options.repository.get<number>("cursor") ?? 0,
                operations: [{ wire: op.wire, parents: op.parents }],
              },
              this.#abort.signal,
            ),
            g,
          );
          if (!response.ok) {
            if (
              response.code === "stale-control" ||
              response.code === "conflict"
            )
              this.options.repository.updateOperation(op.hash, {
                verdict: "conflict",
              });
            return fail(response.code);
          }
          const value = response.value;
          this.options.repository.transaction(() => {
            this.#ingest(value.operations, ctx);
            this.options.repository.updateOperation(op.hash, {
              verdict: "accepted",
            });
            this.options.repository.set("cursor", value.nextSequence);
          });
          if (value.hasMore) await this.#fetchOperations(ctx, g);
        }
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  review(input: {
    operationHashes: string[];
  }): Promise<SyncResult<SyncReview>> {
    return this.#run(async (g) => {
      await this.#reconcileMaterialization(g);
      const ctx = await this.#context(g);
      try {
        check(
          Array.isArray(input.operationHashes) &&
            input.operationHashes.length <= 64 &&
            new Set(input.operationHashes).size ===
              input.operationHashes.length,
        );
        const ops = this.options.repository.operations();
        const referenced = new Set(ops.flatMap((o) => o.parents));
        const hashes = input.operationHashes.length
          ? input.operationHashes
          : ops.filter((o) => !referenced.has(o.hash)).map((o) => o.hash);
        check(hashes.length > 0 && hashes.length <= 64, "conflict");
        const local = await this.#wait(
          exportSyncSnapshot(
            this.options.catalog,
            this.options.repository,
            this.options.secrets,
            this.#tombstones(),
            () => !this.#locked && g === this.#generation,
          ),
          g,
        );
        let merged = local.snapshot;
        const conflicts: SyncConflict[] = [];
        const staleKeys = new Set<string>();
        let lastBase = emptySyncSnapshot(),
          lastRemote = emptySyncSnapshot();
        const localAncestors = new Set(
          this.#heads().flatMap((h) => [...this.#ancestors(h, ops)]),
        );
        // Multiple independent heads are merged in stable commitment order; conflicts remain explicit.
        for (const hash of [...hashes].sort()) {
          const row = ops.find((o) => o.hash === hash);
          check(row, "invalid");
          const ancestry = this.#ancestors(hash, ops);
          const common = ops.filter(
            (o) => ancestry.has(o.hash) && localAncestors.has(o.hash),
          );
          const base = common.length
            ? this.#snapshotOperation(common.at(-1)!, ctx)
            : emptySyncSnapshot();
          const remote = this.#snapshotOperation(row, ctx);
          const [head] = unframe(
            bytes(row.wire),
            3,
            1024 * 1024 + 16,
            1024 * 1024 + 2048,
          );
          if (
            operationDisposition(parseDataHeader(head), ctx.accepted) !==
            "materialize"
          ) {
            for (const r of [...remote.records, ...remote.tombstones]) {
              const recordKey = `${r.type}/${r.id}`;
              staleKeys.add(recordKey);
              conflicts.push({
                key: recordKey,
                type: r.type,
                id: r.id,
                label:
                  "data" in r
                    ? String((r.data as Record<string, unknown>).label)
                    : "Deleted record",
                reason: "stale-control",
                localPreview: "",
                remotePreview: "",
              });
            }
          }
          const result = mergeSyncSnapshots(base, merged, remote);
          merged = result.snapshot;
          conflicts.push(...result.conflicts);
          lastBase = base;
          lastRemote = remote;
        }
        conflicts.push(...syncGraphConflicts(merged));
        // Store all branch inputs in memory; no decrypted snapshot is written to the sync journal.
        const reviewToken = randomUUID(),
          expiresAt = this.#now() + 5 * 60_000;
        check(this.#reviews.size < 16, "busy");
        const plan: ReviewPlan = {
          expiresAt,
          generation: g,
          catalogRevision: local.catalogRevision,
          controlHash: ctx.accepted.commitment,
          sourceHashes: hashes,
          staleKeys: [...staleKeys],
          localDigest: syncDigest(local.snapshot),
          base: lastBase,
          local: local.snapshot,
          remote: lastRemote,
          warnings: local.warnings,
        };
        (
          plan as ReviewPlan & {
            branches?: { base: SyncSnapshot; remote: SyncSnapshot }[];
          }
        ).branches = [...hashes].sort().map((hash) => {
          const ancestry = this.#ancestors(hash, ops);
          const common = ops.filter(
            (o) => ancestry.has(o.hash) && localAncestors.has(o.hash),
          );
          return {
            base: common.length
              ? this.#snapshotOperation(common.at(-1)!, ctx)
              : emptySyncSnapshot(),
            remote: this.#snapshotOperation(
              ops.find((o) => o.hash === hash)!,
              ctx,
            ),
          };
        });
        this.#reviews.set(reviewToken, plan);
        const reviewTimer = setTimeout(() => {
          this.#reviews.delete(reviewToken);
          this.#reviewTimers.delete(reviewToken);
        }, 5 * 60_000);
        reviewTimer.unref();
        this.#reviewTimers.set(reviewToken, reviewTimer);
        const identities = merged.records.filter((r) => r.type === "identity");
        if (identities.some((r) => r.data.method === "password"))
          plan.warnings.push(
            "Passwords are not synchronized. Imported login metadata may need a local password.",
          );
        const impactSnapshot = this.options.catalog.snapshot();
        check(
          impactSnapshot.ok &&
            impactSnapshot.value.catalogRevision === local.catalogRevision,
          "conflict",
        );
        const credentialImpacts = new Set<string>();
        for (const mapping of this.options.repository
          .mappings()
          .filter((row) => row.type === "identity")) {
          const identity = impactSnapshot.value.identities.find(
            (row) => row.id === mapping.localId,
          );
          if (!identity?.passwordRef) continue;
          for (const branch of (
            plan as ReviewPlan & { branches: { remote: SyncSnapshot }[] }
          ).branches) {
            const remote = branch.remote.records.find(
              (row) => row.type === "identity" && row.id === mapping.syncId,
            );
            if (
              branch.remote.tombstones.some(
                (row) => row.type === "identity" && row.id === mapping.syncId,
              ) ||
              (remote &&
                (remote.data.username !== identity.username ||
                  remote.data.method !== identity.method))
            )
              credentialImpacts.add(mapping.syncId);
          }
        }
        if (credentialImpacts.size)
          plan.warnings.push(
            `Using remote changes for ${credentialImpacts.size} saved login(s) detaches the local password and queues its Keychain cleanup after Apply. Do not Apply this merge if you want to preserve those logins.`,
          );
        return {
          reviewToken,
          expiresAt,
          records: merged.records.length,
          deletions: merged.tombstones.length,
          conflicts: [
            ...new Map(conflicts.map((c) => [c.key, c])).values(),
          ].map((c) => {
            const localRow = local.snapshot.records.find(
              (r) => r.id === c.id && r.type === c.type,
            );
            const localDeleted = local.snapshot.tombstones.some(
              (r) => r.id === c.id && r.type === c.type,
            );
            const branch = [
              ...(plan as ReviewPlan & { branches: { remote: SyncSnapshot }[] })
                .branches,
            ]
              .reverse()
              .find(
                (b) =>
                  b.remote.records.some(
                    (r) => r.id === c.id && r.type === c.type,
                  ) ||
                  b.remote.tombstones.some(
                    (r) => r.id === c.id && r.type === c.type,
                  ),
              );
            const remoteRow = branch?.remote.records.find(
              (r) => r.id === c.id && r.type === c.type,
            );
            return {
              ...c,
              localPreview: syncRecordPreview(
                localRow ?? (localDeleted ? null : undefined),
              ),
              remotePreview: syncRecordPreview(
                remoteRow ?? (branch ? null : undefined),
              ),
            };
          }),
          warnings: [...new Set(plan.warnings)],
        };
      } finally {
        this.#clear(ctx);
      }
    });
  }
  apply(input: {
    reviewToken: string;
    resolutions: SyncResolution[];
  }): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      const plan = this.#reviews.get(input.reviewToken);
      this.#reviews.delete(input.reviewToken);
      const timer = this.#reviewTimers.get(input.reviewToken);
      if (timer) clearTimeout(timer);
      this.#reviewTimers.delete(input.reviewToken);
      check(
        plan && plan.expiresAt > this.#now() && plan.generation === g,
        "invalid",
      );
      check(
        Array.isArray(input.resolutions) &&
          input.resolutions.length <= 2000 &&
          input.resolutions.every(
            (r) =>
              r &&
              typeof r.key === "string" &&
              ["local", "remote", "restore"].includes(r.choice),
          ),
      );
      const ctx = await this.#context(g);
      try {
        check(ctx.accepted.commitment === plan.controlHash, "stale-control");
        if (plan.staleKeys.length) {
          check(
            ctx.accepted.certificates.some(
              (c) => c.deviceId === ctx.config.deviceId && c.role !== "reader",
            ),
            "forbidden",
          );
          check(
            plan.staleKeys.every((key) =>
              input.resolutions.some((r) => r.key === key),
            ),
            "stale-control",
          );
        }
        let target = plan.local;
        const branches = (
          plan as ReviewPlan & {
            branches: { base: SyncSnapshot; remote: SyncSnapshot }[];
          }
        ).branches;
        for (const branch of branches) {
          const result = mergeSyncSnapshots(
            branch.base,
            target,
            branch.remote,
            input.resolutions,
          );
          check(result.conflicts.length === 0, "conflict");
          target = result.snapshot;
        }
        check(syncGraphConflicts(target).length === 0, "conflict");
        const current = await this.#wait(
          exportSyncSnapshot(
            this.options.catalog,
            this.options.repository,
            this.options.secrets,
            this.#tombstones(),
            () => !this.#locked && g === this.#generation,
          ),
          g,
        );
        check(
          current.catalogRevision === plan.catalogRevision &&
            syncDigest(current.snapshot) === plan.localDigest,
          "conflict",
        );
        // Content-key initialization is an independent, reconciled local operation before the final revision capture.
        if (target.records.some((r) => r.type === "snippet"))
          check(
            await this.#wait(this.options.secrets.initialize(), g),
            "key-unavailable",
          );
        const read = this.options.catalog.snapshot();
        check(read.ok, "unavailable");
        const prepared = await this.#wait(
          prepareSyncCatalogImport(
            target,
            read.value,
            this.options.repository,
            this.options.secrets,
            () => !this.#locked && g === this.#generation,
          ),
          g,
        );
        const projectedDigest = syncDigest(target);
        let acceptedHashes = plan.sourceHashes.filter((h) =>
          this.options.repository
            .operations()
            .some((o) => o.hash === h && o.sequence !== null),
        );
        if (plan.staleKeys.length) {
          // Reading an authenticated historical ancestor is distinct from admitting its changes now.
          // Explicit decisions are signed anew by a current writer, with fresh immutable encryption.
          const parents = [
            ...new Set([
              ...acceptedHashes,
              ...this.#heads().filter((h) =>
                this.options.repository
                  .operations()
                  .some((o) => o.hash === h && o.sequence !== null),
              ),
            ]),
          ].sort();
          check(parents.length <= 64, "conflict");
          const plaintext = encodeSyncSnapshot(target);
          let reconciliation: SyncStoredOperation;
          try {
            const header = {
              ...ctx.config.scope,
              epoch: ctx.accepted.control.activeEpoch,
              operationId: randomUUID(),
              authorDeviceId: ctx.config.deviceId,
              controlHash: ctx.accepted.commitment,
              parentsDigest: parentsDigest(parents),
              ...freshEntropy(),
              plaintextLength: plaintext.length,
            };
            const epochKey = ctx.epochs.get(header.epoch);
            check(epochKey, "key-unavailable");
            const wire = sealOperation(
              header,
              parents,
              epochKey,
              plaintext,
              ctx.signing,
            );
            reconciliation = {
              hash: operationCommitment(wire),
              operationId: header.operationId,
              epoch: header.epoch,
              salt: header.salt,
              wire: b64(wire),
              parents,
              sequence: null,
              direction: "out",
              verdict: "pending",
            };
            this.options.repository.addOperation(reconciliation);
          } finally {
            plaintext.fill(0);
          }
          await this.#fetchOperations(ctx, g, [
            { wire: reconciliation.wire, parents: reconciliation.parents },
          ]);
          const saved = this.options.repository
            .operations()
            .find((o) => o.hash === reconciliation.hash);
          check(saved && saved.sequence !== null, "unavailable");
          acceptedHashes = [reconciliation.hash];
        }
        this.#guard(g);
        this.options.repository.set("materialization", {
          sourceHashes: acceptedHashes,
          expectedCatalogRevision: read.value.catalogRevision,
          beforePortableDigest: plan.localDigest,
          projectedPortableDigest: projectedDigest,
          targetTombstones: target.tombstones,
          state: "staged",
        });
        if (prepared.changes.length) {
          const committed = this.options.catalog.commit({
            expectedCatalogRevision: read.value.catalogRevision,
            changes: prepared.changes,
          });
          if (!committed.ok) {
            this.options.repository.remove("materialization");
            fail(committed.error.code);
          }
        }
        this.options.repository.transaction(() => {
          this.options.repository.set("materializedHeads", acceptedHashes);
          this.options.repository.set("tombstones", target.tombstones);
          this.options.repository.set("warnings", [
            ...new Set([...plan.warnings, ...prepared.warnings]),
          ]);
          this.options.repository.set("lastPublishedDigest", null);
          this.options.repository.remove("materialization");
          for (const hash of plan.sourceHashes)
            this.options.repository.updateOperation(hash, {
              verdict: "applied",
            });
        });
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  rotate(input: {
    removeDeviceIds: string[];
    readerDeviceIds: string[];
  }): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        check(
          ctx.owner &&
            ctx.accepted.control.ownerDeviceId === ctx.config.deviceId,
          "forbidden",
        );
        check(
          Array.isArray(input.removeDeviceIds) &&
            Array.isArray(input.readerDeviceIds) &&
            !input.removeDeviceIds.includes(ctx.config.deviceId) &&
            !input.readerDeviceIds.includes(ctx.config.deviceId),
        );
        const ids = new Set(ctx.accepted.certificates.map((c) => c.deviceId));
        check(
          [...input.removeDeviceIds, ...input.readerDeviceIds].every((id) =>
            ids.has(id),
          ),
        );
        const epoch = ctx.accepted.control.activeEpoch + 1;
        check(epoch <= 0xffffffff && epoch <= 4096, "too-large");
        const key = generateEpochKey();
        ctx.epochs.set(epoch, key);
        await this.#put(ctx.config, `epoch/${epoch}`, "epoch", key, g);
        const certs = ctx.accepted.certificates
          .filter((c) => !input.removeDeviceIds.includes(c.deviceId))
          .map((c) => ({
            ...c,
            role: input.readerDeviceIds.includes(c.deviceId)
              ? ("reader" as const)
              : c.role,
          }));
        const publication = this.#publication(ctx, certs, ctx.owner, epoch);
        await this.#publishControl(ctx.config, publication, g);
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  createRecovery(): Promise<
    SyncResult<{ confirmationToken: string; secret: string; kit: Uint8Array }>
  > {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        check(
          ctx.owner &&
            ctx.accepted.control.ownerDeviceId === ctx.config.deviceId,
          "forbidden",
        );
        const publication = this.options.repository
          .controls()
          .find((c) => c.hash === ctx.accepted.commitment)!
          .publication as SyncControlPublication;
        const previous =
          ctx.accepted.control.previousHash === SYNC_ZERO
            ? publicKey(ctx.config.ownerSpki)
            : this.#acceptedAt(ctx.accepted.control.previousHash, ctx.config)
                .control.newOwnerKey;
        const binding = {
          ...ctx.config.scope,
          recoveryId: randomUUID(),
          controlHash: ctx.accepted.commitment,
        };
        const plaintext = encodeRecoveryPayload(
          {
            ownerKey: ctx.owner,
            previousOwnerKey: previous,
            baseControlWire: bytes(publication.controlWire),
            epochs: [...ctx.epochs]
              .sort(([a], [b]) => a - b)
              .map(([epoch, key]) => ({ epoch, key })),
          },
          binding,
          fingerprint(ctx.owner),
        );
        const secret = generateRecoverySecret();
        try {
          const kit = sealRecovery(
            {
              ...binding,
              ...freshEntropy(),
              plaintextLength: plaintext.length,
            },
            secret,
            plaintext,
          );
          const descriptor = recoveryDescriptor({
            ...binding,
            recoveryEnvelopeHash: sha(kit),
          });
          this.cancelRecovery();
          const token = randomUUID();
          this.#recovery = {
            token,
            expiresAt: this.#now() + 5 * 60_000,
            secret: Buffer.from(secret),
            kit: Buffer.from(kit),
            descriptor,
            controlHash: ctx.accepted.commitment,
          };
          this.#recoveryTimer = setTimeout(
            () => this.cancelRecovery(),
            5 * 60_000,
          );
          this.#recoveryTimer.unref();
          return { confirmationToken: token, secret: b64(secret), kit };
        } finally {
          plaintext.fill(0);
          secret.fill(0);
        }
      } finally {
        this.#clear(ctx);
      }
    });
  }
  confirmRecovery(input: {
    confirmationToken: string;
    secret: string;
    kit: Uint8Array;
  }): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      const draft = this.#recovery;
      this.#recovery = null;
      if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = null;
      if (
        !draft ||
        draft.token !== input.confirmationToken ||
        draft.expiresAt <= this.#now()
      ) {
        draft?.secret.fill(0);
        draft?.kit.fill(0);
        fail("invalid");
      }
      check(draft);
      try {
        check(
          typeof input.secret === "string" &&
            /^[A-Za-z0-9_-]{43}$/.test(input.secret),
        );
        const secret = bytes(input.secret);
        try {
          check(
            secret.length === draft.secret.length &&
              timingSafeEqual(secret, draft.secret) &&
              sha(input.kit) === sha(draft.kit),
            "invalid",
          );
          const ctx = await this.#context(g);
          try {
            check(
              ctx.owner && ctx.accepted.commitment === draft.controlHash,
              "stale-control",
            );
            const [raw] = unframe(input.kit, 2);
            const h = parseRecoveryHeader(raw);
            const plaintext = openRecovery(input.kit, h, secret);
            try {
              const decoded = decodeRecoveryPayload(
                plaintext,
                h,
                fingerprint(ctx.owner),
              );
              for (const e of decoded.epochs) e.key.fill(0);
            } finally {
              plaintext.fill(0);
            }
            const publication = this.#publication(
              ctx,
              ctx.accepted.certificates,
              ctx.owner,
              ctx.accepted.control.activeEpoch,
              [],
              { descriptor: b64(draft.descriptor), wire: b64(draft.kit) },
            );
            await this.#publishControl(ctx.config, publication, g);
            this.options.repository.set("recoveryReady", true);
            return this.state();
          } finally {
            this.#clear(ctx);
          }
        } finally {
          secret.fill(0);
        }
      } finally {
        draft.secret.fill(0);
        draft.kit.fill(0);
      }
    });
  }
  recover(input: {
    endpoint: string;
    token: string;
    expectedScope: SyncScope;
    expectedOwnerFingerprint: string;
    secret: string;
    kit: Uint8Array;
  }): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      check(
        typeof input.secret === "string" &&
          /^[A-Za-z0-9_-]{43}$/.test(input.secret) &&
          input.kit instanceof Uint8Array &&
          input.kit.length <= 8 * 1024 * 1024 + 2048,
      );
      const [rawHeader] = unframe(input.kit, 2);
      const header = parseRecoveryHeader(rawHeader);
      check(
        syncCanonical({
          deploymentId: header.deploymentId,
          accountId: header.accountId,
          vaultId: header.vaultId,
        }) === syncCanonical(input.expectedScope),
        "untrusted-authority",
      );
      const secret = bytes(input.secret);
      let decoded: ReturnType<typeof decodeRecoveryPayload>;
      try {
        const plaintext = openRecovery(input.kit, header, secret);
        try {
          decoded = decodeRecoveryPayload(
            plaintext,
            header,
            input.expectedOwnerFingerprint,
          );
        } finally {
          plaintext.fill(0);
        }
      } finally {
        secret.fill(0);
      }
      try {
        const c = await this.#setup(input, g);
        c.ownerSpki = spki(decoded.ownerKey);
        c.expectedOwnerFingerprint = input.expectedOwnerFingerprint;
        const [baseBody] = unframe(decoded.baseControlWire, 3, 1024, 2048);
        const baseFields = unframe(baseBody, 14, 1024, 1024);
        const baseGeneration = Number(baseFields[6].toString("ascii"));
        const response = this.#unwrap(
          await this.#wait(
            this.#transport(c, g).controls(
              baseGeneration - 1,
              this.#abort.signal,
            ),
            g,
          ),
        );
        const base = response.controls[0];
        check(
          base &&
            controlCommitment(bytes(base.controlWire)) === header.controlHash &&
            b64(decoded.baseControlWire) === base.controlWire,
          "stale-control",
        );
        c.anchor = {
          publication: base,
          previousOwnerSpki: spki(decoded.previousOwnerKey),
        };
        const accepted = acceptRecoveryControl(
          bytes(base.controlWire),
          bytes(base.rosterWire),
          c.scope,
          decoded.previousOwnerKey,
          input.expectedOwnerFingerprint,
        );
        await this.#pin(c, accepted, g);
        this.options.repository.transaction(() => {
          this.options.repository.set("configuration", c);
          this.options.repository.addControl({
            hash: accepted.commitment,
            generation: accepted.control.generation,
            publication: base,
          });
        });
        await this.#syncControls(c, g);
        const current = this.#accepted(c)!;
        check(
          fingerprint(current.control.newOwnerKey) ===
            input.expectedOwnerFingerprint,
          "stale-control",
        );
        check(
          decoded.epochs.at(-1)?.epoch === current.control.activeEpoch,
          "stale-control",
        );
        for (const e of decoded.epochs)
          await this.#put(c, `epoch/${e.epoch}`, "epoch", e.key, g);
        const signingRaw = await this.#get(c, "signing", "device-signing", g),
          wrappingRaw = await this.#get(c, "wrapping", "device-wrapping", g);
        try {
          const signing = privateKey(signingRaw),
            wrapping = privateKey(wrappingRaw),
            newOwner = generateSigningKey();
          const epoch = current.control.activeEpoch + 1;
          check(epoch <= 4096, "too-large");
          const epochs = new Map(
            decoded.epochs.map((e) => [e.epoch, Buffer.from(e.key)]),
          );
          epochs.set(epoch, generateEpochKey());
          const ctx: Context = {
            config: c,
            accepted: current,
            signing,
            wrapping,
            owner: decoded.ownerKey,
            epochs,
          };
          try {
            await this.#put(
              c,
              `epoch/${epoch}`,
              "epoch",
              epochs.get(epoch)!,
              g,
            );
            const newCert: Certificate = {
              ...c.scope,
              deviceId: c.deviceId,
              signingKey: createPublicKey(signing),
              wrappingKey: createPublicKey(wrapping),
              role: "owner",
              enrollmentHash: sha(input.kit),
              ownerFingerprint: fingerprint(newOwner),
              firstGeneration: current.control.generation + 1,
            };
            const certs = [
              ...current.certificates.filter(
                (cert) => cert.deviceId !== current.control.ownerDeviceId,
              ),
              newCert,
            ];
            const publication = this.#publication(ctx, certs, newOwner, epoch);
            await this.#storeKey(c, "owner", "owner-signing", newOwner, g);
            await this.#publishControl(c, publication, g);
            c.phase = "enrolled";
            this.options.repository.set("configuration", c);
            return this.state();
          } finally {
            this.#clear(ctx);
          }
        } finally {
          signingRaw.fill(0);
          wrappingRaw.fill(0);
        }
      } finally {
        for (const epoch of decoded.epochs) epoch.key.fill(0);
      }
    });
  }
  cancelSetup(): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      const c = this.#config();
      check(
        c &&
          c.phase === "preparing" &&
          this.options.repository.controls().length === 0 &&
          !this.options.repository.get("pendingControl"),
        "conflict",
      );
      const accounts = Object.entries(c.refs).map(([slot, ref]) => ({
        ref,
        account: this.#account(
          c,
          slot === "token"
            ? "transport-token"
            : slot === "owner"
              ? "owner-signing"
              : slot === "signing"
                ? "device-signing"
                : slot === "wrapping"
                  ? "device-wrapping"
                  : "epoch",
          ref,
        ),
      }));
      this.options.repository.set("setupCancellation", {
        deviceId: c.deviceId,
        accounts,
        state: "staged",
      });
      for (const item of accounts) {
        await this.#wait(this.options.keyStore.delete(item.account), g);
        const observed = await this.#wait(
          this.options.keyStore.read(item.account),
          g,
        );
        try {
          check(observed.status === "missing", "key-unavailable");
        } finally {
          observed.value?.fill(0);
        }
      }
      this.#guard(g);
      this.options.repository.transaction(() => {
        for (const item of accounts)
          this.options.repository.remove(`provider/${item.ref}`);
        this.options.repository.remove("configuration");
        this.options.repository.remove("setupCancellation");
      });
      this.#statusFault = null;
      return this.state();
    });
  }
  lock(): void {
    this.#locked = true;
    this.#generation++;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#reviews.clear();
    for (const timer of this.#reviewTimers.values()) clearTimeout(timer);
    this.#reviewTimers.clear();
    for (const timer of this.#approvalTimers.values()) clearTimeout(timer);
    this.#approvalTimers.clear();
    for (const pending of this.#approvals.values())
      pending.approval.challengeSecret.fill(0);
    this.#approvals.clear();
    this.cancelRecovery();
    this.options.repository.cancelEnrollments();
  }
  cancelRecovery(): void {
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = null;
    this.#recovery?.secret.fill(0);
    this.#recovery?.kit.fill(0);
    this.#recovery = null;
  }
  unlock(): void {
    if (this.#locked) {
      this.#locked = false;
      this.#statusFault = null;
    }
  }
  resume(input: { token: string }): Promise<SyncResult<SyncState>> {
    return this.#run(async (g) => {
      const c = this.#config();
      check(
        c &&
          c.phase === "enrolled" &&
          !c.refs.token &&
          !this.options.repository.get("tokenDeletion"),
        "conflict",
      );
      check(
        typeof input.token === "string" &&
          /^[A-Za-z0-9_-]{43}$/.test(input.token) &&
          b64(bytes(input.token)) === input.token,
      );
      const token = bytes(input.token);
      try {
        const accepted = this.#accepted(c);
        check(accepted, "untrusted-authority");
        const pending = this.options.repository.get<{
          ref: string;
          digest: string;
        }>("resumeToken");
        check(!pending || pending.digest === sha(token), "conflict");
        // Verify scope and account authentication before writing a user-entered replacement token.
        const probe = (this.options.transportFactory ?? createSyncTransport)({
          endpoint: { url: c.endpoint, scope: c.scope },
          readToken: async () => {
            this.#guard(g);
            return Buffer.from(token);
          },
          signRequest: async (transcript) => {
            const key = await this.#private(c, "signing", "device-signing", g);
            return {
              deviceId: c.deviceId,
              signature: sign(null, transcript, key),
            };
          },
        });
        const info = this.#unwrap(
          await this.#wait(probe.info(this.#abort.signal), g),
        );
        check(
          info.deploymentId === c.scope.deploymentId &&
            info.accountId === c.scope.accountId &&
            info.vaultId === c.scope.vaultId,
          "untrusted-authority",
        );
        this.#unwrap(
          await this.#wait(
            probe.controls(accepted.control.generation, this.#abort.signal),
            g,
          ),
        );
        const ref = pending?.ref ?? randomUUID(),
          account = this.#account(c, "transport-token", ref),
          digest = sha(token);
        this.options.repository.set("resumeToken", { ref, digest });
        const journal = this.options.repository.get<{
          state: string;
          digest: string;
        }>(`provider/${ref}`);
        check(!journal || journal.digest === digest, "key-unavailable");
        this.options.repository.set(`provider/${ref}`, {
          state: journal?.state ?? "staged",
          slot: "token",
          kind: "transport-token",
          digest,
          account,
        });
        let observed = await this.#wait(this.options.keyStore.read(account), g);
        try {
          if (observed.status === "missing") {
            check(journal?.state !== "confirmed", "key-unavailable");
            await this.#wait(this.options.keyStore.write(account, token), g);
            observed = await this.#wait(this.options.keyStore.read(account), g);
          }
          check(
            observed.status === "present" &&
              observed.value &&
              observed.value.length === token.length &&
              timingSafeEqual(observed.value, token),
            "key-unavailable",
          );
        } finally {
          observed.value?.fill(0);
        }
        this.options.repository.set(`provider/${ref}`, {
          state: "confirmed",
          slot: "token",
          kind: "transport-token",
          digest,
          account,
        });
        const candidate: Configuration = {
          ...c,
          refs: { ...c.refs, token: ref },
        };
        await this.#syncControls(candidate, g);
        const current = this.#accepted(candidate);
        check(
          current?.certificates.some(
            (cert) => cert.deviceId === candidate.deviceId,
          ),
          "forbidden",
        );
        this.#guard(g);
        this.options.repository.transaction(() => {
          this.options.repository.set("configuration", candidate);
          this.options.repository.remove("resumeToken");
        });
        this.#statusFault = null;
        return this.state();
      } finally {
        token.fill(0);
      }
    });
  }
  logout(input: {
    forgetTransportToken: boolean;
  }): Promise<SyncResult<SyncState>> {
    this.lock();
    this.unlock();
    return this.#run(async (g) => {
      const c = this.#config();
      if (input.forgetTransportToken && c) {
        const resume = this.options.repository.get<{ ref: string }>(
          "resumeToken",
        );
        const refs = [
          ...new Set(
            [c.refs.token, resume?.ref].filter((ref): ref is string => !!ref),
          ),
        ];
        for (const ref of refs) {
          const account = this.#account(c, "transport-token", ref);
          this.options.repository.set("tokenDeletion", { account });
          const result = await this.#wait(
            this.options.keyStore.delete(account),
            g,
          );
          check(result === "confirmed", "key-unavailable");
          const after = await this.#wait(
            this.options.keyStore.read(account),
            g,
          );
          try {
            check(after.status === "missing", "key-unavailable");
          } finally {
            after.value?.fill(0);
          }
          this.options.repository.transaction(() => {
            if (c.refs.token === ref) {
              delete c.refs.token;
              this.options.repository.set("configuration", c);
            }
            if (resume?.ref === ref)
              this.options.repository.remove("resumeToken");
            this.options.repository.remove(`provider/${ref}`);
            this.options.repository.remove("tokenDeletion");
          });
        }
      }
      return this.state();
    }).then((result) => {
      if (result.ok) {
        this.lock();
        return { ok: true as const, value: this.state() };
      }
      return result;
    });
  }
  /** Main-side asynchronous native dialogs must fence results across lock/unlock, not only window ownership. */
  lifecycleEpoch(): number {
    return this.#generation;
  }
  async dispose(): Promise<void> {
    this.lock();
    await this.#tail;
  }
}
