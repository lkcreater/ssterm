/** Main-only personal-profile Team vault. No decrypted snapshots or authentication tokens enter SQL. */
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
import type {
  ResolvedHostConfig,
  TeamManagedSource,
} from "../../domain/src/catalog.ts";
import type { SessionKind } from "./sessions.ts";
import {
  SYNC_ZERO,
  syncBytes,
  syncHash,
  syncObject,
  syncUuid,
  type SyncControlPublication,
  type SyncOperationPublication,
  type SyncTransportResult,
} from "../../domain/src/sync.ts";
import {
  isTeamScope,
  isTeamHost,
  isTeamMetadataSnapshot,
  isTeamCredentialSnapshot,
  isTeamRecoveryKit,
  teamCanConnect,
  teamCanEdit,
  teamMetadataScope,
  teamCredentialScope,
  type TeamScope,
  type TeamRole,
  type TeamHost,
  type TeamPolicy,
  type TeamPolicyCheckpoint,
  type TeamPublishRequest,
  type TeamState,
  type TeamMetadataSnapshot,
  type TeamCredentialSnapshot,
  type TeamPrincipal,
  type TeamDevice,
  type TeamRecoveryKit,
  type TeamConnectGrant,
  type TeamAuditPage,
  type TeamClientEvent,
} from "../../domain/src/team.ts";
import {
  TeamRepository,
  TeamRepositoryFault,
} from "../../adapters/src/team-repository.ts";
import type { TeamKeyStore } from "../../adapters/src/team-keychain.ts";
import {
  createTeamTransport,
  validTeamEndpoint,
  type TeamTransport,
  type TeamTransportOptions,
} from "../../adapters/src/team-transport.ts";
import {
  acceptTeamCheckpoint,
  sealTeamPolicy,
  teamPolicyHash,
  teamTargetDigest,
  teamEnrollmentHash,
  verifyTeamOperation,
  type AcceptedTeamCheckpoint,
} from "../../adapters/src/team-policy.ts";
import {
  generateDeviceKeys,
  generateSigningKey,
  generateEpochKey,
  generateRecoverySecret,
  freshEntropy,
  fingerprint,
  frame,
  unframe,
  parentsDigest,
  sealOperation,
  openOperation,
  operationCommitment,
  parseDataHeader,
  parseWrapHeader,
  wrapEpoch,
  unwrapEpoch,
  sealRecovery,
  openRecovery,
  parseRecoveryHeader,
} from "../../adapters/src/sync-crypto.ts";
import {
  sealCertificate,
  readCertificate,
  rosterBytes,
  rosterCommitment,
  sealControl,
  controlCommitment,
  enrollmentBody,
  enrollmentHash,
  parseEnrollmentBody,
  challengeEnrollment as challengeCrypto,
  proveEnrollment as proveCrypto,
  verifyEnrollment,
  type AcceptedControl,
  type Certificate,
  type EnrollmentApproval,
} from "../../adapters/src/sync-control.ts";
import {
  encodeRecoveryPayload,
  decodeRecoveryPayload,
  recoveryDescriptor,
  recoveryDescriptorDigest,
} from "../../adapters/src/sync-recovery.ts";

export type TeamResult<T> =
  { ok: true; value: T } | { ok: false; code: string };
export interface TeamSessionContext {
  ownerId: string;
  sessionId: string;
  generation: number;
  kind: SessionKind;
  signal?: AbortSignal;
}
export interface TeamAccessChange {
  teamId: string;
  principalId: string;
  deviceId: string;
  role: TeamRole | null;
  policyHash: string | null;
  canConnect: boolean;
}
export interface TeamStateView {
  status:
    | "disabled"
    | "pending"
    | "enrolled"
    | "revoked"
    | "locked"
    | "key-unavailable"
    | "reconcile";
  endpoint: string | null;
  scope: TeamScope | null;
  principalId: string | null;
  deviceId: string | null;
  role: TeamRole | null;
  generation: number;
  metadataEpoch: number;
  credentialEpoch: number;
  policyHash: string | null;
  metadataHash: string | null;
  credentialHash: string | null;
  ownerFingerprint: string | null;
  canManage: boolean;
  recoveryReady: boolean;
  needsToken: boolean;
  pending: number;
  hosts: (TeamHost & { virtualHostId: string })[];
  members: {
    principalId: string;
    role: TeamRole;
    status: "active" | "revoked";
    label: string;
  }[];
  devices: TeamDevice[];
  warnings: string[];
}
export interface TeamInvitation {
  principalId: string;
  token: string;
  scope: TeamScope;
  ownerFingerprint: string;
  endpoint: string;
}
export interface TeamRecoveryDraft {
  confirmationToken: string;
  expiresAt: number;
  secret: string;
  kit: string;
}
interface Configuration {
  endpoint: string;
  scope: TeamScope;
  principalId: string;
  deviceId: string;
  ownerSpki: string;
  expectedOwnerFingerprint: string;
  phase: "preparing" | "joining" | "enrolled";
  refs: Record<string, string>;
  repositoryIdentity: string;
}
interface Materialized {
  policyHash: string;
  metadataHash: string;
  credentialHash: string;
  metadata: TeamMetadataSnapshot;
}
interface Context {
  config: Configuration;
  accepted: AcceptedTeamCheckpoint;
  signing: KeyObject;
  wrapping: KeyObject;
  owner: KeyObject | null;
  epochs: { metadata: Buffer; credentials: Buffer | null };
  metadata: TeamMetadataSnapshot;
  credentials: TeamCredentialSnapshot | null;
  heads: { metadata: string; credentials: string };
}
interface CurrentData {
  policyHash: string;
  metadataHash: string;
  credentialHash: string;
  metadata: SyncOperationPublication;
  credentials: SyncOperationPublication | null;
}
interface PendingPublication {
  request: TeamPublishRequest;
  config?: Configuration;
  invitation?: { principalId: string; slot: string };
  recoveryReady?: boolean;
}
interface PendingWrite {
  domain: "metadata" | "credentials";
  request: {
    policyHash: string;
    expectedHead: string;
    operation: SyncOperationPublication;
  };
}
interface Approval {
  principalId: string;
  role: TeamRole;
  policyHash: string;
  fingerprint: string;
  approval: EnrollmentApproval;
  body: Buffer;
  challenge: Buffer;
  timer: ReturnType<typeof setTimeout>;
}
class TeamFault extends Error {
  constructor(readonly code: string) {
    super("Team action failed.");
  }
}
function check(v: unknown, code = "invalid"): asserts v {
  if (!v) throw new TeamFault(code);
}
const b64 = (v: Uint8Array) => Buffer.from(v).toString("base64url");
const bytes = (v: string) => Buffer.from(v, "base64url");
const sha = (v: Uint8Array | string) =>
  createHash("sha256").update(v).digest("hex");
const spki = (k: KeyObject) =>
  b64(
    (k.type === "public" ? k : createPublicKey(k)).export({
      format: "der",
      type: "spki",
    }),
  );
const pub = (v: string) =>
  createPublicKey({ key: bytes(v), format: "der", type: "spki" });
const priv = (v: Uint8Array) => {
  const raw = Buffer.from(v);
  try {
    return createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
  } finally {
    raw.fill(0);
  }
};
const canonical = (v: unknown) => JSON.stringify(v);
function textObject(text: string): Record<string, unknown> {
  check(typeof text === "string" && Buffer.byteLength(text) <= 512 * 1024);
  const v: unknown = JSON.parse(text);
  check(
    v && typeof v === "object" && !Array.isArray(v) && canonical(v) === text,
  );
  return v as Record<string, unknown>;
}
const sorted = <T>(v: T[], field: keyof T): T[] =>
  [...v].sort((a, b) => String(a[field]).localeCompare(String(b[field])));
const emptyMetadata = (): TeamMetadataSnapshot => ({
  format: "ssterm-team-metadata-v1",
  hosts: [],
  memberNames: [],
});
const emptyCredentials = (): TeamCredentialSnapshot => ({
  format: "ssterm-team-credentials-v1",
  credentials: [],
});
const cryptoRole = (
  role: TeamRole,
  domain: "metadata" | "credentials",
): "owner" | "writer" | "reader" =>
  role === "Owner"
    ? "owner"
    : role === "Editor" && domain === "metadata"
      ? "writer"
      : "reader";

