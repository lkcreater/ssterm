import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TeamClient,
  type TeamResult,
} from "../../packages/services/src/team.ts";
import { openTeamRepository } from "../../packages/adapters/src/team-repository.ts";
import {
  createTeamTransport,
  type TeamTransportOptions,
  type TeamTransport,
} from "../../packages/adapters/src/team-transport.ts";
import type { TeamKeyStore } from "../../packages/adapters/src/team-keychain.ts";
import { TeamServer } from "../../apps/sync-server/src/team-server.ts";
import type {
  TeamScope,
  TeamHost,
  TeamRole,
} from "../../packages/domain/src/team.ts";
const ok = <T>(r: TeamResult<T>): T => {
  assert(r.ok, JSON.stringify(r));
  return r.value;
};
class Keys implements TeamKeyStore {
  values = new Map<string, Buffer>();
  unavailable = false;
  failWrite: ((account: string) => boolean) | null = null;
  async read(account: string) {
    if (this.unavailable) return { status: "unavailable" as const };
    const v = this.values.get(account);
    return v
      ? { status: "present" as const, value: Buffer.from(v) }
      : { status: "missing" as const };
  }
  async write(account: string, value: Uint8Array) {
    if (this.unavailable || this.failWrite?.(account))
      return "unknown" as const;
    this.values.set(account, Buffer.from(value));
    return "confirmed" as const;
  }
  async delete(account: string) {
    this.values.get(account)?.fill(0);
    this.values.delete(account);
    return "confirmed" as const;
  }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-team-client-"));
  const scope: TeamScope = {
      deploymentId: randomUUID(),
      accountId: randomUUID(),
      teamId: randomUUID(),
      metadataVaultId: randomUUID(),
      credentialVaultId: randomUUID(),
    },
    principalId = randomUUID(),
    token = randomBytes(32).toString("base64url");
  const server = new TeamServer(
    {
      scope,
      databasePath: join(dir, "server.sqlite"),
      initialOwnerPrincipalId: principalId,
      initialOwnerTokenHash: createHash("sha256")
        .update(Buffer.from(token, "base64url"))
        .digest("hex"),
    },
    { requestLimit: 10000 },
  );
  const endpoint = await server.listen();
  const repositories: ReturnType<typeof openTeamRepository>[] = [],
    clients: TeamClient[] = [];
  const make = (
    name: string,
    extra: {
      transportFactory?: (o: TeamTransportOptions) => TeamTransport;
    } = {},
  ) => {
    mkdirSync(join(dir, name), { recursive: true, mode: 0o700 });
    const repository = openTeamRepository(join(dir, name, "team.sqlite")),
      keys = new Keys(),
      client = new TeamClient({ repository, keyStore: keys, ...extra });
    repositories.push(repository);
    clients.push(client);
    return { client, keys, repository };
  };
  const owner = make("owner");
  try {
    ok(
      await owner.client.create({
        endpoint,
        expectedScope: scope,
        principalId,
        token,
        displayName: "Owner",
      }),
    );
  } catch (error) {
    await server.close();
    for (const r of repositories) r.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const joinMember = async (role: Exclude<TeamRole, "Owner">, name = role) => {
    const invitation = ok(
      await owner.client.invitePrincipal({ label: name, role }),
    );
    const member = make(name);
    const candidate = ok(
      await member.client.beginJoin({
        endpoint,
        expectedScope: scope,
        principalId: invitation.principalId,
        token: invitation.token,
        expectedOwnerFingerprint: invitation.ownerFingerprint,
      }),
    );
    const challenge = ok(
      await owner.client.challengeEnrollment({
        candidateText: candidate.candidateText,
        principalId: invitation.principalId,
        role,
      }),
    );
    const proof = ok(
      await member.client.proveEnrollment({
        challengeText: challenge.challengeText,
      }),
    );
    assert.equal(proof.fingerprint, challenge.fingerprint);
    ok(
      await owner.client.approveEnrollment({
        proofText: proof.proofText,
        confirmedFingerprint: proof.fingerprint,
      }),
    );
    ok(await member.client.finishJoin());
    return { ...member, invitation };
  };
  return {
    dir,
    scope,
    principalId,
    token,
    endpoint,
    server,
    owner,
    make,
    joinMember,
    async close() {
      for (const c of clients) await c.dispose();
      for (const r of repositories) r.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const host = (): TeamHost => ({
  recordId: randomUUID(),
  label: "Shared DEV",
  address: "127.0.0.1",
  port: 22,
  username: "fixture",
  environment: "DEV",
});
const session = () => ({
  ownerId: "window:1:1",
  sessionId: randomUUID(),
  generation: 1,
  kind: "terminal" as const,
});
test("team client creates private independent journals and enrolls real principals with Viewer cryptographic isolation", async () => {
  const f = await fixture();
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    ok(
      await f.owner.client.sharePassword({
        recordId: h.recordId,
        password: "fixture-secret-only",
        consent: true,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
        expectedCredentialHash: f.owner.client.state().credentialHash!,
      }),
    );
    const viewer = await f.joinMember("Viewer");
    assert.equal(viewer.client.state().hosts.length, 1);
    assert.equal(viewer.client.state().credentialEpoch, 0);
    assert(
      ![...viewer.keys.values.keys()].some((k) =>
        k.includes("/credential-epoch/"),
      ),
    );
    assert.deepEqual(
      await viewer.client.saveHost({
        record: host(),
        expectedMetadataHash: viewer.client.state().metadataHash!,
      }),
      { ok: false, code: "forbidden" },
    );
    assert.deepEqual(
      await viewer.client.authorizeConnect({
        virtualHostId: viewer.client.state().hosts[0].virtualHostId,
        session: session(),
      }),
      { ok: false, code: "forbidden" },
    );
    for (const name of ["owner", "Viewer"]) {
      const raw = Buffer.concat(
        await Promise.all(
          ["", "-wal", "-shm"].map((suffix) =>
            readFile(join(f.dir, name, "team.sqlite" + suffix)).catch(
              (error) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT")
                  return Buffer.alloc(0);
                throw error;
              },
            ),
          ),
        ),
      );
      assert(!raw.includes(Buffer.from("fixture-secret-only")));
      assert(!raw.includes(Buffer.from(h.label)));
    }
    assert(
      [...f.owner.keys.values.keys()].every((k) => k.startsWith("team/v1/")),
    );
  } finally {
    await f.close();
  }
});
test("managed passwords require fresh online role/head authorization after trust and dispose owned bytes", async () => {
  const f = await fixture();
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    ok(
      await f.owner.client.sharePassword({
        recordId: h.recordId,
        password: "owned-password",
        consent: true,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
        expectedCredentialHash: f.owner.client.state().credentialHash!,
      }),
    );
    const connector = await f.joinMember("Connector");
    const s = session(),
      id = connector.client.state().hosts[0].virtualHostId,
      config = ok(
        await connector.client.authorizeConnect({
          virtualHostId: id,
          session: s,
        }),
      );
    assert(config.source);
    const password = ok(
      await connector.client.loadManagedPassword({
        session: s,
        source: config.source,
      }),
    );
    assert.equal(Buffer.from(password.bytes).toString(), "owned-password");
    password.dispose();
    assert(password.bytes.every((b) => b === 0));
    const s2 = session(),
      captured = ok(
        await connector.client.authorizeConnect({
          virtualHostId: id,
          session: s2,
        }),
      );
    ok(
      await f.owner.client.saveHost({
        record: { ...h, address: "192.0.2.8" },
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    const denied = await connector.client.loadManagedPassword({
      session: s2,
      source: captured.source!,
    });
    assert(!denied.ok);
    assert.equal(denied.code, "stale-control");
  } finally {
    await f.close();
  }
});
test("role changes evict all devices, rotate both scopes and allow explicit fresh re-enrollment", async () => {
  const f = await fixture();
  try {
    const member = await f.joinMember("Connector");
    const old = member.client.state(),
      epoch = f.owner.client.state().metadataEpoch;
    ok(
      await f.owner.client.changeRole({
        principalId: member.invitation.principalId,
        role: "Viewer",
        expectedPolicyHash: f.owner.client.state().policyHash!,
      }),
    );
    assert.equal(f.owner.client.state().metadataEpoch, epoch + 1);
    const denied = await member.client.fetch();
    assert(!denied.ok);
    assert.equal(member.client.state().role, null);
    const replacement = ok(
      await f.owner.client.reissuePrincipalToken({
        principalId: member.invitation.principalId,
        expectedPolicyHash: f.owner.client.state().policyHash!,
      }),
    );
    const candidate = ok(
      await member.client.beginJoin({
        endpoint: f.endpoint,
        expectedScope: f.scope,
        principalId: member.invitation.principalId,
        token: replacement.token,
        expectedOwnerFingerprint: member.invitation.ownerFingerprint,
      }),
    );
    const challenge = ok(
        await f.owner.client.challengeEnrollment({
          candidateText: candidate.candidateText,
          principalId: member.invitation.principalId,
          role: "Viewer",
        }),
      ),
      proof = ok(
        await member.client.proveEnrollment({
          challengeText: challenge.challengeText,
        }),
      );
    ok(
      await f.owner.client.approveEnrollment({
        proofText: proof.proofText,
        confirmedFingerprint: proof.fingerprint,
      }),
    );
    ok(await member.client.finishJoin());
    assert.equal(member.client.state().role, "Viewer");
    assert.notEqual(member.client.state().deviceId, old.deviceId);
  } finally {
    await f.close();
  }
});
test("independent recovery preserves current same-epoch edits and rotates authority; stale kits fail before publication", async () => {
  const f = await fixture();
  try {
    const draft = ok(await f.owner.client.createRecovery());
    ok(await f.owner.client.confirmRecovery(draft));
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    const fresh = f.make("recovered");
    const recovered = ok(
      await fresh.client.recover({
        endpoint: f.endpoint,
        expectedScope: f.scope,
        principalId: f.principalId,
        token: f.token,
        expectedOwnerFingerprint: f.owner.client.state().ownerFingerprint!,
        secret: draft.secret,
        kit: draft.kit,
      }),
    );
    assert.equal(recovered.role, "Owner");
    assert.equal(recovered.metadataEpoch, 2);
    ok(await fresh.client.fetch());
    assert.equal(fresh.client.state().hosts[0].recordId, h.recordId);
    const stale = f.make("stale");
    const result = await stale.client.recover({
      endpoint: f.endpoint,
      expectedScope: f.scope,
      principalId: f.principalId,
      token: f.token,
      expectedOwnerFingerprint: JSON.parse(draft.kit).basePolicy.body
        .previousOwnerFingerprint,
      secret: draft.secret,
      kit: draft.kit,
    });
    assert(!result.ok);
    assert(["key-unavailable", "stale-control"].includes(result.code));
  } finally {
    await f.close();
  }
});
test("explicit auth denial purges cached metadata and observed sessions; offline keeps cached read-only metadata", async () => {
  const f = await fixture();
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    const connector = await f.joinMember("Connector");
    const events: unknown[] = [];
    connector.client.observePolicy((e) => events.push(e));
    ok(
      await f.owner.client.revokePrincipal({
        principalId: connector.invitation.principalId,
        expectedPolicyHash: f.owner.client.state().policyHash!,
      }),
    );
    assert.deepEqual(await connector.client.fetch(), {
      ok: false,
      code: "unauthorized",
    });
    assert.equal(connector.client.state().status, "revoked");
    assert.equal(connector.client.state().hosts.length, 0);
    assert(
      events.some((e) => (e as { canConnect: boolean }).canConnect === false),
    );
    await f.server.close();
    const before = f.owner.client.state().hosts;
    assert(before.length === 0 || before.length === 1);
    assert.deepEqual(await f.owner.client.fetch(), {
      ok: false,
      code: "unavailable",
    });
    assert.equal(f.owner.client.state().hosts[0].recordId, h.recordId);
    assert.deepEqual(
      await f.owner.client.saveHost({
        record: host(),
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
      { ok: false, code: "unavailable" },
    );
  } finally {
    await f.close();
  }
});
test("staged epoch provider ambiguity resumes same immutable policy instead of replacing encryption keys", async () => {
  const f = await fixture();
  try {
    const member = await f.joinMember("Connector");
    const generation = f.owner.client.state().generation;
    f.owner.keys.failWrite = (a) =>
      a.includes("/metadata-epoch/") && !f.owner.keys.values.has(a);
    const failure = await f.owner.client.changeRole({
      principalId: member.invitation.principalId,
      role: "Viewer",
      expectedPolicyHash: f.owner.client.state().policyHash!,
    });
    assert.deepEqual(failure, { ok: false, code: "key-unavailable" });
    assert.equal(f.owner.client.state().pending, 1);
    assert.equal(f.owner.client.state().generation, generation);
    const staged = f.owner.repository.get("pendingPublication");
    f.owner.keys.failWrite = null;
    ok(await f.owner.client.fetch());
    assert.equal(f.owner.client.state().generation, generation + 1);
    assert.equal(f.owner.client.state().metadataEpoch, 2);
    assert.equal(f.owner.repository.get("pendingPublication"), null);
    assert(staged);
  } finally {
    await f.close();
  }
});
test("reply-loss publication retry returns the original invitation principal/token once and does not duplicate membership", async () => {
  const f = await fixture();
  try {
    // Reopen the same service with the same real repository/provider but intercept only the transport reply.
    await f.owner.client.dispose();
    let lose = true;
    const client = new TeamClient({
      repository: f.owner.repository,
      keyStore: f.owner.keys,
      transportFactory: (o) => {
        const t = createTeamTransport(o);
        return {
          ...t,
          async publish(request, signal) {
            const reply = await t.publish(request, signal);
            if (lose && reply.ok) {
              lose = false;
              return { ok: false, code: "unavailable" };
            }
            return reply;
          },
        };
      },
    });
    try {
      assert.deepEqual(
        await client.invitePrincipal({
          label: "Retry-owned",
          role: "Connector",
        }),
        { ok: false, code: "unavailable" },
      );
      const pending = f.owner.repository.get<{
        invitation: { principalId: string; slot: string };
      }>("pendingPublication");
      assert(pending);
      const invitation = ok(
        await client.invitePrincipal({
          label: "Retry-owned",
          role: "Connector",
        }),
      );
      assert.equal(invitation.principalId, pending.invitation.principalId);
      assert.equal(client.state().members.length, 2);
      assert.equal(client.state().generation, 2);
      assert.equal(client.state().pending, 0);
      const raw = await readFile(join(f.dir, "owner", "team.sqlite"));
      assert(!raw.includes(Buffer.from(invitation.token)));
    } finally {
      await client.dispose();
    }
  } finally {
    await f.close();
  }
});
test("lifecycle fencing purges transient views and rejects delayed provider replies; retained keys support resume", async () => {
  const f = await fixture();
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    let release!: (v: unknown) => void;
    let entered!: (v?: unknown) => void;
    const enteredPromise = new Promise((r) => (entered = r));
    const original = f.owner.keys.read.bind(f.owner.keys);
    let held = true;
    f.owner.keys.read = async (account) => {
      if (held && account.includes("/checkpoint/")) {
        held = false;
        entered();
        await new Promise((r) => (release = r));
      }
      return original(account);
    };
    const pending = f.owner.client.fetch();
    await enteredPromise;
    const epoch = f.owner.client.lifecycleEpoch();
    f.owner.client.lock();
    assert.equal(f.owner.client.lifecycleEpoch(), epoch + 1);
    assert.equal(f.owner.client.state().hosts.length, 0);
    release(undefined);
    assert.deepEqual(await pending, { ok: false, code: "fenced" });
    f.owner.client.unlock();
    ok(await f.owner.client.fetch());
    assert.equal(f.owner.client.state().hosts.length, 1);
    ok(await f.owner.client.logout({ forgetTransportToken: true }));
    assert(f.owner.client.state().needsToken);
    f.owner.client.unlock();
    ok(await f.owner.client.resume({ token: f.token }));
    assert.equal(f.owner.client.state().hosts.length, 1);
  } finally {
    await f.close();
  }
});
test("cached ciphertext reopens locally read-only offline, while every new connect and metadata edit fails closed", async () => {
  const f = await fixture();
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    await f.owner.client.dispose();
    await f.server.close();
    const client = new TeamClient({
      repository: f.owner.repository,
      keyStore: f.owner.keys,
    });
    try {
      assert.equal(client.state().hosts.length, 0);
      assert.deepEqual(await client.fetch(), {
        ok: false,
        code: "unavailable",
      });
      assert.equal(client.state().hosts[0].recordId, h.recordId);
      assert.deepEqual(
        await client.authorizeConnect({
          virtualHostId: client.state().hosts[0].virtualHostId,
          session: session(),
        }),
        { ok: false, code: "unavailable" },
      );
      assert.deepEqual(
        await client.saveHost({
          record: host(),
          expectedMetadataHash: client.state().metadataHash!,
        }),
        { ok: false, code: "unavailable" },
      );
    } finally {
      await client.dispose();
    }
  } finally {
    await f.close();
  }
});
test("Editor online CAS and shared password privileges are distinct; host target edits invalidate prior password binding", async () => {
  const f = await fixture();
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    ok(
      await f.owner.client.sharePassword({
        recordId: h.recordId,
        password: "owner-only-password",
        consent: true,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
        expectedCredentialHash: f.owner.client.state().credentialHash!,
      }),
    );
    const editor = await f.joinMember("Editor");
    const oldHash = editor.client.state().metadataHash!;
    ok(
      await f.owner.client.saveHost({
        record: { ...h, label: "owner change" },
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    assert.deepEqual(
      await editor.client.saveHost({
        record: { ...h, label: "stale edit" },
        expectedMetadataHash: oldHash,
      }),
      { ok: false, code: "conflict" },
    );
    ok(
      await editor.client.saveHost({
        record: { ...h, address: "192.0.2.45" },
        expectedMetadataHash: editor.client.state().metadataHash!,
      }),
    );
    assert.deepEqual(
      await editor.client.sharePassword({
        recordId: h.recordId,
        password: "blocked-editor-password",
        consent: true,
        expectedMetadataHash: editor.client.state().metadataHash!,
        expectedCredentialHash: editor.client.state().credentialHash!,
      }),
      { ok: false, code: "forbidden" },
    );
    const s = session(),
      captured = ok(
        await editor.client.authorizeConnect({
          virtualHostId: editor.client.state().hosts[0].virtualHostId,
          session: s,
        }),
      );
    assert.deepEqual(
      await editor.client.loadManagedPassword({
        session: s,
        source: captured.source!,
      }),
      { ok: false, code: "credentials-unavailable" },
    );
  } finally {
    await f.close();
  }
});
test("checkpoint materialization interruption retains ciphertext journal and resumes exact heads", async () => {
  const f = await fixture();
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    const connector = await f.joinMember("Connector");
    const metadataHash = connector.client.state().metadataHash!;
    let fail = true;
    const original = connector.repository.set.bind(connector.repository);
    connector.repository.set = (key, value) => {
      if (key === "current" && fail) {
        fail = false;
        throw new Error("owned injected materialization failure");
      }
      original(key, value);
    };
    assert.deepEqual(await connector.client.fetch(), {
      ok: false,
      code: "invalid",
    });
    assert(connector.repository.get("pendingMaterialization"));
    ok(await connector.client.fetch());
    assert.equal(connector.client.state().metadataHash, metadataHash);
    assert.equal(connector.repository.get("pendingMaterialization"), null);
  } finally {
    await f.close();
  }
});
test("missing published keys never regenerate identities; unaccepted initial setup can be explicitly cancelled", async () => {
  const f = await fixture();
  try {
    const signing = [...f.owner.keys.values.keys()].find((k) =>
      k.includes("/device-signing/"),
    )!;
    const accounts = f.owner.keys.values.size;
    f.owner.keys.values.delete(signing);
    assert.deepEqual(await f.owner.client.fetch(), {
      ok: false,
      code: "key-unavailable",
    });
    assert.equal(f.owner.keys.values.size, accounts - 1);
    assert.deepEqual(await f.owner.client.cancelSetup(), {
      ok: false,
      code: "forbidden",
    });
    const fresh = f.make("failed-setup");
    fresh.keys.unavailable = true;
    assert.deepEqual(
      await fresh.client.create({
        endpoint: f.endpoint,
        expectedScope: f.scope,
        principalId: randomUUID(),
        token: randomBytes(32).toString("base64url"),
      }),
      { ok: false, code: "key-unavailable" },
    );
    fresh.keys.unavailable = false;
    ok(await fresh.client.cancelSetup());
    assert.equal(fresh.client.state().status, "disabled");
    assert.equal(fresh.keys.values.size, 0);
  } finally {
    await f.close();
  }
});
test("valid signed stale snapshots cannot roll back observed heads, OS pins or virtual host tombstones", async () => {
  const f = await fixture();
  let client: TeamClient | undefined;
  try {
    await f.owner.client.dispose();
    let replay = false;
    let saved: Awaited<ReturnType<TeamTransport["state"]>> | null = null;
    client = new TeamClient({
      repository: f.owner.repository,
      keyStore: f.owner.keys,
      transportFactory: (o) => {
        const t = createTeamTransport(o);
        return {
          ...t,
          state: async (request, signal) => {
            if (replay && saved) return structuredClone(saved);
            const result = await t.state(request, signal);
            if (!saved && result.ok) saved = structuredClone(result);
            return result;
          },
        };
      },
    });
    ok(await client.fetch());
    const initial = client.state().metadataHash;
    const h = host();
    ok(await client.saveHost({ record: h, expectedMetadataHash: initial! }));
    const latest = client.state().metadataHash,
      checkpoint = [...f.owner.keys.values.entries()].find(([k]) =>
        k.includes("/checkpoint/"),
      )!;
    const pinned = Buffer.from(checkpoint[1]);
    replay = true;
    assert.deepEqual(await client.fetch(), {
      ok: false,
      code: "stale-control",
    });
    assert.equal(client.state().metadataHash, latest);
    assert.equal(client.state().hosts.length, 1);
    assert(f.owner.keys.values.get(checkpoint[0])!.equals(pinned));
    assert(f.owner.repository.bindings().every((b) => !b.retired));
  } finally {
    await client?.dispose();
    await f.close();
  }
});
test("offline member catches up several signed edits through bounded verified ancestry without losing bindings", async () => {
  const f = await fixture();
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    const member = await f.joinMember("Connector");
    const id = member.client.state().hosts[0].virtualHostId;
    for (let i = 0; i < 4; i++)
      ok(
        await f.owner.client.saveHost({
          record: { ...h, label: `revision ${i}` },
          expectedMetadataHash: f.owner.client.state().metadataHash!,
        }),
      );
    ok(await member.client.fetch());
    assert.equal(member.client.state().hosts[0].label, "revision 3");
    assert.equal(member.client.state().hosts[0].virtualHostId, id);
    assert(member.repository.bindings().every((b) => !b.retired));
  } finally {
    await f.close();
  }
});

test("observed authorization denial remains revoked across service restart and offline cache restore", async () => {
  const f = await fixture();
  let reopened: TeamClient | undefined;
  try {
    const record = host();
    ok(
      await f.owner.client.saveHost({
        record,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    const connector = await f.joinMember("Connector");
    assert.equal(connector.client.state().hosts.length, 1);
    ok(
      await f.owner.client.revokePrincipal({
        principalId: connector.invitation.principalId,
        expectedPolicyHash: f.owner.client.state().policyHash!,
      }),
    );
    assert.deepEqual(await connector.client.fetch(), {
      ok: false,
      code: "unauthorized",
    });
    assert.equal(connector.client.state().status, "revoked");
    assert.equal(connector.client.state().hosts.length, 0);
    await connector.client.dispose();
    reopened = new TeamClient({
      repository: connector.repository,
      keyStore: connector.keys,
    });
    assert.equal(reopened.state().status, "revoked");
    const restored = ok(await reopened.restore());
    assert.equal(restored.status, "revoked");
    assert.equal(restored.role, null);
    assert.equal(restored.hosts.length, 0);
    assert.deepEqual(await reopened.fetch(), {
      ok: false,
      code: "unauthorized",
    });
    assert.equal(reopened.state().hosts.length, 0);
  } finally {
    await reopened?.dispose();
    await f.close();
  }
});

test("Owner password replacement and detach are CAS-bound and invalidate captured credential heads without readback", async () => {
  const f = await fixture();
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    ok(
      await f.owner.client.sharePassword({
        recordId: h.recordId,
        password: "first-owned-secret",
        consent: true,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
        expectedCredentialHash: f.owner.client.state().credentialHash!,
      }),
    );
    const connector = await f.joinMember("Connector");
    const id = connector.client.state().hosts[0].virtualHostId,
      s = session();
    const captured = ok(
      await connector.client.authorizeConnect({
        virtualHostId: id,
        session: s,
      }),
    );
    const old = f.owner.client.state().credentialHash!;
    ok(
      await f.owner.client.replacePassword({
        recordId: h.recordId,
        password: "replacement-owned-secret",
        consent: true,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
        expectedCredentialHash: old,
      }),
    );
    assert.deepEqual(
      await f.owner.client.detachPassword({
        recordId: h.recordId,
        expectedCredentialHash: old,
      }),
      { ok: false, code: "conflict" },
    );
    assert.deepEqual(
      await connector.client.loadManagedPassword({
        session: s,
        source: captured.source!,
      }),
      { ok: false, code: "stale-control" },
    );
    const fresh = session(),
      target = ok(
        await connector.client.authorizeConnect({
          virtualHostId: id,
          session: fresh,
        }),
      );
    const secret = ok(
      await connector.client.loadManagedPassword({
        session: fresh,
        source: target.source!,
      }),
    );
    assert.equal(
      Buffer.from(secret.bytes).toString(),
      "replacement-owned-secret",
    );
    secret.dispose();
    assert(secret.bytes.every((b) => b === 0));
    ok(
      await f.owner.client.detachPassword({
        recordId: h.recordId,
        expectedCredentialHash: f.owner.client.state().credentialHash!,
      }),
    );
    const detached = session(),
      without = ok(
        await connector.client.authorizeConnect({
          virtualHostId: id,
          session: detached,
        }),
      );
    assert.deepEqual(
      await connector.client.loadManagedPassword({
        session: detached,
        source: without.source!,
      }),
      { ok: false, code: "credentials-unavailable" },
    );
    assert(
      !JSON.stringify(connector.client.state()).includes(
        "replacement-owned-secret",
      ),
    );
  } finally {
    await f.close();
  }
});

test("interrupted ancestry catch-up caches only verified ciphertext and resumes without refetch starvation", async () => {
  const f = await fixture();
  let client: TeamClient | undefined;
  try {
    const h = host();
    ok(
      await f.owner.client.saveHost({
        record: h,
        expectedMetadataHash: f.owner.client.state().metadataHash!,
      }),
    );
    const member = await f.joinMember("Connector");
    const previous = member.client.state().metadataHash!,
      id = member.client.state().hosts[0].virtualHostId;
    await member.client.dispose();
    for (let i = 0; i < 5; i++)
      ok(
        await f.owner.client.saveHost({
          record: { ...h, label: `catchup ${i}` },
          expectedMetadataHash: f.owner.client.state().metadataHash!,
        }),
      );
    let requests = 0,
      fail = true;
    const counts = new Map<string, number>();
    let firstHash = "";
    client = new TeamClient({
      repository: member.repository,
      keyStore: member.keys,
      transportFactory: (o) => {
        const t = createTeamTransport(o);
        return {
          ...t,
          operation: async (domain, hash, signal) => {
            if (!firstHash) firstHash = hash;
            counts.set(hash, (counts.get(hash) ?? 0) + 1);
            requests++;
            if (fail && requests === 2)
              return { ok: false, code: "unavailable" };
            return t.operation(domain, hash, signal);
          },
        };
      },
    });
    const pinEntry = [...member.keys.values.entries()].find(([k]) =>
        k.includes("/checkpoint/"),
      )!,
      pin = Buffer.from(pinEntry[1]);
    assert.deepEqual(await client.fetch(), { ok: false, code: "unavailable" });
    assert.equal(client.state().metadataHash, previous);
    assert(member.keys.values.get(pinEntry[0])!.equals(pin));
    assert(member.repository.bindings().every((b) => !b.retired));
    fail = false;
    ok(await client.fetch());
    assert.equal(counts.get(firstHash), 1);
    assert.equal(client.state().hosts[0].label, "catchup 4");
    assert.equal(client.state().hosts[0].virtualHostId, id);
  } finally {
    await client?.dispose();
    await f.close();
  }
});