export class TeamClient {
  #locked = false;
  #generation = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #abort = new AbortController();
  #materialized: Materialized | null = null;
  #denied = false;
  #fault: TeamStateView["status"] | null = null;
  #listeners = new Set<(event: TeamAccessChange) => void>();
  #approvals = new Map<string, Approval>();
  #leases = new Map<
    string,
    {
      source: TeamManagedSource;
      session: TeamSessionContext;
      host: TeamHost;
      expiresAt: number;
    }
  >();
  #recovery: {
    view: TeamRecoveryDraft;
    secret: Buffer;
    kit: TeamRecoveryKit;
    metadataDescriptor: string;
    credentialDescriptor: string;
    policyHash: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  readonly #now: () => number;
  readonly #monotonic: () => number;
  constructor(
    private readonly options: {
      repository: TeamRepository;
      keyStore: TeamKeyStore;
      transportFactory?: (options: TeamTransportOptions) => TeamTransport;
      now?: () => number;
      monotonicNow?: () => number;
      onAccessChange?: (event: TeamAccessChange) => void;
    },
  ) {
    this.#denied = !!options.repository.get("accessDenied");
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
        value.value instanceof Uint8Array
      )
        value.value.fill(0);
      throw new TeamFault("fenced");
    }
    return value;
  }
  #run<T>(run: (g: number) => Promise<T>): Promise<TeamResult<T>> {
    if (this.#pending >= 8) return Promise.resolve({ ok: false, code: "busy" });
    this.#pending++;
    const g = this.#generation;
    const settled = this.#tail
      .then(async () => {
        try {
          this.#guard(g);
          const value = await run(g);
          this.#guard(g);
          return { ok: true as const, value };
        } catch (error) {
          const code =
            error instanceof TeamFault || error instanceof TeamRepositoryFault
              ? error.code
              : "invalid";
          if (code === "key-unavailable") this.#fault = "key-unavailable";
          return { ok: false as const, code };
        }
      })
      .finally(() => {
        this.#pending--;
      });
    this.#tail = settled.then(() => undefined);
    return settled;
  }
  #unwrap<T>(result: SyncTransportResult<T>): T {
    if (!result.ok) {
      if (result.code === "unauthorized" || result.code === "forbidden")
        this.#accessDenied();
      throw new TeamFault(result.code);
    }
    return result.value;
  }
  #accessDenied(): void {
    const c = this.#config();
    if (!c) return;
    this.#denied = true;
    this.#materialized = null;
    this.#leases.clear();
    const event: TeamAccessChange = {
      teamId: c.scope.teamId,
      principalId: c.principalId,
      deviceId: c.deviceId,
      role: null,
      policyHash: this.#accepted(c)?.policy.commitment ?? null,
      canConnect: false,
    };
    this.options.onAccessChange?.(event);
    for (const listener of this.#listeners) listener(event);
    this.options.repository.set("accessDenied", true);
  }
  #account(c: Configuration, kind: string, ref: string): string {
    return `team/v1/${c.scope.deploymentId}/${c.scope.accountId}/${c.scope.teamId}/${c.deviceId}/${kind}/${ref}`;
  }
  async #put(
    c: Configuration,
    slot: string,
    kind: string,
    value: Uint8Array,
    g: number,
  ): Promise<void> {
    const ref = c.refs[slot] ?? randomUUID();
    const account = this.#account(c, kind, ref);
    const digest = sha(value);
    const old = this.options.repository.get<{ digest: string; state: string }>(
      `provider/${ref}`,
    );
    check(!old || old.digest === digest, "key-unavailable");
    c.refs[slot] = ref;
    this.options.repository.set("configuration", c);
    this.options.repository.set(`provider/${ref}`, {
      account,
      slot,
      kind,
      digest,
      state: old?.state === "confirmed" ? "confirmed" : "staged",
    });
    const before = await this.#wait(this.options.keyStore.read(account), g);
    try {
      check(before.status !== "unavailable", "key-unavailable");
      if (before.status === "present")
        check(
          before.value &&
            before.value.length === value.length &&
            timingSafeEqual(Buffer.from(before.value), Buffer.from(value)),
          "key-unavailable",
        );
      else {
        check(!old || old.state === "staged", "key-unavailable");
        await this.#wait(this.options.keyStore.write(account, value), g);
      }
    } finally {
      before.value?.fill(0);
    }
    const read = await this.#wait(this.options.keyStore.read(account), g);
    try {
      check(
        read.status === "present" &&
          read.value &&
          read.value.length === value.length &&
          timingSafeEqual(read.value, value),
        "key-unavailable",
      );
    } finally {
      read.value?.fill(0);
    }
    this.options.repository.set(`provider/${ref}`, {
      account,
      slot,
      kind,
      digest,
      state: "confirmed",
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
    const journal = this.options.repository.get<{ digest: string }>(
      `provider/${ref}`,
    );
    check(journal, "key-unavailable");
    const read = await this.#wait(
      this.options.keyStore.read(this.#account(c, kind, ref)),
      g,
    );
    try {
      check(
        read.status === "present" &&
          read.value &&
          sha(read.value) === journal.digest,
        "key-unavailable",
      );
      return Buffer.from(read.value);
    } finally {
      read.value?.fill(0);
    }
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
  #transport(c: Configuration, g: number): TeamTransport {
    return (this.options.transportFactory ?? createTeamTransport)({
      endpoint: { url: c.endpoint, scope: c.scope },
      principalId: c.principalId,
      deviceId: c.deviceId,
      readToken: () => this.#get(c, "token", "transport-token", g),
      signRequest: async (transcript) => {
        const key = await this.#get(c, "signing", "device-signing", g);
        try {
          this.#guard(g);
          return {
            deviceId: c.deviceId,
            signature: sign(null, transcript, priv(key)),
          };
        } finally {
          key.fill(0);
        }
      },
    });
  }
  #accepted(c: Configuration): AcceptedTeamCheckpoint | null {
    let current: AcceptedTeamCheckpoint | undefined;
    for (const row of this.options.repository.checkpoints()) {
      current = acceptTeamCheckpoint(
        row.checkpoint,
        c.scope,
        pub(c.ownerSpki),
        current,
      );
      check(current.policy.commitment === row.hash, "untrusted-authority");
    }
    return current ?? null;
  }
  #role(c: Configuration, a: AcceptedTeamCheckpoint): TeamRole | null {
    const p = a.policy.policy.body.principals.find(
      (p) => p.principalId === c.principalId && p.status === "active",
    );
    return p &&
      a.policy.policy.body.devices.some(
        (d) => d.deviceId === c.deviceId && d.principalId === p.principalId,
      )
      ? p.role
      : null;
  }
  #notify(c: Configuration, a: AcceptedTeamCheckpoint): void {
    const role = this.#role(c, a);
    const event: TeamAccessChange = {
      teamId: c.scope.teamId,
      principalId: c.principalId,
      deviceId: c.deviceId,
      role,
      policyHash: a.policy.commitment,
      canConnect: role !== null && teamCanConnect(role),
    };
    this.#leases.clear();
    if (!event.canConnect) this.#materialized = null;
    this.options.onAccessChange?.(event);
    for (const listener of this.#listeners) listener(event);
  }
  observePolicy(listener: (event: TeamAccessChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async #pin(
    c: Configuration,
    a: AcceptedTeamCheckpoint,
    heads: { metadata: string | null; credentials: string | null },
    g: number,
    admissionFrom?: Configuration,
  ): Promise<void> {
    const existing = await this.#wait(
      this.options.keyStore.read(this.#account(c, "checkpoint", c.deviceId)),
      g,
    );
    try {
      check(existing.status !== "unavailable", "key-unavailable");
      const durable = this.#accepted(c),
        data = this.options.repository.get<CurrentData>("current");
      if (existing.status === "missing") {
        if (durable) {
          check(
            admissionFrom &&
              admissionFrom.deviceId !== c.deviceId &&
              admissionFrom.principalId === c.principalId &&
              canonical(admissionFrom.scope) === canonical(c.scope),
            "key-unavailable",
          );
          await this.#checkPin(admissionFrom, durable, g);
        }
      } else {
        check(existing.value, "key-unavailable");
        const pin = JSON.parse(
          Buffer.from(existing.value).toString("utf8"),
        ) as {
          repositoryIdentity: string;
          generation: number;
          policyHash: string;
          metadataHash: string | null;
          credentialHash: string | null;
        };
        check(
          pin.repositoryIdentity === c.repositoryIdentity &&
            Number.isSafeInteger(pin.generation) &&
            pin.generation <= a.policy.policy.body.generation,
          "key-unavailable",
        );
        if (pin.generation === a.policy.policy.body.generation) {
          check(pin.policyHash === a.policy.commitment, "key-unavailable");
          const dataMatches = data?.policyHash === pin.policyHash;
          check(
            (pin.metadataHash === heads.metadata ||
              (dataMatches && pin.metadataHash === data.metadataHash) ||
              (pin.metadataHash === null && !dataMatches)) &&
              (pin.credentialHash === heads.credentials ||
                (dataMatches && pin.credentialHash === data.credentialHash) ||
                (pin.credentialHash === null && !dataMatches)),
            "key-unavailable",
          );
        } else {
          check(
            durable?.policy.commitment === pin.policyHash &&
              durable.policy.policy.body.generation === pin.generation,
            "key-unavailable",
          );
          check(
            (pin.metadataHash === null && pin.credentialHash === null) ||
              (data?.policyHash === pin.policyHash &&
                data.metadataHash === pin.metadataHash &&
                data.credentialHash === pin.credentialHash),
            "key-unavailable",
          );
        }
      }
    } finally {
      existing.value?.fill(0);
    }
    const value = Buffer.from(
      canonical({
        repositoryIdentity: c.repositoryIdentity,
        generation: a.policy.policy.body.generation,
        policyHash: a.policy.commitment,
        metadataHash: heads.metadata,
        credentialHash: heads.credentials,
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
      const read = await this.#wait(
        this.options.keyStore.read(this.#account(c, "checkpoint", c.deviceId)),
        g,
      );
      try {
        check(
          read.status === "present" &&
            read.value &&
            Buffer.from(read.value).equals(value),
          "key-unavailable",
        );
      } finally {
        read.value?.fill(0);
      }
    } finally {
      value.fill(0);
    }
  }
  async #checkPin(
    c: Configuration,
    a: AcceptedTeamCheckpoint | null,
    g: number,
  ): Promise<void> {
    const read = await this.#wait(
      this.options.keyStore.read(this.#account(c, "checkpoint", c.deviceId)),
      g,
    );
    try {
      if (!a) {
        check(read.status === "missing", "key-unavailable");
        return;
      }
      check(read.status === "present" && read.value, "key-unavailable");
      const pin = JSON.parse(Buffer.from(read.value).toString("utf8")) as {
        repositoryIdentity: string;
        generation: number;
        policyHash: string;
        metadataHash: string | null;
        credentialHash: string | null;
      };
      const data = this.options.repository.get<CurrentData>("current");
      check(
        pin.repositoryIdentity === c.repositoryIdentity &&
          pin.generation === a.policy.policy.body.generation &&
          pin.policyHash === a.policy.commitment &&
          (!data ||
            data.policyHash !== a.policy.commitment ||
            (pin.metadataHash === data.metadataHash &&
              pin.credentialHash === data.credentialHash)),
        "key-unavailable",
      );
    } finally {
      read.value?.fill(0);
    }
  }
  state(): TeamStateView {
    const c = this.#config();
    let a: AcceptedTeamCheckpoint | null = null;
    try {
      if (c?.ownerSpki) a = this.#accepted(c);
    } catch {
      this.#fault = "reconcile";
    }
    const data = this.options.repository.get<CurrentData>("current");
    const role = c && a && !this.#denied ? this.#role(c, a) : null;
    const metadata =
      !this.#locked &&
      this.#materialized &&
      this.#materialized.policyHash === a?.policy.commitment
        ? this.#materialized.metadata
        : emptyMetadata();
    return {
      status: this.#locked
        ? "locked"
        : (this.#fault ??
          (!c
            ? "disabled"
            : c.phase !== "enrolled"
              ? "pending"
              : !role
                ? "revoked"
                : "enrolled")),
      endpoint: c?.endpoint ?? null,
      scope: c?.scope ?? null,
      principalId: c?.principalId ?? null,
      deviceId: c?.deviceId ?? null,
      role,
      generation: a?.policy.policy.body.generation ?? 0,
      metadataEpoch: a?.metadata.control.activeEpoch ?? 0,
      credentialEpoch:
        role && teamCanConnect(role)
          ? (a?.credentials.control.activeEpoch ?? 0)
          : 0,
      policyHash: a?.policy.commitment ?? null,
      metadataHash: data?.metadataHash ?? null,
      credentialHash: data?.credentialHash ?? null,
      ownerFingerprint: a
        ? fingerprint(a.policy.ownerKey)
        : c?.expectedOwnerFingerprint || null,
      canManage:
        !this.#locked &&
        !this.#fault &&
        role === "Owner" &&
        a?.policy.policy.body.ownerDeviceId === c?.deviceId &&
        !!c?.refs.owner,
      recoveryReady: !!this.options.repository.get("recoveryReady"),
      needsToken: !!c && !c.refs.token,
      pending:
        Number(!!this.options.repository.get("pendingPublication")) +
        Number(!!this.options.repository.get("pendingWrite")),
      hosts: metadata.hosts.map((host) => ({
        ...host,
        virtualHostId: this.options.repository.bind(
          c!.scope.teamId,
          host.recordId,
        ),
      })),
      members:
        a?.policy.policy.body.principals.map((p) => ({
          principalId: p.principalId,
          role: p.role,
          status: p.status,
          label:
            metadata.memberNames.find((n) => n.principalId === p.principalId)
              ?.label ?? p.principalId,
        })) ?? [],
      devices: a?.policy.policy.body.devices ?? [],
      warnings: [
        "Team sync is manual. New connections require online authorization.",
        "Revocation cannot erase copied keys or change the remote SSH password.",
      ],
    };
  }
  async #setup(
    input: {
      endpoint: string;
      token: string;
      principalId: string;
      expectedScope: TeamScope;
    },
    g: number,
  ): Promise<Configuration> {
    check(!this.#config(), "conflict");
    check(
      isTeamScope(input.expectedScope) &&
        syncUuid(input.principalId) &&
        syncBytes(input.token, 32, 32) &&
        validTeamEndpoint({ url: input.endpoint, scope: input.expectedScope }),
    );
    const c: Configuration = {
      endpoint: input.endpoint,
      scope: structuredClone(input.expectedScope),
      principalId: input.principalId,
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
    check(canonical(info.scope) === canonical(c.scope), "untrusted-authority");
    const keys = await this.#wait(generateDeviceKeys(), g);
    await this.#storeKey(c, "signing", "device-signing", keys.signingKey, g);
    await this.#storeKey(c, "wrapping", "device-wrapping", keys.wrappingKey, g);
    return c;
  }
  async #adoptPublic(
    c: Configuration,
    checkpoints: TeamPolicyCheckpoint[],
    ownerSpki: string,
    g: number,
  ): Promise<AcceptedTeamCheckpoint> {
    this.options.repository.set("pendingAdoption", { checkpoints, ownerSpki });
    let current = this.#accepted(c);
    const added: {
      checkpoint: TeamPolicyCheckpoint;
      accepted: AcceptedTeamCheckpoint;
    }[] = [];
    for (const checkpoint of checkpoints) {
      if (
        current &&
        checkpoint.policy.body.generation <=
          current.policy.policy.body.generation
      ) {
        check(
          this.options.repository
            .checkpoints()
            .some((row) => row.hash === teamPolicyHash(checkpoint.policy)),
          "untrusted-authority",
        );
        continue;
      }
      current = acceptTeamCheckpoint(
        checkpoint,
        c.scope,
        pub(ownerSpki),
        current ?? undefined,
      );
      added.push({ checkpoint, accepted: current });
    }
    check(current, "untrusted-authority");
    c.ownerSpki = ownerSpki;
    this.options.repository.set("configuration", c);
    const data = this.options.repository.get<CurrentData>("current");
    await this.#pin(
      c,
      current,
      {
        metadata:
          data?.policyHash === current.policy.commitment
            ? data.metadataHash
            : null,
        credentials:
          data?.policyHash === current.policy.commitment
            ? data.credentialHash
            : null,
      },
      g,
    );
    this.options.repository.transaction(() => {
      for (const row of added)
        this.options.repository.addCheckpoint({
          hash: row.accepted.policy.commitment,
          generation: row.accepted.policy.policy.body.generation,
          checkpoint: row.checkpoint,
        });
      this.options.repository.remove("pendingAdoption");
      if (added.length) this.options.repository.set("recoveryReady", false);
    });
    if (added.length) this.#notify(c, current);
    return current;
  }
  async #syncPolicies(
    c: Configuration,
    g: number,
  ): Promise<AcceptedTeamCheckpoint> {
    let current = this.#accepted(c);
    await this.#checkPin(c, current, g);
    let generation = current?.policy.policy.body.generation ?? 0;
    const bootstrap = !c.ownerSpki;
    const staged: {
      checkpoint: TeamPolicyCheckpoint;
      accepted: AcceptedTeamCheckpoint;
    }[] = [];
    let initialOwner = c.ownerSpki;
    for (let page = 0; page < 33; page++) {
      const response = this.#unwrap(
        await this.#wait(
          this.#transport(c, g).policies(generation, this.#abort.signal),
          g,
        ),
      );
      for (const checkpoint of response.checkpoints) {
        if (!initialOwner) initialOwner = checkpoint.policy.body.ownerSpki;
        const accepted = acceptTeamCheckpoint(
          checkpoint,
          c.scope,
          pub(initialOwner),
          current ?? undefined,
        );
        if (bootstrap) staged.push({ checkpoint, accepted });
        else {
          await this.#adoptPublic(c, [checkpoint], initialOwner, g);
        }
        current = accepted;
        generation = accepted.policy.policy.body.generation;
      }
      check(
        response.nextGeneration === generation &&
          (!response.hasMore || response.checkpoints.length > 0),
        "stale-control",
      );
      if (!response.hasMore) {
        check(current, "untrusted-authority");
        if (bootstrap) {
          check(
            fingerprint(current.policy.ownerKey) === c.expectedOwnerFingerprint,
            "untrusted-authority",
          );
          await this.#adoptPublic(
            c,
            staged.map((row) => row.checkpoint),
            initialOwner,
            g,
          );
        }
        return current;
      }
    }
    throw new TeamFault("too-large");
  }
  async #keys(
    c: Configuration,
    a: AcceptedTeamCheckpoint,
    g: number,
  ): Promise<Pick<Context, "signing" | "wrapping" | "owner">> {
    let signing: Buffer | null = null,
      wrapping: Buffer | null = null,
      owner: Buffer | null = null;
    try {
      signing = await this.#get(c, "signing", "device-signing", g);
      wrapping = await this.#get(c, "wrapping", "device-wrapping", g);
      if (a.policy.policy.body.ownerDeviceId === c.deviceId && c.refs.owner)
        owner = await this.#get(c, "owner", "owner-signing", g);
      return {
        signing: priv(signing),
        wrapping: priv(wrapping),
        owner: owner ? priv(owner) : null,
      };
    } finally {
      signing?.fill(0);
      wrapping?.fill(0);
      owner?.fill(0);
    }
  }
  #open(
    operation: SyncOperationPublication,
    accepted: AcceptedControl,
    epoch: Uint8Array,
  ): unknown {
    const { hash, header } = verifyTeamOperation(operation, accepted);
    check(hash === operationCommitment(bytes(operation.wire)), "invalid");
    const cert = accepted.certificates.find(
      (c) => c.deviceId === header.authorDeviceId,
    );
    check(cert, "untrusted-authority");
    const clear = openOperation(
      bytes(operation.wire),
      header,
      operation.parents,
      epoch,
      cert.signingKey,
    );
    try {
      const text = clear.toString("utf8");
      const parsed: unknown = JSON.parse(text);
      check(canonical(parsed) === text, "invalid");
      return parsed;
    } finally {
      clear.fill(0);
    }
  }
  async #epoch(
    c: Configuration,
    a: AcceptedControl,
    wraps: string[],
    wrapping: KeyObject,
    domain: "metadata" | "credentials",
    g: number,
  ): Promise<Buffer> {
    const slot = `${domain}/${a.control.activeEpoch}`;
    const kind = domain === "metadata" ? "metadata-epoch" : "credential-epoch";
    if (c.refs[slot]) return this.#get(c, slot, kind, g);
    for (const encoded of wraps) {
      const wire = bytes(encoded);
      const [raw] = unframe(wire, 3, 1024, 2048);
      const h = parseWrapHeader(raw);
      check(
        h.deploymentId === a.control.deploymentId &&
          h.accountId === a.control.accountId &&
          h.vaultId === a.control.vaultId &&
          h.controlHash === a.commitment &&
          h.recipientDeviceId === c.deviceId &&
          h.recipientFingerprint === fingerprint(wrapping),
        "untrusted-authority",
      );
      if (h.epoch !== a.control.activeEpoch) continue;
      const issuer = a.certificates.find(
        (cert) => cert.deviceId === h.issuerDeviceId,
      );
      check(
        issuer && fingerprint(issuer.signingKey) === h.issuerFingerprint,
        "untrusted-authority",
      );
      const key = unwrapEpoch(wire, h, wrapping, issuer.signingKey);
      try {
        await this.#put(c, slot, kind, key, g);
        return Buffer.from(key);
      } finally {
        key.fill(0);
      }
    }
    throw new TeamFault("key-unavailable");
  }
  /** Verify signed ancestry back to the last observed data head before moving OS pins or tombstones. */
  async #continuity(
    c: Configuration,
    domain: "metadata" | "credentials",
    operation: SyncOperationPublication,
    anchor: string | null,
    g: number,
  ): Promise<{ hash: string; operation: SyncOperationPublication }[]> {
    if (!anchor || operationCommitment(bytes(operation.wire)) === anchor)
      return [];
    const controls = new Map<string, AcceptedControl>();
    let accepted: AcceptedTeamCheckpoint | undefined;
    for (const row of this.options.repository.checkpoints()) {
      accepted = acceptTeamCheckpoint(
        row.checkpoint,
        c.scope,
        pub(c.ownerSpki),
        accepted,
      );
      controls.set(accepted[domain].commitment, accepted[domain]);
    }
    const seen = new Set<string>(),
      verified: { hash: string; operation: SyncOperationPublication }[] = [];
    let cursor = operation,
      total = 0;
    for (let n = 0; n < 256; n++) {
      const wire = bytes(cursor.wire),
        hash = operationCommitment(wire);
      check(!seen.has(hash), "stale-control");
      seen.add(hash);
      total += wire.length;
      check(total <= 64 * 1024 * 1024, "too-large");
      const [raw] = unframe(wire, 3, 1048576 + 16, 1048576 + 2048),
        header = parseDataHeader(raw),
        control = controls.get(header.controlHash);
      check(control, "untrusted-authority");
      verifyTeamOperation(cursor, control);
      check(cursor.parents.length === 1, "stale-control");
      // Verified ciphertext proofs can survive a rate-limited retry; they do not authorize data adoption.
      this.options.repository.addOperation(domain, hash, cursor);
      verified.push({ hash, operation: cursor });
      const parent = cursor.parents[0];
      if (parent === anchor) return verified;
      check(!seen.has(parent), "stale-control");
      cursor =
        this.options.repository.operation(domain, parent) ??
        this.#unwrap(
          await this.#wait(
            this.#transport(c, g).operation(domain, parent, this.#abort.signal),
            g,
          ),
        );
      check(
        operationCommitment(bytes(cursor.wire)) === parent,
        "untrusted-authority",
      );
    }
    throw new TeamFault("too-large");
  }
  async #context(g: number): Promise<Context> {
    const c = this.#config();
    check(c, "invalid");
    await this.#resume(c, g);
    let a = await this.#syncPolicies(c, g);
    const role = this.#role(c, a);
    check(role, "forbidden");
    const keys = await this.#keys(c, a, g);
    const response = this.#unwrap(
      await this.#wait(
        this.#transport(c, g).state(
          { knownPolicyHash: a.policy.commitment },
          this.#abort.signal,
        ),
        g,
      ),
    );
    if (teamPolicyHash(response.checkpoint.policy) !== a.policy.commitment) {
      a = await this.#syncPolicies(c, g);
      check(
        teamPolicyHash(response.checkpoint.policy) === a.policy.commitment,
        "stale-control",
      );
    }
    let metadataKey: Buffer | null = null,
      credentialKey: Buffer | null = null;
    try {
      metadataKey = await this.#epoch(
        c,
        a.metadata,
        response.metadataWraps,
        keys.wrapping,
        "metadata",
        g,
      );
      const metadata = this.#open(
        response.metadataSnapshot,
        a.metadata,
        metadataKey,
      );
      check(isTeamMetadataSnapshot(metadata));
      let credentials: TeamCredentialSnapshot | null = null;
      if (teamCanConnect(role)) {
        check(response.credentialSnapshot, "forbidden");
        credentialKey = await this.#epoch(
          c,
          a.credentials,
          response.credentialWraps,
          keys.wrapping,
          "credentials",
          g,
        );
        const clear = this.#open(
          response.credentialSnapshot,
          a.credentials,
          credentialKey,
        );
        check(isTeamCredentialSnapshot(clear));
        credentials = clear;
      } else
        check(
          response.credentialSnapshot === null &&
            response.credentialWraps.length === 0,
          "forbidden",
        );
      check(
        operationCommitment(bytes(response.metadataSnapshot.wire)) ===
          response.metadataHead &&
          (!response.credentialSnapshot ||
            operationCommitment(bytes(response.credentialSnapshot.wire)) ===
              response.credentialHead),
        "untrusted-authority",
      );
      const previous = this.options.repository.get<CurrentData>("current");
      const metadataHistory = await this.#continuity(
        c,
        "metadata",
        response.metadataSnapshot,
        previous?.metadataHash ?? null,
        g,
      );
      const credentialHistory = response.credentialSnapshot
        ? await this.#continuity(
            c,
            "credentials",
            response.credentialSnapshot,
            previous?.credentials ? previous.credentialHash : null,
            g,
          )
        : [];
      this.options.repository.set("pendingMaterialization", {
        policyHash: a.policy.commitment,
        metadataHash: response.metadataHead,
        credentialHash: response.credentialHead,
        metadata: response.metadataSnapshot,
        credentials: response.credentialSnapshot,
      });
      await this.#pin(
        c,
        a,
        {
          metadata: response.metadataHead,
          credentials: response.credentialHead,
        },
        g,
      );
      this.options.repository.transaction(() => {
        for (const row of metadataHistory)
          this.options.repository.addOperation(
            "metadata",
            row.hash,
            row.operation,
          );
        for (const row of credentialHistory)
          this.options.repository.addOperation(
            "credentials",
            row.hash,
            row.operation,
          );
        this.options.repository.addOperation(
          "metadata",
          response.metadataHead,
          response.metadataSnapshot,
        );
        if (response.credentialSnapshot)
          this.options.repository.addOperation(
            "credentials",
            response.credentialHead,
            response.credentialSnapshot,
          );
        this.options.repository.set("current", {
          policyHash: a.policy.commitment,
          metadataHash: response.metadataHead,
          credentialHash: response.credentialHead,
          metadata: response.metadataSnapshot,
          credentials: response.credentialSnapshot,
        });
        this.options.repository.remove("pendingMaterialization");
        this.options.repository.retireMissing(
          c.scope.teamId,
          metadata.hosts.map((h) => h.recordId),
        );
        for (const host of metadata.hosts)
          this.options.repository.bind(c.scope.teamId, host.recordId);
      });
      c.phase = "enrolled";
      this.options.repository.set("configuration", c);
      this.#materialized = {
        policyHash: a.policy.commitment,
        metadataHash: response.metadataHead,
        credentialHash: response.credentialHead,
        metadata,
      };
      this.#fault = null;
      this.options.repository.remove("accessDenied");
      this.#denied = false;
      const result: Context = {
        config: c,
        accepted: a,
        ...keys,
        epochs: { metadata: metadataKey, credentials: credentialKey },
        metadata,
        credentials,
        heads: {
          metadata: response.metadataHead,
          credentials: response.credentialHead,
        },
      };
      metadataKey = null;
      credentialKey = null;
      return result;
    } finally {
      metadataKey?.fill(0);
      credentialKey?.fill(0);
    }
  }
  #clear(ctx: Context): void {
    ctx.epochs.metadata.fill(0);
    ctx.epochs.credentials?.fill(0);
    ctx.credentials = null;
  }
  #requireOwner(ctx: Context): asserts ctx is Context & {
    owner: KeyObject;
    credentials: TeamCredentialSnapshot;
  } {
    check(
      this.#role(ctx.config, ctx.accepted) === "Owner" &&
        ctx.accepted.policy.policy.body.ownerDeviceId === ctx.config.deviceId &&
        ctx.owner &&
        ctx.credentials,
      "forbidden",
    );
  }
  #seal(
    snapshot: TeamMetadataSnapshot | TeamCredentialSnapshot,
    accepted: AcceptedControl,
    c: Configuration,
    signing: KeyObject,
    epoch: Uint8Array,
    parent: string | null,
  ): SyncOperationPublication {
    const plain = Buffer.from(canonical(snapshot));
    const parents = parent ? [parent] : [];
    try {
      const wire = sealOperation(
        {
          deploymentId: accepted.control.deploymentId,
          accountId: accepted.control.accountId,
          vaultId: accepted.control.vaultId,
          epoch: accepted.control.activeEpoch,
          operationId: randomUUID(),
          authorDeviceId: c.deviceId,
          controlHash: accepted.commitment,
          parentsDigest: parentsDigest(parents),
          ...freshEntropy(),
          plaintextLength: plain.length,
        },
        parents,
        epoch,
        plain,
        signing,
      );
      return { wire: b64(wire), parents };
    } finally {
      plain.fill(0);
    }
  }
  #domainControl(
    c: Configuration,
    domain: "metadata" | "credentials",
    old: AcceptedControl | null,
    certificates: Certificate[],
    owner: KeyObject,
    oldOwner: KeyObject,
    signing: KeyObject,
    epoch: number,
    epochKey: Uint8Array,
    proofs: string[] = [],
    recovery: { descriptor: string; wire: string } | null = null,
  ): SyncControlPublication {
    const scope =
      domain === "metadata"
        ? teamMetadataScope(c.scope)
        : teamCredentialScope(c.scope);
    const generation = old ? old.control.generation + 1 : 1;
    const roster = rosterBytes(
      sorted(certificates, "deviceId").map((cert) =>
        sealCertificate(
          { ...cert, ...scope, ownerFingerprint: fingerprint(owner) },
          owner,
        ),
      ),
    );
    const control = sealControl(
      {
        ...scope,
        generation,
        previousHash: old?.commitment ?? SYNC_ZERO,
        previousOwnerFingerprint: fingerprint(oldOwner),
        newOwnerKey: owner,
        ownerDeviceId: c.deviceId,
        activeEpoch: epoch,
        rosterDigest: rosterCommitment(roster),
        recoveryDescriptorDigest: recovery
          ? recoveryDescriptorDigest(bytes(recovery.descriptor))
          : SYNC_ZERO,
      },
      oldOwner,
      owner,
    );
    const controlHash = controlCommitment(control);
    const wraps = certificates.map((cert) =>
      b64(
        wrapEpoch(
          {
            ...scope,
            epoch,
            recipientDeviceId: cert.deviceId,
            recipientFingerprint: fingerprint(cert.wrappingKey),
            issuerDeviceId: c.deviceId,
            issuerFingerprint: fingerprint(signing),
            controlHash,
          },
          epochKey,
          cert.wrappingKey,
          signing,
        ),
      ),
    );
    return {
      controlWire: b64(control),
      rosterWire: b64(roster),
      wraps,
      recoveryDescriptorWire: recovery?.descriptor ?? null,
      recoveryWire: recovery?.wire ?? null,
      enrollmentProofs: proofs,
    };
  }
  #prepare(
    ctx: Context,
    input: {
      principals?: TeamPrincipal[];
      devices?: TeamDevice[];
      metadata?: TeamMetadataSnapshot;
      credentials?: TeamCredentialSnapshot;
      rotate?: boolean;
      newOwner?: KeyObject;
      metadataCerts?: Certificate[];
      credentialCerts?: Certificate[];
      proofs?: string[];
      recovery?: {
        kit: TeamRecoveryKit;
        metadataDescriptor: string;
        credentialDescriptor: string;
      };
      recoveryAdmission?: { metadata: string; credentials: string };
    },
  ): {
    request: TeamPublishRequest;
    epochKeys: { metadata: Buffer; credentials: Buffer };
  } {
    if (input.recoveryAdmission)
      check(
        ctx.owner &&
          ctx.credentials &&
          ctx.config.principalId ===
            ctx.accepted.policy.policy.body.ownerPrincipalId &&
          fingerprint(ctx.owner) === fingerprint(ctx.accepted.policy.ownerKey),
        "forbidden",
      );
    else this.#requireOwner(ctx);
    const old = ctx.accepted.policy.policy.body;
    const owner = input.newOwner ?? ctx.owner!;
    const epochKeys = {
      metadata: input.rotate
        ? generateEpochKey()
        : Buffer.from(ctx.epochs.metadata),
      credentials: input.rotate
        ? generateEpochKey()
        : Buffer.from(ctx.epochs.credentials!),
    };
    try {
      const devices = sorted(input.devices ?? old.devices, "deviceId"),
        principals = sorted(input.principals ?? old.principals, "principalId");
      const certs = (domain: "metadata" | "credentials"): Certificate[] => {
        const explicit =
          domain === "metadata" ? input.metadataCerts : input.credentialCerts;
        if (explicit) return explicit;
        const previous =
          domain === "metadata"
            ? ctx.accepted.metadata
            : ctx.accepted.credentials;
        return devices
          .filter(
            (d) =>
              domain === "metadata" ||
              principals.find((p) => p.principalId === d.principalId)!.role !==
                "Viewer",
          )
          .map((d) => {
            const p = principals.find((p) => p.principalId === d.principalId)!;
            const certificate = previous.certificates.find(
              (cert) => cert.deviceId === d.deviceId,
            );
            check(certificate, "invalid");
            return {
              ...certificate,
              role: cryptoRole(p.role, domain),
              ownerFingerprint: fingerprint(owner),
            };
          });
      };
      const metadataControl = this.#domainControl(
        ctx.config,
        "metadata",
        ctx.accepted.metadata,
        certs("metadata"),
        owner,
        ctx.owner!,
        ctx.signing,
        ctx.accepted.metadata.control.activeEpoch + (input.rotate ? 1 : 0),
        epochKeys.metadata,
        input.proofs,
        input.recovery
          ? {
              descriptor: input.recovery.metadataDescriptor,
              wire: input.recovery.kit.metadataRecoveryWire,
            }
          : null,
      );
      const credentialControl = this.#domainControl(
        ctx.config,
        "credentials",
        ctx.accepted.credentials,
        certs("credentials"),
        owner,
        ctx.owner!,
        ctx.signing,
        ctx.accepted.credentials.control.activeEpoch + (input.rotate ? 1 : 0),
        epochKeys.credentials,
        (input.proofs ?? []).filter((proof) => {
          const [body] = unframe(bytes(proof), 4, 1536, 4096);
          const e = parseEnrollmentBody(body);
          return certs("credentials").some(
            (cert) => cert.deviceId === e.newDeviceId,
          );
        }),
        input.recovery
          ? {
              descriptor: input.recovery.credentialDescriptor,
              wire: input.recovery.kit.credentialRecoveryWire,
            }
          : null,
      );
      const body: TeamPolicy = {
        ...old,
        generation: old.generation + 1,
        previousHash: ctx.accepted.policy.commitment,
        previousOwnerFingerprint: fingerprint(ctx.owner!),
        ownerSpki: spki(owner),
        ownerDeviceId: ctx.config.deviceId,
        principals,
        devices,
        metadataControlHash: controlCommitment(
          bytes(metadataControl.controlWire),
        ),
        credentialControlHash: controlCommitment(
          bytes(credentialControl.controlWire),
        ),
      };
      const policy = sealTeamPolicy(body, ctx.owner!, owner);
      const checkpoint = { policy, metadataControl, credentialControl };
      const accepted = acceptTeamCheckpoint(
        checkpoint,
        ctx.config.scope,
        pub(ctx.config.ownerSpki),
        ctx.accepted,
      );
      const metadata = input.metadata ?? ctx.metadata,
        credentials = input.credentials ?? ctx.credentials;
      check(
        isTeamMetadataSnapshot(metadata) &&
          isTeamCredentialSnapshot(credentials),
      );
      const request: TeamPublishRequest = {
        expectedPolicyHash: ctx.accepted.policy.commitment,
        expectedMetadataHash: ctx.heads.metadata,
        expectedCredentialHash: ctx.heads.credentials,
        publication: {
          policy,
          metadata: {
            control: metadataControl,
            snapshot: this.#seal(
              metadata,
              accepted.metadata,
              ctx.config,
              ctx.signing,
              epochKeys.metadata,
              ctx.heads.metadata,
            ),
          },
          credentials: {
            control: credentialControl,
            snapshot: this.#seal(
              credentials,
              accepted.credentials,
              ctx.config,
              ctx.signing,
              epochKeys.credentials,
              ctx.heads.credentials,
            ),
          },
          recovery: input.recovery?.kit ?? null,
        },
      };
      return { request, epochKeys };
    } catch (error) {
      epochKeys.metadata.fill(0);
      epochKeys.credentials.fill(0);
      throw error;
    }
  }
  async #stageEpochs(
    c: Configuration,
    request: TeamPublishRequest,
    keys: { metadata: Buffer; credentials: Buffer },
    g: number,
  ): Promise<void> {
    const p = request.publication;
    const checkpoints = this.#accepted(c);
    const a = acceptTeamCheckpoint(
      {
        policy: p.policy,
        metadataControl: p.metadata.control,
        credentialControl: p.credentials.control,
      },
      c.scope,
      pub(c.ownerSpki),
      checkpoints ?? undefined,
    );
    await this.#put(
      c,
      `metadata/${a.metadata.control.activeEpoch}`,
      "metadata-epoch",
      keys.metadata,
      g,
    );
    await this.#put(
      c,
      `credentials/${a.credentials.control.activeEpoch}`,
      "credential-epoch",
      keys.credentials,
      g,
    );
  }
  async #commitPublication(
    c: Configuration,
    pending: PendingPublication,
    g: number,
  ): Promise<void> {
    const request = pending.request,
      p = request.publication;
    this.options.repository.set("pendingPublication", pending);
    const receipt = this.#unwrap(
      await this.#wait(
        this.#transport(c, g).publish(request, this.#abort.signal),
        g,
      ),
    );
    const hash = teamPolicyHash(p.policy),
      metadataHash = operationCommitment(bytes(p.metadata.snapshot.wire)),
      credentialHash = operationCommitment(bytes(p.credentials.snapshot.wire));
    check(
      receipt.policyHash === hash &&
        receipt.generation === p.policy.body.generation &&
        receipt.metadataHash === metadataHash &&
        receipt.credentialHash === credentialHash,
      "untrusted-authority",
    );
    const current = this.#accepted(c);
    const checkpoint = {
      policy: p.policy,
      metadataControl: { ...p.metadata.control, wraps: [], recoveryWire: null },
      credentialControl: {
        ...p.credentials.control,
        wraps: [],
        recoveryWire: null,
      },
    };
    const accepted =
      current?.policy.commitment === hash
        ? current
        : acceptTeamCheckpoint(
            checkpoint,
            c.scope,
            pub(c.ownerSpki),
            current ?? undefined,
          );
    await this.#pin(
      c,
      accepted,
      { metadata: metadataHash, credentials: credentialHash },
      g,
    );
    this.options.repository.transaction(() => {
      this.options.repository.addCheckpoint({
        hash,
        generation: receipt.generation,
        checkpoint,
      });
      this.options.repository.addOperation(
        "metadata",
        metadataHash,
        p.metadata.snapshot,
      );
      this.options.repository.addOperation(
        "credentials",
        credentialHash,
        p.credentials.snapshot,
      );
      this.options.repository.set("current", {
        policyHash: hash,
        metadataHash,
        credentialHash,
        metadata: p.metadata.snapshot,
        credentials: p.credentials.snapshot,
      });
      this.options.repository.set(
        "recoveryReady",
        pending.recoveryReady ?? false,
      );
      this.options.repository.remove("pendingPublication");
      if (pending.invitation)
        this.options.repository.set("invitationReady", pending.invitation);
    });
    c.phase = "enrolled";
    this.options.repository.set("configuration", c);
    this.options.repository.remove("accessDenied");
    this.#denied = false;
    this.#notify(c, accepted);
  }
  async #publishPrepared(
    ctx: Context,
    prepared: {
      request: TeamPublishRequest;
      epochKeys: { metadata: Buffer; credentials: Buffer };
    },
    g: number,
    extra: Pick<PendingPublication, "invitation" | "recoveryReady"> = {},
  ): Promise<void> {
    try {
      this.options.repository.set("pendingPublication", {
        request: prepared.request,
        ...extra,
      });
      await this.#stageEpochs(
        ctx.config,
        prepared.request,
        prepared.epochKeys,
        g,
      );
      await this.#commitPublication(
        ctx.config,
        { request: prepared.request, ...extra },
        g,
      );
    } finally {
      prepared.epochKeys.metadata.fill(0);
      prepared.epochKeys.credentials.fill(0);
    }
  }
  async #restoreStagedEpochs(
    c: Configuration,
    pending: PendingPublication,
    g: number,
  ): Promise<void> {
    const p = pending.request.publication,
      current = this.#accepted(c);
    const accepted =
      current?.policy.commitment === teamPolicyHash(p.policy)
        ? current
        : acceptTeamCheckpoint(
            {
              policy: p.policy,
              metadataControl: p.metadata.control,
              credentialControl: p.credentials.control,
            },
            c.scope,
            pub(c.ownerSpki),
            current ?? undefined,
          );
    const raw = await this.#get(c, "wrapping", "device-wrapping", g);
    try {
      const wrapping = priv(raw);
      for (const domain of ["metadata", "credentials"] as const) {
        const a = accepted[domain],
          publication =
            domain === "metadata" ? p.metadata.control : p.credentials.control,
          kind = domain === "metadata" ? "metadata-epoch" : "credential-epoch",
          slot = `${domain}/${a.control.activeEpoch}`;
        const encoded = publication.wraps.find((wire) => {
          const [header] = unframe(bytes(wire), 3, 1024, 2048);
          return parseWrapHeader(header).recipientDeviceId === c.deviceId;
        });
        check(encoded, "key-unavailable");
        const wire = bytes(encoded),
          [header] = unframe(wire, 3, 1024, 2048),
          h = parseWrapHeader(header),
          issuer = a.certificates.find(
            (cert) => cert.deviceId === h.issuerDeviceId,
          );
        check(issuer, "untrusted-authority");
        const epoch = unwrapEpoch(wire, h, wrapping, issuer.signingKey);
        try {
          await this.#put(c, slot, kind, epoch, g);
        } finally {
          epoch.fill(0);
        }
      }
    } finally {
      raw.fill(0);
    }
  }
  async #resumeDeviceAdmission(c: Configuration, g: number): Promise<void> {
    const pending = this.options.repository.get<{
      predecessor: Configuration;
      deviceId: string;
      policyHash: string;
    }>("pendingDeviceAdmission");
    if (!pending) return;
    const accepted = this.#accepted(c);
    check(
      accepted &&
        accepted.policy.commitment === pending.policyHash &&
        c.deviceId === pending.deviceId,
      "key-unavailable",
    );
    const data = this.options.repository.get<CurrentData>("current");
    await this.#pin(
      c,
      accepted,
      {
        metadata:
          data?.policyHash === accepted.policy.commitment
            ? data.metadataHash
            : null,
        credentials:
          data?.policyHash === accepted.policy.commitment
            ? data.credentialHash
            : null,
      },
      g,
      pending.predecessor,
    );
    this.options.repository.remove("pendingDeviceAdmission");
  }
  async #resume(c: Configuration, g: number): Promise<void> {
    await this.#resumeDeviceAdmission(c, g);
    const adoption = this.options.repository.get<{
      checkpoints: TeamPolicyCheckpoint[];
      ownerSpki: string;
    }>("pendingAdoption");
    if (adoption)
      await this.#adoptPublic(c, adoption.checkpoints, adoption.ownerSpki, g);
    const publication =
      this.options.repository.get<PendingPublication>("pendingPublication");
    if (publication) {
      await this.#restoreStagedEpochs(c, publication, g);
      await this.#commitPublication(c, publication, g);
    }
    const write = this.options.repository.get<PendingWrite>("pendingWrite");
    if (write) await this.#commitWrite(c, write, g);
    const materialized = this.options.repository.get<CurrentData>(
      "pendingMaterialization",
    );
    if (materialized) {
      const a = this.#accepted(c);
      check(
        a && a.policy.commitment === materialized.policyHash,
        "stale-control",
      );
      await this.#pin(
        c,
        a,
        {
          metadata: materialized.metadataHash,
          credentials: materialized.credentialHash,
        },
        g,
      );
      this.options.repository.transaction(() => {
        this.options.repository.addOperation(
          "metadata",
          materialized.metadataHash,
          materialized.metadata,
        );
        if (materialized.credentials)
          this.options.repository.addOperation(
            "credentials",
            materialized.credentialHash,
            materialized.credentials,
          );
        this.options.repository.set("current", materialized);
        this.options.repository.remove("pendingMaterialization");
      });
    }
  }
  create(input: {
    endpoint: string;
    token: string;
    principalId: string;
    expectedScope: TeamScope;
    displayName?: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const c = await this.#setup(input, g),
        owner = generateSigningKey();
      c.ownerSpki = spki(owner);
      c.expectedOwnerFingerprint = fingerprint(owner);
      this.options.repository.set("configuration", c);
      await this.#storeKey(c, "owner", "owner-signing", owner, g);
      const rawSigning = await this.#get(c, "signing", "device-signing", g),
        rawWrapping = await this.#get(c, "wrapping", "device-wrapping", g),
        keys = {
          metadata: generateEpochKey(),
          credentials: generateEpochKey(),
        };
      try {
        const signing = priv(rawSigning),
          wrapping = priv(rawWrapping);
        const makeCert = (domain: "metadata" | "credentials"): Certificate => ({
          ...(domain === "metadata"
            ? teamMetadataScope(c.scope)
            : teamCredentialScope(c.scope)),
          deviceId: c.deviceId,
          signingKey: createPublicKey(signing),
          wrappingKey: createPublicKey(wrapping),
          role: "owner",
          enrollmentHash: SYNC_ZERO,
          ownerFingerprint: fingerprint(owner),
          firstGeneration: 1,
        });
        const metadataControl = this.#domainControl(
            c,
            "metadata",
            null,
            [makeCert("metadata")],
            owner,
            owner,
            signing,
            1,
            keys.metadata,
          ),
          credentialControl = this.#domainControl(
            c,
            "credentials",
            null,
            [makeCert("credentials")],
            owner,
            owner,
            signing,
            1,
            keys.credentials,
          );
        const body: TeamPolicy = {
          format: "ssterm-team-policy-v1",
          scope: c.scope,
          generation: 1,
          previousHash: SYNC_ZERO,
          previousOwnerFingerprint: fingerprint(owner),
          ownerSpki: spki(owner),
          ownerPrincipalId: c.principalId,
          ownerDeviceId: c.deviceId,
          metadataControlHash: controlCommitment(
            bytes(metadataControl.controlWire),
          ),
          credentialControlHash: controlCommitment(
            bytes(credentialControl.controlWire),
          ),
          principals: [
            {
              principalId: c.principalId,
              role: "Owner",
              status: "active",
              tokenHash: sha(bytes(input.token)),
            },
          ],
          devices: [{ deviceId: c.deviceId, principalId: c.principalId }],
        };
        const policy = sealTeamPolicy(body, owner, owner),
          accepted = acceptTeamCheckpoint(
            { policy, metadataControl, credentialControl },
            c.scope,
            owner,
          );
        const metadata = emptyMetadata();
        if (input.displayName)
          metadata.memberNames = [
            { principalId: c.principalId, label: input.displayName },
          ];
        check(isTeamMetadataSnapshot(metadata));
        const request: TeamPublishRequest = {
          expectedPolicyHash: null,
          expectedMetadataHash: null,
          expectedCredentialHash: null,
          publication: {
            policy,
            metadata: {
              control: metadataControl,
              snapshot: this.#seal(
                metadata,
                accepted.metadata,
                c,
                signing,
                keys.metadata,
                null,
              ),
            },
            credentials: {
              control: credentialControl,
              snapshot: this.#seal(
                emptyCredentials(),
                accepted.credentials,
                c,
                signing,
                keys.credentials,
                null,
              ),
            },
            recovery: null,
          },
        };
        this.options.repository.set("pendingPublication", { request });
        await this.#stageEpochs(c, request, keys, g);
        await this.#commitPublication(c, { request }, g);
        this.#materialized = {
          policyHash: accepted.policy.commitment,
          metadataHash: operationCommitment(
            bytes(request.publication.metadata.snapshot.wire),
          ),
          credentialHash: operationCommitment(
            bytes(request.publication.credentials.snapshot.wire),
          ),
          metadata,
        };
        return this.state();
      } finally {
        rawSigning.fill(0);
        rawWrapping.fill(0);
        keys.metadata.fill(0);
        keys.credentials.fill(0);
      }
    });
  }
  async #restoreMetadata(g: number): Promise<void> {
    const c = this.#config();
    if (!c || this.#denied) return;
    const a = this.#accepted(c);
    if (!a || !this.#role(c, a)) return;
    await this.#checkPin(c, a, g);
    const data = this.options.repository.get<CurrentData>("current");
    if (!data || data.policyHash !== a.policy.commitment) return;
    check(
      operationCommitment(bytes(data.metadata.wire)) === data.metadataHash,
      "untrusted-authority",
    );
    const epoch = await this.#get(
      c,
      `metadata/${a.metadata.control.activeEpoch}`,
      "metadata-epoch",
      g,
    );
    try {
      const metadata = this.#open(data.metadata, a.metadata, epoch);
      check(isTeamMetadataSnapshot(metadata));
      this.#materialized = {
        policyHash: a.policy.commitment,
        metadataHash: data.metadataHash,
        credentialHash: data.credentialHash,
        metadata,
      };
    } finally {
      epoch.fill(0);
    }
  }
  restore(): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      await this.#restoreMetadata(g);
      return this.state();
    });
  }
  fetch(): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      let ctx: Context | null = null;
      try {
        ctx = await this.#context(g);
        return this.state();
      } catch (error) {
        if (error instanceof TeamFault && error.code === "unavailable")
          await this.#restoreMetadata(g);
        throw error;
      } finally {
        if (ctx) this.#clear(ctx);
      }
    });
  }
  finishJoin(): Promise<TeamResult<TeamStateView>> {
    return this.fetch();
  }
  async #issueInvitation(
    ctx: Context,
    principalId: string,
    slot: string,
    g: number,
  ): Promise<TeamInvitation> {
    const token = await this.#get(ctx.config, slot, "invitation-token", g);
    try {
      const invitation = {
        principalId,
        token: b64(token),
        scope: ctx.config.scope,
        ownerFingerprint: fingerprint(ctx.accepted.policy.ownerKey),
        endpoint: ctx.config.endpoint,
      };
      this.options.repository.remove("invitationReady");
      return invitation;
    } finally {
      token.fill(0);
    }
  }
  invitePrincipal(input: {
    label: string;
    role: Exclude<TeamRole, "Owner">;
  }): Promise<TeamResult<TeamInvitation>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        check(["Editor", "Connector", "Viewer"].includes(input.role));
        const ready = this.options.repository.get<{
          principalId: string;
          slot: string;
        }>("invitationReady");
        if (ready)
          return this.#issueInvitation(ctx, ready.principalId, ready.slot, g);
        const principalId = randomUUID(),
          token = randomBytes(32),
          slot = `invitation/${principalId}`;
        try {
          await this.#put(ctx.config, slot, "invitation-token", token, g);
          const principals = [
            ...ctx.accepted.policy.policy.body.principals,
            {
              principalId,
              role: input.role,
              status: "active" as const,
              tokenHash: sha(token),
            },
          ];
          const metadata = {
            ...ctx.metadata,
            memberNames: sorted(
              [
                ...ctx.metadata.memberNames,
                { principalId, label: input.label },
              ],
              "principalId",
            ),
          };
          check(isTeamMetadataSnapshot(metadata));
          const prepared = this.#prepare(ctx, { principals, metadata });
          await this.#publishPrepared(ctx, prepared, g, {
            invitation: { principalId, slot },
          });
          return this.#issueInvitation(ctx, principalId, slot, g);
        } finally {
          token.fill(0);
        }
      } finally {
        this.#clear(ctx);
      }
    });
  }
  reissuePrincipalToken(input: {
    principalId: string;
    expectedPolicyHash: string;
  }): Promise<TeamResult<TeamInvitation>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        check(
          input.expectedPolicyHash === ctx.accepted.policy.commitment,
          "conflict",
        );
        const principal = ctx.accepted.policy.policy.body.principals.find(
          (p) =>
            p.principalId === input.principalId &&
            p.status === "active" &&
            p.role !== "Owner",
        );
        check(principal, "forbidden");
        const token = randomBytes(32),
          slot = `invitation/${principal.principalId}/${randomUUID()}`;
        try {
          await this.#put(ctx.config, slot, "invitation-token", token, g);
          const principals = ctx.accepted.policy.policy.body.principals.map(
            (p) =>
              p.principalId === principal.principalId
                ? { ...p, tokenHash: sha(token) }
                : p,
          );
          await this.#publishPrepared(
            ctx,
            this.#prepare(ctx, { principals }),
            g,
            { invitation: { principalId: principal.principalId, slot } },
          );
          return this.#issueInvitation(ctx, principal.principalId, slot, g);
        } finally {
          token.fill(0);
        }
      } finally {
        this.#clear(ctx);
      }
    });
  }
  beginJoin(input: {
    endpoint: string;
    token: string;
    principalId: string;
    expectedScope: TeamScope;
    expectedOwnerFingerprint: string;
  }): Promise<TeamResult<{ candidateText: string }>> {
    return this.#run(async (g) => {
      check(syncHash(input.expectedOwnerFingerprint));
      let c = this.#config();
      if (c) {
        check(
          c.endpoint === input.endpoint &&
            canonical(c.scope) === canonical(input.expectedScope) &&
            c.principalId === input.principalId,
          "untrusted-authority",
        );
        await this.#checkPin(c, this.#accepted(c), g);
        await this.#replaceTransportToken(c, input.token, g);
        await this.#resume(c, g);
        const accepted = await this.#syncPolicies(c, g);
        check(
          fingerprint(accepted.policy.ownerKey) ===
            input.expectedOwnerFingerprint,
          "untrusted-authority",
        );
        check(!this.#role(c, accepted), "conflict");
        check(
          accepted.policy.policy.body.principals.some(
            (p) =>
              p.principalId === c!.principalId &&
              p.status === "active" &&
              p.role !== "Owner",
          ),
          "forbidden",
        );
        check(syncBytes(input.token, 32, 32));
        const predecessor = c;
        c = {
          ...c,
          expectedOwnerFingerprint: input.expectedOwnerFingerprint,
          deviceId: randomUUID(),
          phase: "joining",
          refs: {},
        };
        this.options.repository.set("pendingDeviceAdmission", {
          predecessor,
          deviceId: c.deviceId,
          policyHash: accepted.policy.commitment,
        });
        this.options.repository.set("configuration", c);
        await this.#resumeDeviceAdmission(c, g);
        const token = bytes(input.token);
        try {
          await this.#put(c, "token", "transport-token", token, g);
        } finally {
          token.fill(0);
        }
        const keys = await this.#wait(generateDeviceKeys(), g);
        await this.#storeKey(
          c,
          "signing",
          "device-signing",
          keys.signingKey,
          g,
        );
        await this.#storeKey(
          c,
          "wrapping",
          "device-wrapping",
          keys.wrappingKey,
          g,
        );
        const data = this.options.repository.get<CurrentData>("current");
        await this.#pin(
          c,
          accepted,
          {
            metadata:
              data?.policyHash === accepted.policy.commitment
                ? data.metadataHash
                : null,
            credentials:
              data?.policyHash === accepted.policy.commitment
                ? data.credentialHash
                : null,
          },
          g,
        );
      } else {
        c = await this.#setup(input, g);
        c.phase = "joining";
        c.expectedOwnerFingerprint = input.expectedOwnerFingerprint;
        this.options.repository.set("configuration", c);
      }
      const a = await this.#syncPolicies(c, g);
      const p = a.policy.policy.body.principals.find(
        (p) => p.principalId === c!.principalId && p.status === "active",
      );
      check(p && p.role !== "Owner", "forbidden");
      const keys = await this.#keys(c, a, g);
      return {
        candidateText: canonical({
          format: "ssterm-team-candidate-v1",
          scope: c.scope,
          principalId: c.principalId,
          role: p.role,
          basePolicyHash: a.policy.commitment,
          newDeviceId: c.deviceId,
          signingSpki: spki(keys.signing),
          wrappingSpki: spki(keys.wrapping),
        }),
      };
    });
  }
  challengeEnrollment(input: {
    candidateText: string;
    principalId: string;
    role: Exclude<TeamRole, "Owner">;
  }): Promise<
    TeamResult<{
      challengeText: string;
      requestId: string;
      fingerprint: string;
      expiresAt: number;
    }>
  > {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        check(this.#approvals.size < 16, "busy");
        const candidate = textObject(input.candidateText);
        check(
          syncObject(candidate, [
            "format",
            "scope",
            "principalId",
            "role",
            "basePolicyHash",
            "newDeviceId",
            "signingSpki",
            "wrappingSpki",
          ]) && candidate.format === "ssterm-team-candidate-v1",
        );
        const principal = ctx.accepted.policy.policy.body.principals.find(
          (p) => p.principalId === input.principalId && p.status === "active",
        );
        check(
          principal &&
            principal.role !== "Owner" &&
            principal.role === input.role &&
            candidate.principalId === principal.principalId &&
            candidate.role === principal.role,
          "forbidden",
        );
        check(
          canonical(candidate.scope) === canonical(ctx.config.scope) &&
            candidate.basePolicyHash === ctx.accepted.policy.commitment,
          "stale-control",
        );
        check(
          syncUuid(candidate.newDeviceId) &&
            syncBytes(candidate.signingSpki, 44, 44) &&
            syncBytes(candidate.wrappingSpki, 422, 422),
        );
        const request = {
          ...teamMetadataScope(ctx.config.scope),
          requestId: randomUUID(),
          newDeviceId: candidate.newDeviceId,
          signingKey: pub(candidate.signingSpki),
          wrappingKey: pub(candidate.wrappingSpki),
          requestedRole: cryptoRole(principal.role, "metadata"),
          issuerOwnerFingerprint: fingerprint(ctx.owner),
          baseControlHash: ctx.accepted.metadata.commitment,
          nonce: randomBytes(32).toString("hex"),
          expiresAtUnix: Math.floor(this.#now() / 1000) + 300,
        };
        const body = enrollmentBody(request),
          secret = randomBytes(32),
          challenge = challengeCrypto(request, secret),
          existingFingerprint = enrollmentHash(body, challenge),
          fp = teamEnrollmentHash(
            ctx.config.scope.teamId,
            principal.principalId,
            principal.role,
            ctx.accepted.policy.commitment,
            existingFingerprint,
          );
        this.options.repository.markEnrollment(request.requestId, "pending");
        this.options.repository.markEnrollment(request.nonce, "pending");
        const timer = setTimeout(() => {
          this.#consumeApproval(request.requestId, "cancelled");
        }, 300_000);
        timer.unref();
        this.#approvals.set(request.requestId, {
          principalId: principal.principalId,
          role: principal.role,
          policyHash: ctx.accepted.policy.commitment,
          fingerprint: fp,
          body,
          challenge,
          approval: {
            enrollmentHash: existingFingerprint,
            challengeSecret: secret,
            nowUnix: Math.floor(this.#now() / 1000),
            monotonicNow: this.#monotonic(),
            monotonicDeadline: this.#monotonic() + 300,
            used: false,
          },
          timer,
        });
        return {
          challengeText: canonical({
            format: "ssterm-team-challenge-v1",
            principalId: principal.principalId,
            role: principal.role,
            basePolicyHash: ctx.accepted.policy.commitment,
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
  #consumeApproval(requestId: string, state: "used" | "cancelled"): void {
    const pending = this.#approvals.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.approval.challengeSecret.fill(0);
    pending.approval.used = true;
    const e = parseEnrollmentBody(pending.body);
    this.options.repository.transaction(() => {
      this.options.repository.markEnrollment(e.requestId, state);
      this.options.repository.markEnrollment(e.nonce, state);
    });
    this.#approvals.delete(requestId);
  }
  proveEnrollment(input: {
    challengeText: string;
  }): Promise<TeamResult<{ proofText: string; fingerprint: string }>> {
    return this.#run(async (g) => {
      const c = this.#config();
      check(c && c.phase === "joining", "conflict");
      const a = await this.#syncPolicies(c, g),
        keys = await this.#keys(c, a, g);
      const raw = textObject(input.challengeText);
      check(
        syncObject(raw, [
          "format",
          "principalId",
          "role",
          "basePolicyHash",
          "body",
          "challenge",
        ]) &&
          raw.format === "ssterm-team-challenge-v1" &&
          raw.principalId === c.principalId &&
          raw.basePolicyHash === a.policy.commitment &&
          typeof raw.body === "string" &&
          typeof raw.challenge === "string",
      );
      const principal = a.policy.policy.body.principals.find(
        (p) => p.principalId === c.principalId && p.status === "active",
      );
      check(
        principal && principal.role !== "Owner" && raw.role === principal.role,
        "forbidden",
      );
      const body = bytes(raw.body),
        challenge = bytes(raw.challenge),
        e = parseEnrollmentBody(body);
      check(
        e.newDeviceId === c.deviceId &&
          e.baseControlHash === a.metadata.commitment &&
          e.issuerOwnerFingerprint === fingerprint(a.policy.ownerKey) &&
          canonical({
            deploymentId: e.deploymentId,
            accountId: e.accountId,
            vaultId: e.vaultId,
          }) === canonical(teamMetadataScope(c.scope)) &&
          e.requestedRole === cryptoRole(principal.role, "metadata") &&
          fingerprint(e.signingKey) === fingerprint(keys.signing) &&
          fingerprint(e.wrappingKey) === fingerprint(keys.wrapping),
        "untrusted-authority",
      );
      check(
        e.expiresAtUnix > Math.floor(this.#now() / 1000) &&
          e.expiresAtUnix <= Math.floor(this.#now() / 1000) + 300,
        "stale-control",
      );
      const wire = proveCrypto(body, challenge, keys.signing, keys.wrapping),
        fp = teamEnrollmentHash(
          c.scope.teamId,
          c.principalId,
          principal.role,
          a.policy.commitment,
          enrollmentHash(body, challenge),
        );
      return {
        proofText: canonical({
          format: "ssterm-team-proof-v1",
          principalId: c.principalId,
          role: principal.role,
          basePolicyHash: a.policy.commitment,
          wire: b64(wire),
        }),
        fingerprint: fp,
      };
    });
  }
  approveEnrollment(input: {
    proofText: string;
    confirmedFingerprint: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        const raw = textObject(input.proofText);
        check(
          syncObject(raw, [
            "format",
            "principalId",
            "role",
            "basePolicyHash",
            "wire",
          ]) &&
            raw.format === "ssterm-team-proof-v1" &&
            typeof raw.wire === "string",
        );
        const wire = bytes(raw.wire),
          [body] = unframe(wire, 4, 1536, 4096),
          e = parseEnrollmentBody(body),
          pending = this.#approvals.get(e.requestId);
        check(
          pending &&
            pending.policyHash === ctx.accepted.policy.commitment &&
            raw.basePolicyHash === pending.policyHash &&
            raw.principalId === pending.principalId &&
            raw.role === pending.role &&
            this.options.repository.enrollment(e.requestId) === "pending" &&
            this.options.repository.enrollment(e.nonce) === "pending",
          "stale-control",
        );
        check(
          input.confirmedFingerprint === pending.fingerprint,
          "untrusted-authority",
        );
        verifyEnrollment(wire, ctx.accepted.metadata, {
          ...pending.approval,
          nowUnix: Math.floor(this.#now() / 1000),
          monotonicNow: this.#monotonic(),
        });
        const principal = ctx.accepted.policy.policy.body.principals.find(
          (p) => p.principalId === pending.principalId && p.status === "active",
        );
        check(
          principal &&
            principal.role === pending.role &&
            principal.role !== "Owner",
          "forbidden",
        );
        const makeCert = (domain: "metadata" | "credentials"): Certificate => ({
          ...(domain === "metadata"
            ? teamMetadataScope(ctx.config.scope)
            : teamCredentialScope(ctx.config.scope)),
          deviceId: e.newDeviceId,
          signingKey: e.signingKey,
          wrappingKey: e.wrappingKey,
          role: cryptoRole(principal.role, domain),
          enrollmentHash: pending.fingerprint,
          ownerFingerprint: fingerprint(ctx.owner),
          firstGeneration: ctx.accepted.policy.policy.body.generation + 1,
        });
        const proof = b64(wire);
        const prepared = this.#prepare(ctx, {
          devices: [
            ...ctx.accepted.policy.policy.body.devices,
            { deviceId: e.newDeviceId, principalId: principal.principalId },
          ],
          metadataCerts: [
            ...ctx.accepted.metadata.certificates,
            makeCert("metadata"),
          ],
          credentialCerts:
            principal.role === "Viewer"
              ? ctx.accepted.credentials.certificates
              : [
                  ...ctx.accepted.credentials.certificates,
                  makeCert("credentials"),
                ],
          proofs: [proof],
        });
        // Persist immutable publication before consuming proof; retries use these bytes, never a renewed proof.
        this.options.repository.set("pendingPublication", {
          request: prepared.request,
        });
        this.#consumeApproval(e.requestId, "used");
        await this.#publishPrepared(ctx, prepared, g);
        this.#materialized = null;
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  async #commitWrite(
    c: Configuration,
    pending: PendingWrite,
    g: number,
  ): Promise<void> {
    const transport = this.#transport(c, g),
      receipt = this.#unwrap(
        await this.#wait(
          pending.domain === "metadata"
            ? transport.writeMetadata(pending.request, this.#abort.signal)
            : transport.writeCredentials(pending.request, this.#abort.signal),
          g,
        ),
      );
    const head = operationCommitment(bytes(pending.request.operation.wire));
    check(
      receipt.policyHash === pending.request.policyHash &&
        receipt.head === head,
      "untrusted-authority",
    );
    const accepted = this.#accepted(c),
      data = this.options.repository.get<CurrentData>("current");
    check(
      accepted &&
        data &&
        accepted.policy.commitment === receipt.policyHash &&
        data.policyHash === receipt.policyHash,
      "stale-control",
    );
    const next = {
      ...data,
      ...(pending.domain === "metadata"
        ? { metadataHash: head, metadata: pending.request.operation }
        : { credentialHash: head, credentials: pending.request.operation }),
    };
    await this.#pin(
      c,
      accepted,
      { metadata: next.metadataHash, credentials: next.credentialHash },
      g,
    );
    this.options.repository.transaction(() => {
      this.options.repository.addOperation(
        pending.domain,
        head,
        pending.request.operation,
      );
      this.options.repository.set("current", next);
      this.options.repository.remove("pendingWrite");
    });
  }
  async #write(
    ctx: Context,
    domain: "metadata" | "credentials",
    snapshot: TeamMetadataSnapshot | TeamCredentialSnapshot,
    g: number,
  ): Promise<void> {
    const operation = this.#seal(
      snapshot,
      domain === "metadata" ? ctx.accepted.metadata : ctx.accepted.credentials,
      ctx.config,
      ctx.signing,
      domain === "metadata" ? ctx.epochs.metadata : ctx.epochs.credentials!,
      ctx.heads[domain],
    );
    const pending: PendingWrite = {
      domain,
      request: {
        policyHash: ctx.accepted.policy.commitment,
        expectedHead: ctx.heads[domain],
        operation,
      },
    };
    this.options.repository.set("pendingWrite", pending);
    await this.#commitWrite(ctx.config, pending, g);
    if (domain === "metadata") {
      const metadata = snapshot as TeamMetadataSnapshot;
      this.options.repository.transaction(() => {
        this.options.repository.retireMissing(
          ctx.config.scope.teamId,
          metadata.hosts.map((h) => h.recordId),
        );
        for (const host of metadata.hosts)
          this.options.repository.bind(ctx.config.scope.teamId, host.recordId);
      });
      this.#materialized = {
        policyHash: ctx.accepted.policy.commitment,
        metadataHash: operationCommitment(bytes(operation.wire)),
        credentialHash: ctx.heads.credentials,
        metadata,
      };
    }
  }
  saveHost(input: {
    record: TeamHost;
    expectedMetadataHash: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        const role = this.#role(ctx.config, ctx.accepted);
        check(role && teamCanEdit(role), "forbidden");
        check(input.expectedMetadataHash === ctx.heads.metadata, "conflict");
        check(isTeamHost(input.record));
        const old = ctx.metadata.hosts.find(
          (h) => h.recordId === input.record.recordId,
        );
        check(
          old ||
            !this.options.repository
              .bindings()
              .some(
                (b) =>
                  b.teamId === ctx.config.scope.teamId &&
                  b.recordId === input.record.recordId &&
                  b.retired,
              ),
          "conflict",
        );
        const metadata = {
          ...ctx.metadata,
          hosts: sorted(
            [
              ...ctx.metadata.hosts.filter(
                (h) => h.recordId !== input.record.recordId,
              ),
              structuredClone(input.record),
            ],
            "recordId",
          ),
        };
        check(isTeamMetadataSnapshot(metadata));
        await this.#write(ctx, "metadata", metadata, g);
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  deleteHost(input: {
    recordId: string;
    expectedMetadataHash: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        const role = this.#role(ctx.config, ctx.accepted);
        check(role && teamCanEdit(role), "forbidden");
        check(input.expectedMetadataHash === ctx.heads.metadata, "conflict");
        check(
          ctx.metadata.hosts.some((h) => h.recordId === input.recordId),
          "invalid",
        );
        await this.#write(
          ctx,
          "metadata",
          {
            ...ctx.metadata,
            hosts: ctx.metadata.hosts.filter(
              (h) => h.recordId !== input.recordId,
            ),
          },
          g,
        );
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  sharePassword(input: {
    recordId: string;
    password: string;
    consent: true;
    expectedMetadataHash: string;
    expectedCredentialHash: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        check(input.consent === true);
        check(
          input.expectedMetadataHash === ctx.heads.metadata &&
            input.expectedCredentialHash === ctx.heads.credentials,
          "conflict",
        );
        const host = ctx.metadata.hosts.find(
          (h) => h.recordId === input.recordId,
        );
        check(host);
        check(
          Buffer.byteLength(input.password) > 0 &&
            Buffer.byteLength(input.password) <= 16384,
        );
        const old = ctx.credentials.credentials.find(
          (p) => p.recordId === host.recordId,
        );
        const credentials: TeamCredentialSnapshot = {
          format: "ssterm-team-credentials-v1",
          credentials: sorted(
            [
              ...ctx.credentials.credentials.filter(
                (p) => p.recordId !== host.recordId,
              ),
              {
                credentialId: old?.credentialId ?? randomUUID(),
                recordId: host.recordId,
                targetDigest: teamTargetDigest(ctx.config.scope.teamId, host),
                password: input.password,
              },
            ],
            "credentialId",
          ),
        };
        check(isTeamCredentialSnapshot(credentials));
        await this.#write(ctx, "credentials", credentials, g);
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  replacePassword(
    input: Parameters<TeamClient["sharePassword"]>[0],
  ): Promise<TeamResult<TeamStateView>> {
    return this.sharePassword(input);
  }
  detachPassword(input: {
    recordId: string;
    expectedCredentialHash: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        check(
          input.expectedCredentialHash === ctx.heads.credentials,
          "conflict",
        );
        check(
          ctx.credentials.credentials.some(
            (p) => p.recordId === input.recordId,
          ),
        );
        await this.#write(
          ctx,
          "credentials",
          {
            format: "ssterm-team-credentials-v1",
            credentials: ctx.credentials.credentials.filter(
              (p) => p.recordId !== input.recordId,
            ),
          },
          g,
        );
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  changeRole(input: {
    principalId: string;
    role: Exclude<TeamRole, "Owner">;
    expectedPolicyHash: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#changePrincipal({ ...input, revoke: false });
  }
  revokePrincipal(input: {
    principalId: string;
    expectedPolicyHash: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#changePrincipal({ ...input, revoke: true });
  }
  #changePrincipal(input: {
    principalId: string;
    role?: Exclude<TeamRole, "Owner">;
    expectedPolicyHash: string;
    revoke: boolean;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        check(
          input.expectedPolicyHash === ctx.accepted.policy.commitment,
          "conflict",
        );
        const p = ctx.accepted.policy.policy.body.principals.find(
          (p) =>
            p.principalId === input.principalId &&
            p.status === "active" &&
            p.role !== "Owner",
        );
        check(p, "forbidden");
        check(
          input.revoke ||
            (input.role &&
              ["Editor", "Connector", "Viewer"].includes(input.role) &&
              input.role !== p.role),
          "invalid",
        );
        const principals = ctx.accepted.policy.policy.body.principals.map(
          (principal) =>
            principal.principalId === p.principalId
              ? {
                  ...principal,
                  status: input.revoke
                    ? ("revoked" as const)
                    : ("active" as const),
                  role: input.role ?? principal.role,
                }
              : principal,
        );
        const devices = ctx.accepted.policy.policy.body.devices.filter(
          (d) => d.principalId !== p.principalId,
        );
        await this.#publishPrepared(
          ctx,
          this.#prepare(ctx, { principals, devices, rotate: true }),
          g,
        );
        this.#materialized = null;
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  hasVirtualBinding(hostId: string): boolean {
    return this.options.repository.binding(hostId) !== null;
  }
  #sessionCheck(session: TeamSessionContext): void {
    check(session.kind === "terminal", "unsupported");
    check(!session.signal?.aborted, "cancelled");
    check(
      /^[A-Za-z0-9:_-]{1,160}$/.test(session.ownerId) &&
        syncUuid(session.sessionId) &&
        Number.isSafeInteger(session.generation),
    );
  }
  async #grant(
    ctx: Context,
    recordId: string,
    signal?: AbortSignal,
  ): Promise<TeamConnectGrant> {
    check(!signal?.aborted, "cancelled");
    const role = this.#role(ctx.config, ctx.accepted);
    check(role && teamCanConnect(role), "forbidden");
    const request = {
      requestId: randomUUID(),
      policyHash: ctx.accepted.policy.commitment,
      metadataHash: ctx.heads.metadata,
      credentialHash: ctx.heads.credentials,
      recordId,
    };
    const grant = this.#unwrap(
      await this.#transport(ctx.config, this.#generation).connect(
        request,
        signal ?? this.#abort.signal,
      ),
    );
    check(!signal?.aborted, "cancelled");
    check(
      canonical({ ...grant, expiresAt: undefined }) === canonical(request) &&
        grant.expiresAt * 1000 > this.#now() &&
        grant.expiresAt * 1000 <= this.#now() + 15_000,
      "stale-control",
    );
    return grant;
  }
  resolveCapturedHost(input: {
    virtualHostId: string;
    session: TeamSessionContext;
  }): Promise<TeamResult<ResolvedHostConfig>> {
    return this.authorizeConnect(input);
  }
  authorizeConnect(input: {
    virtualHostId: string;
    session: TeamSessionContext;
  }): Promise<TeamResult<ResolvedHostConfig>> {
    return this.#run(async (g) => {
      this.#sessionCheck(input.session);
      const binding = this.options.repository.binding(input.virtualHostId);
      check(binding && !binding.retired, "forbidden");
      const ctx = await this.#context(g);
      try {
        check(binding.teamId === ctx.config.scope.teamId, "forbidden");
        const host = ctx.metadata.hosts.find(
          (h) => h.recordId === binding.recordId,
        );
        check(host, "forbidden");
        const grant = await this.#wait(
          this.#grant(ctx, host.recordId, input.session.signal),
          g,
        );
        this.#sessionCheck(input.session);
        for (const [id, lease] of this.#leases)
          if (lease.expiresAt <= this.#now()) this.#leases.delete(id);
        check(this.#leases.size < 128, "too-large");
        const source: TeamManagedSource = {
          kind: "team",
          teamId: ctx.config.scope.teamId,
          principalId: ctx.config.principalId,
          deviceId: ctx.config.deviceId,
          recordId: host.recordId,
          policyHash: grant.policyHash,
          metadataHash: grant.metadataHash,
          credentialHash: grant.credentialHash,
          leaseId: grant.requestId,
        };
        this.#leases.set(source.leaseId, {
          source,
          session: { ...input.session },
          host: { ...host },
          expiresAt: grant.expiresAt * 1000,
        });
        const date = new Date(this.#now()).toISOString();
        return {
          source,
          hostRef: {
            id: input.virtualHostId,
            revision: ctx.accepted.policy.policy.body.generation,
            label: host.label,
            groupId: null,
          },
          address: host.address,
          environment: host.environment,
          port: { value: host.port, source: { kind: "default" } },
          auth: {
            selection: "identity",
            identity: {
              id: input.virtualHostId,
              vaultId: ctx.config.scope.metadataVaultId,
              revision: ctx.accepted.policy.policy.body.generation,
              createdAt: date,
              updatedAt: date,
              label: host.label,
              username: host.username,
              method: "password",
              passwordRef: null,
              keyId: null,
            },
            key: null,
            source: { kind: "default" },
          },
          ancestry: [],
          catalogRevision: ctx.accepted.policy.policy.body.generation,
        };
      } finally {
        this.#clear(ctx);
      }
    });
  }
  loadManagedPassword(input: {
    session: TeamSessionContext;
    source: TeamManagedSource;
  }): Promise<TeamResult<{ bytes: Uint8Array; dispose(): void }>> {
    return this.#run(async (g) => {
      this.#sessionCheck(input.session);
      const lease = this.#leases.get(input.source.leaseId);
      check(
        lease &&
          canonical(lease.source) === canonical(input.source) &&
          lease.session.ownerId === input.session.ownerId &&
          lease.session.sessionId === input.session.sessionId &&
          lease.session.generation === input.session.generation,
        "forbidden",
      );
      // No cached credential/lease authorizes release. Fetch and a new one-use server nonce are mandatory after host trust.
      const ctx = await this.#context(g);
      try {
        check(
          ctx.config.deviceId === input.source.deviceId &&
            ctx.config.principalId === input.source.principalId &&
            ctx.config.scope.teamId === input.source.teamId &&
            ctx.accepted.policy.commitment === input.source.policyHash &&
            ctx.heads.metadata === input.source.metadataHash &&
            ctx.heads.credentials === input.source.credentialHash,
          "stale-control",
        );
        const host = ctx.metadata.hosts.find(
          (h) => h.recordId === input.source.recordId,
        );
        check(
          host &&
            teamTargetDigest(ctx.config.scope.teamId, host) ===
              teamTargetDigest(ctx.config.scope.teamId, lease.host),
          "stale-control",
        );
        const grant = await this.#wait(
          this.#grant(ctx, host.recordId, input.session.signal),
          g,
        );
        this.#sessionCheck(input.session);
        check(
          grant.policyHash === input.source.policyHash &&
            grant.metadataHash === input.source.metadataHash &&
            grant.credentialHash === input.source.credentialHash,
          "stale-control",
        );
        const credential = ctx.credentials?.credentials.find(
          (p) => p.recordId === host.recordId,
        );
        check(
          credential &&
            credential.targetDigest ===
              teamTargetDigest(ctx.config.scope.teamId, host),
          "credentials-unavailable",
        );
        const value = Buffer.from(credential.password);
        check(
          value.length > 0 && value.length <= 16384,
          "credentials-unavailable",
        );
        this.#leases.delete(input.source.leaseId);
        let disposed = false;
        return {
          bytes: value,
          dispose() {
            if (!disposed) {
              disposed = true;
              value.fill(0);
            }
          },
        };
      } finally {
        this.#clear(ctx);
      }
    });
  }
  audit(input: { afterSequence: number }): Promise<TeamResult<TeamAuditPage>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        return this.#unwrap(
          await this.#wait(
            this.#transport(ctx.config, g).audit(
              input.afterSequence,
              this.#abort.signal,
            ),
            g,
          ),
        );
      } finally {
        this.#clear(ctx);
      }
    });
  }
  reportConnection(
    event: TeamClientEvent,
  ): Promise<TeamResult<{ accepted: number }>> {
    return this.#run(async (g) => {
      const c = this.#config();
      check(c, "forbidden");
      return this.#unwrap(
        await this.#wait(
          this.#transport(c, g).events([event], this.#abort.signal),
          g,
        ),
      );
    });
  }
  createRecovery(): Promise<TeamResult<TeamRecoveryDraft>> {
    return this.#run(async (g) => {
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        this.#clearRecovery();
        const secret = generateRecoverySecret();
        const base = ctx.accepted.policy.policy;
        const make = (domain: "metadata" | "credentials") => {
          const a = ctx.accepted[domain],
            scope =
              domain === "metadata"
                ? teamMetadataScope(ctx.config.scope)
                : teamCredentialScope(ctx.config.scope);
          const binding = {
            ...scope,
            recoveryId: randomUUID(),
            controlHash: a.commitment,
          };
          const checkpoints = this.options.repository.checkpoints();
          const previous =
            checkpoints.find(
              (row) => row.generation === base.body.generation - 1,
            )?.checkpoint.policy.body.ownerSpki ?? ctx.config.ownerSpki;
          const wire =
            domain === "metadata"
              ? checkpoints.at(-1)!.checkpoint.metadataControl.controlWire
              : checkpoints.at(-1)!.checkpoint.credentialControl.controlWire;
          const plain = encodeRecoveryPayload(
            {
              ownerKey: ctx.owner,
              previousOwnerKey: pub(previous),
              baseControlWire: bytes(wire),
              epochs: [
                {
                  epoch: a.control.activeEpoch,
                  key:
                    domain === "metadata"
                      ? ctx.epochs.metadata
                      : ctx.epochs.credentials!,
                },
              ],
            },
            binding,
            fingerprint(ctx.owner),
          );
          try {
            const recoveryWire = sealRecovery(
              { ...binding, ...freshEntropy(), plaintextLength: plain.length },
              secret,
              plain,
            );
            const descriptor = recoveryDescriptor({
              ...scope,
              recoveryId: binding.recoveryId,
              recoveryEnvelopeHash: sha(recoveryWire),
            });
            return { wire: b64(recoveryWire), descriptor: b64(descriptor) };
          } finally {
            plain.fill(0);
          }
        };
        try {
          const metadata = make("metadata"),
            credentials = make("credentials"),
            kit: TeamRecoveryKit = {
              format: "ssterm-team-recovery-v1",
              basePolicy: base,
              metadataRecoveryWire: metadata.wire,
              credentialRecoveryWire: credentials.wire,
            };
          check(isTeamRecoveryKit(kit));
          const view = {
            confirmationToken: randomUUID(),
            expiresAt: this.#now() + 300_000,
            secret: b64(secret),
            kit: canonical(kit),
          };
          const timer = setTimeout(() => this.#clearRecovery(), 300_000);
          timer.unref();
          this.#recovery = {
            view,
            secret,
            kit,
            metadataDescriptor: metadata.descriptor,
            credentialDescriptor: credentials.descriptor,
            policyHash: ctx.accepted.policy.commitment,
            timer,
          };
          return view;
        } catch (error) {
          secret.fill(0);
          throw error;
        }
      } finally {
        this.#clear(ctx);
      }
    });
  }
  #decodeKit(
    kit: TeamRecoveryKit,
    secret: Uint8Array,
    expectedFingerprint: string,
  ): {
    metadata: ReturnType<typeof decodeRecoveryPayload>;
    credentials: ReturnType<typeof decodeRecoveryPayload>;
  } {
    const decode = (wire: string, domain: "metadata" | "credentials") => {
      const raw = bytes(wire),
        [header] = unframe(raw, 2, 8 * 1024 * 1024, 8 * 1024 * 1024 + 2048),
        h = parseRecoveryHeader(header);
      const scope =
        domain === "metadata"
          ? teamMetadataScope(kit.basePolicy.body.scope)
          : teamCredentialScope(kit.basePolicy.body.scope);
      check(
        h.deploymentId === scope.deploymentId &&
          h.accountId === scope.accountId &&
          h.vaultId === scope.vaultId &&
          h.controlHash ===
            (domain === "metadata"
              ? kit.basePolicy.body.metadataControlHash
              : kit.basePolicy.body.credentialControlHash),
        "untrusted-authority",
      );
      const plain = openRecovery(raw, h, secret);
      try {
        return decodeRecoveryPayload(plain, h, expectedFingerprint);
      } finally {
        plain.fill(0);
      }
    };
    const metadata = decode(kit.metadataRecoveryWire, "metadata");
    try {
      const credentials = decode(kit.credentialRecoveryWire, "credentials");
      check(
        fingerprint(metadata.ownerKey) === fingerprint(credentials.ownerKey),
        "untrusted-authority",
      );
      return { metadata, credentials };
    } catch (error) {
      for (const e of metadata.epochs) e.key.fill(0);
      throw error;
    }
  }
  confirmRecovery(input: {
    confirmationToken: string;
    secret: string;
    kit: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const draft = this.#recovery;
      check(
        draft &&
          draft.view.confirmationToken === input.confirmationToken &&
          draft.view.expiresAt > this.#now() &&
          input.secret === draft.view.secret &&
          input.kit === draft.view.kit,
        "fenced",
      );
      const ctx = await this.#context(g);
      try {
        this.#requireOwner(ctx);
        check(
          ctx.accepted.policy.commitment === draft.policyHash,
          "stale-control",
        );
        const decoded = this.#decodeKit(
          draft.kit,
          draft.secret,
          fingerprint(ctx.owner),
        );
        try {
          check(
            decoded.metadata.epochs.some(
              (e) =>
                e.epoch === ctx.accepted.metadata.control.activeEpoch &&
                Buffer.from(e.key).equals(ctx.epochs.metadata),
            ) &&
              decoded.credentials.epochs.some(
                (e) =>
                  e.epoch === ctx.accepted.credentials.control.activeEpoch &&
                  Buffer.from(e.key).equals(ctx.epochs.credentials!),
              ),
            "key-unavailable",
          );
        } finally {
          for (const payload of [decoded.metadata, decoded.credentials])
            for (const epoch of payload.epochs) epoch.key.fill(0);
        }
        const prepared = this.#prepare(ctx, {
          recovery: {
            kit: draft.kit,
            metadataDescriptor: draft.metadataDescriptor,
            credentialDescriptor: draft.credentialDescriptor,
          },
        });
        await this.#publishPrepared(ctx, prepared, g, { recoveryReady: true });
        this.#clearRecovery();
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  #clearRecovery(): void {
    if (this.#recovery) {
      clearTimeout(this.#recovery.timer);
      this.#recovery.secret.fill(0);
      this.#recovery = null;
    }
  }
  recover(input: {
    endpoint: string;
    token: string;
    principalId: string;
    expectedScope: TeamScope;
    expectedOwnerFingerprint: string;
    secret: string;
    kit: string;
  }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      check(!this.#config(), "conflict");
      check(
        syncBytes(input.secret, 32, 32) &&
          syncHash(input.expectedOwnerFingerprint),
      );
      const parsed = textObject(input.kit);
      check(
        isTeamRecoveryKit(parsed) &&
          canonical(parsed.basePolicy.body.scope) ===
            canonical(input.expectedScope) &&
          parsed.basePolicy.body.ownerPrincipalId === input.principalId &&
          fingerprint(pub(parsed.basePolicy.body.ownerSpki)) ===
            input.expectedOwnerFingerprint,
        "untrusted-authority",
      );
      const secret = bytes(input.secret);
      const decoded = (() => {
        try {
          return this.#decodeKit(
            parsed,
            secret,
            input.expectedOwnerFingerprint,
          );
        } finally {
          secret.fill(0);
        }
      })();
      let ctx: Context | null = null;
      try {
        const c = await this.#setup(input, g);
        c.expectedOwnerFingerprint = input.expectedOwnerFingerprint;
        this.options.repository.set("configuration", c);
        // Authenticate the complete public chain against the independently decrypted kit anchor before persisting any server key.
        const checkpoints: TeamPolicyCheckpoint[] = [];
        let current: AcceptedTeamCheckpoint | undefined;
        let generation = 0,
          anchor = false,
          genesisSpki = "";
        for (let page = 0; page < 33; page++) {
          const response = this.#unwrap(
            await this.#wait(
              this.#transport(c, g).policies(generation, this.#abort.signal),
              g,
            ),
          );
          for (const checkpoint of response.checkpoints) {
            if (!current) genesisSpki = checkpoint.policy.body.ownerSpki;
            current = acceptTeamCheckpoint(
              checkpoint,
              c.scope,
              pub(genesisSpki),
              current,
            );
            generation = current.policy.policy.body.generation;
            checkpoints.push(checkpoint);
            if (generation === parsed.basePolicy.body.generation) {
              check(
                teamPolicyHash(checkpoint.policy) ===
                  teamPolicyHash(parsed.basePolicy) &&
                  fingerprint(current.policy.ownerKey) ===
                    input.expectedOwnerFingerprint,
                "untrusted-authority",
              );
              anchor = true;
            }
          }
          check(response.nextGeneration === generation, "stale-control");
          if (!response.hasMore) break;
          check(response.checkpoints.length > 0 && page < 32, "too-large");
        }
        check(
          current &&
            anchor &&
            current.policy.policy.body.ownerPrincipalId === c.principalId,
          "untrusted-authority",
        );
        const response = this.#unwrap(
          await this.#wait(
            this.#transport(c, g).recovery(this.#abort.signal),
            g,
          ),
        );
        check(
          teamPolicyHash(response.checkpoint.policy) ===
            current.policy.commitment &&
            response.kit &&
            canonical(response.kit) === canonical(parsed),
          "stale-control",
        );
        const metadataEpoch = decoded.metadata.epochs.find(
            (e) => e.epoch === current!.metadata.control.activeEpoch,
          ),
          credentialEpoch = decoded.credentials.epochs.find(
            (e) => e.epoch === current!.credentials.control.activeEpoch,
          );
        check(metadataEpoch && credentialEpoch, "key-unavailable");
        check(
          fingerprint(decoded.metadata.ownerKey) ===
            fingerprint(current.policy.ownerKey),
          "key-unavailable",
        );
        const metadata = this.#open(
            response.metadataSnapshot,
            current.metadata,
            metadataEpoch.key,
          ),
          credentials = this.#open(
            response.credentialSnapshot,
            current.credentials,
            credentialEpoch.key,
          );
        check(
          isTeamMetadataSnapshot(metadata) &&
            isTeamCredentialSnapshot(credentials),
        );
        check(
          operationCommitment(bytes(response.metadataSnapshot.wire)) ===
            response.metadataHead &&
            operationCommitment(bytes(response.credentialSnapshot.wire)) ===
              response.credentialHead,
          "untrusted-authority",
        );
        c.ownerSpki = genesisSpki;
        this.options.repository.set("configuration", c);
        await this.#pin(
          c,
          current,
          {
            metadata: response.metadataHead,
            credentials: response.credentialHead,
          },
          g,
        );
        this.options.repository.transaction(() => {
          for (const checkpoint of checkpoints)
            this.options.repository.addCheckpoint({
              hash: teamPolicyHash(checkpoint.policy),
              generation: checkpoint.policy.body.generation,
              checkpoint,
            });
          this.options.repository.set("current", {
            policyHash: current!.policy.commitment,
            metadataHash: response.metadataHead,
            credentialHash: response.credentialHead,
            metadata: response.metadataSnapshot,
            credentials: response.credentialSnapshot,
          });
        });
        const keys = await this.#keys(c, current, g),
          newOwner = generateSigningKey();
        ctx = {
          config: c,
          accepted: current,
          ...keys,
          owner: decoded.metadata.ownerKey,
          epochs: {
            metadata: Buffer.from(metadataEpoch.key),
            credentials: Buffer.from(credentialEpoch.key),
          },
          metadata,
          credentials,
          heads: {
            metadata: response.metadataHead,
            credentials: response.credentialHead,
          },
        };
        await this.#storeKey(c, "owner", "owner-signing", newOwner, g);
        const generationNext = current.policy.policy.body.generation + 1,
          metadataAdmission = sha(bytes(parsed.metadataRecoveryWire)),
          credentialAdmission = sha(bytes(parsed.credentialRecoveryWire));
        const newCert = (domain: "metadata" | "credentials"): Certificate => ({
          ...(domain === "metadata"
            ? teamMetadataScope(c.scope)
            : teamCredentialScope(c.scope)),
          deviceId: c.deviceId,
          signingKey: createPublicKey(keys.signing),
          wrappingKey: createPublicKey(keys.wrapping),
          role: "owner",
          enrollmentHash:
            domain === "metadata" ? metadataAdmission : credentialAdmission,
          ownerFingerprint: fingerprint(newOwner),
          firstGeneration: generationNext,
        });
        const oldDevice = current.policy.policy.body.ownerDeviceId,
          devices = [
            ...current.policy.policy.body.devices.filter(
              (d) => d.deviceId !== oldDevice,
            ),
            { deviceId: c.deviceId, principalId: c.principalId },
          ],
          metadataCerts = [
            ...current.metadata.certificates.filter(
              (cert) => cert.deviceId !== oldDevice,
            ),
            newCert("metadata"),
          ],
          credentialCerts = [
            ...current.credentials.certificates.filter(
              (cert) => cert.deviceId !== oldDevice,
            ),
            newCert("credentials"),
          ];
        const prepared = this.#prepare(ctx, {
          devices,
          newOwner,
          metadataCerts,
          credentialCerts,
          rotate: true,
          recoveryAdmission: {
            metadata: metadataAdmission,
            credentials: credentialAdmission,
          },
        });
        await this.#publishPrepared(ctx, prepared, g);
        this.#materialized = null;
        return this.state();
      } finally {
        if (ctx) this.#clear(ctx);
        for (const payload of [decoded.metadata, decoded.credentials])
          for (const epoch of payload.epochs) epoch.key.fill(0);
      }
    });
  }
  async #replaceTransportToken(
    c: Configuration,
    tokenText: string,
    g: number,
  ): Promise<void> {
    check(syncBytes(tokenText, 32, 32));
    const token = bytes(tokenText);
    try {
      const previous = c.refs.token;
      delete c.refs.token;
      const slot = `token/${randomUUID()}`;
      await this.#put(c, slot, "transport-token", token, g);
      c.refs.token = c.refs[slot];
      delete c.refs[slot];
      this.options.repository.set("configuration", c);
      const info = this.#unwrap(
        await this.#wait(this.#transport(c, g).info(this.#abort.signal), g),
      );
      check(
        canonical(info.scope) === canonical(c.scope),
        "untrusted-authority",
      );
      if (previous) this.options.repository.set("retainedTokenRef", previous);
    } finally {
      token.fill(0);
    }
  }
  resume(input: { token: string }): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const c = this.#config();
      check(c && syncBytes(input.token, 32, 32));
      await this.#replaceTransportToken(c, input.token, g);
      await this.#resume(c, g);
      const ctx = await this.#context(g);
      try {
        return this.state();
      } finally {
        this.#clear(ctx);
      }
    });
  }
  cancelSetup(): Promise<TeamResult<TeamStateView>> {
    return this.#run(async (g) => {
      const c = this.#config();
      check(
        c &&
          c.phase === "preparing" &&
          this.options.repository.checkpoints().length === 0 &&
          !this.options.repository.get("pendingPublication") &&
          !this.options.repository.get("pendingWrite"),
        "forbidden",
      );
      for (const [slot, ref] of Object.entries(c.refs)) {
        const kinds: Record<string, string> = {
          signing: "device-signing",
          wrapping: "device-wrapping",
          owner: "owner-signing",
          token: "transport-token",
        };
        const kind =
          kinds[slot] ??
          (slot.startsWith("metadata/")
            ? "metadata-epoch"
            : slot.startsWith("credentials/")
              ? "credential-epoch"
              : null);
        check(kind, "key-unavailable");
        const result = await this.#wait(
          this.options.keyStore.delete(this.#account(c, kind, ref)),
          g,
        );
        check(result === "confirmed", "key-unavailable");
        this.options.repository.remove(`provider/${ref}`);
      }
      this.options.repository.remove("configuration");
      this.#fault = null;
      return this.state();
    });
  }
  lifecycleEpoch(): number {
    return this.#generation;
  }
  cancelRecovery(): void {
    this.#clearRecovery();
  }
  lock(): void {
    this.#locked = true;
    this.#generation++;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#materialized = null;
    this.#leases.clear();
    this.#clearRecovery();
    for (const id of [...this.#approvals.keys()])
      this.#consumeApproval(id, "cancelled");
  }
  unlock(): void {
    this.#locked = false;
  }
  logout(input: {
    forgetTransportToken: boolean;
  }): Promise<TeamResult<TeamStateView>> {
    this.lock();
    this.unlock();
    return this.#run(async (g) => {
      const c = this.#config();
      if (c && input.forgetTransportToken && c.refs.token) {
        const ref = c.refs.token;
        const result = await this.#wait(
          this.options.keyStore.delete(
            this.#account(c, "transport-token", ref),
          ),
          g,
        );
        check(result === "confirmed", "key-unavailable");
        delete c.refs.token;
        this.options.repository.set("configuration", c);
      }
      return this.state();
    }).then((result) => {
      this.#locked = true;
      this.#materialized = null;
      return result.ok ? { ok: true as const, value: this.state() } : result;
    });
  }
  async dispose(): Promise<void> {
    this.lock();
    await this.#tail;
  }
}
