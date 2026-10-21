import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  SyncClient,
  type SyncResult,
} from "../../packages/services/src/sync.ts";
import { openSyncRepository } from "../../packages/adapters/src/sync-repository.ts";
import type { SyncKeyStore } from "../../packages/adapters/src/sync-keychain.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import {
  SecretService,
  TransientSecrets,
} from "../../packages/services/src/index.ts";
import { MemorySecretProvider } from "../fixtures/secrets/memory-provider.ts";
import { SyncServer } from "../../apps/sync-server/src/server.ts";
import type {
  MetadataChange,
  StoreResult,
} from "../../packages/domain/src/index.ts";
const value = <T>(r: SyncResult<T>): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const stored = <T>(r: StoreResult<T>): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
class Keys implements SyncKeyStore {
  readonly items = new Map<string, Buffer>();
  ambiguous = false;
  dropWrites = false;
  refuseDelete = false;
  unavailable = false;
  gate: Promise<void> | null = null;
  async read(a: string) {
    if (this.gate) await this.gate;
    if (this.unavailable) return { status: "unavailable" as const };
    const v = this.items.get(a);
    return v
      ? { status: "present" as const, value: Buffer.from(v) }
      : { status: "missing" as const };
  }
  async write(a: string, v: Uint8Array) {
    if (!this.dropWrites) this.items.set(a, Buffer.from(v));
    return this.ambiguous ? ("unknown" as const) : ("confirmed" as const);
  }
  async delete(a: string) {
    if (this.refuseDelete) return "unknown" as const;
    this.items.delete(a);
    return "confirmed" as const;
  }
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync("/private/tmp/ssterm-sync-client-");
  const token = randomBytes(32);
  const scope = {
    deploymentId: randomUUID(),
    accountId: randomUUID(),
    vaultId: randomUUID(),
  };
  const server = new SyncServer(
    {
      ...scope,
      databasePath: join(dir, "server.sqlite"),
      tokenHash: createHash("sha256").update(token).digest("hex"),
    },
    { requestLimit: 10000 },
  );
  const url = await server.listen();
  const peers: {
    client: SyncClient;
    repository: ReturnType<typeof openSyncRepository>;
    catalog: Awaited<ReturnType<typeof openMetadata>> extends StoreResult<
      infer R
    >
      ? R
      : never;
  }[] = [];
  async function peer(name: string, keys = new Keys()) {
    const home = join(dir, name);
    mkdirSync(home, { mode: 0o700 });
    const catalog = stored(
      await openMetadata({ path: join(home, "catalog.sqlite") }),
    );
    const repository = openSyncRepository(join(home, "sync.sqlite"));
    const transient = new TransientSecrets();
    const localProvider = new MemorySecretProvider();
    const secrets = new SecretService({
      repository: catalog,
      provider: localProvider,
      transient,
    });
    const seam = {
      initialize: async () => {
        const r = await secrets.initializeContentKey();
        return r.status === "ready" || r.status === "published";
      },
      exportBodies: async (ids: string[]) => {
        const r = await secrets.exportSnippetBodies(ids);
        assert.equal(r.status, "ready");
        return r.status === "ready" ? r.bodies : [];
      },
      prepare: secrets.prepareSnippetImport.bind(secrets),
    };
    const client = new SyncClient({
      repository,
      catalog,
      keyStore: keys,
      secrets: seam,
    });
    peers.push({ client, repository, catalog });
    const snapshot = () => stored(catalog.snapshot());
    const commit = (changes: MetadataChange[]) =>
      stored(
        catalog.commit({
          expectedCatalogRevision: snapshot().catalogRevision,
          changes,
        }),
      );
    return {
      client,
      keys,
      catalog,
      repository,
      home,
      secrets,
      localProvider,
      snapshot,
      commit,
      options: { repository, catalog, keyStore: keys, secrets: seam },
    };
  }
  t.after(async () => {
    for (const p of peers) {
      await p.client.dispose();
      p.repository.close();
      p.catalog.close();
    }
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function owner() {
    const p = await peer("owner");
    value(
      await p.client.create({
        endpoint: url,
        token: token.toString("base64url"),
        expectedScope: scope,
      }),
    );
    return p;
  }
  async function joinPeer(
    ownerPeer: Awaited<ReturnType<typeof owner>>,
    name: string,
    role: "writer" | "reader" = "writer",
  ) {
    const p = await peer(name);
    const candidate = value(
      await p.client.beginJoin({
        endpoint: url,
        token: token.toString("base64url"),
        expectedScope: scope,
        expectedOwnerFingerprint: ownerPeer.client.state().ownerFingerprint!,
        role,
      }),
    );
    assert.equal(p.client.state().canCancelSetup, false);
    const challenge = value(
      await ownerPeer.client.challengeEnrollment(candidate),
    );
    const proof = value(await p.client.proveEnrollment(challenge));
    value(
      await ownerPeer.client.approveEnrollment({
        ...proof,
        confirmedFingerprint: proof.fingerprint,
      }),
    );
    value(await p.client.finishJoin());
    return p;
  }
  return { dir, scope, token, url, server, peer, owner, joinPeer };
}

test("real loopback personal sync: enrollment, encrypted portable catalog, offline branches, tombstones and recovery", async (t) => {
  const lab = await fixture(t),
    a = await lab.owner(),
    b = await lab.joinPeer(a, "writer");
  const group = randomUUID(),
    host = randomUUID(),
    identity = randomUUID(),
    tag = randomUUID(),
    snippet = randomUUID();
  a.commit([
    { type: "create-group", id: group, data: { label: "Owned lab" } },
    {
      type: "create-identity",
      id: identity,
      data: { label: "Login", username: "alice", method: "password" },
    },
    {
      type: "create-host",
      id: host,
      data: {
        label: "Private host label",
        address: "fixture.invalid",
        groupId: group,
        auth: { mode: "value", identityId: identity },
      },
    },
    { type: "create-tag", id: tag, data: { label: "Owned" } },
    {
      type: "set-host-tag",
      hostId: host,
      tagId: tag,
      present: true,
      expectedHostRevision: 1,
    },
  ]);
  assert.ok(await a.secrets.initializeContentKey());
  assert.equal(
    (
      await a.secrets.saveSnippet({
        id: snippet,
        label: "Fixture snippet",
        body: Buffer.from("echo private-sync-body"),
      })
    ).status,
    "saved",
  );
  value(await a.client.publish());
  assert.equal(b.snapshot().hosts.length, 0);
  value(await b.client.fetch());
  const initial = value(await b.client.review({ operationHashes: [] }));
  assert.equal(initial.conflicts.length, 0);
  value(
    await b.client.apply({ reviewToken: initial.reviewToken, resolutions: [] }),
  );
  assert.equal(b.snapshot().hosts[0].label, "Private host label");
  assert.notEqual(b.snapshot().hosts[0].id, host);
  assert.equal(b.snapshot().identities[0].passwordRef, null);
  assert.equal(b.snapshot().snippets.length, 1);
  for (const path of [
    join(a.home, "sync.sqlite"),
    join(a.home, "sync.sqlite-wal"),
    join(lab.dir, "server.sqlite"),
  ]) {
    const raw = readFileSync(path);
    assert.equal(raw.includes(Buffer.from("private-sync-body")), false);
    assert.equal(raw.includes(Buffer.from("Private host label")), false);
  }
  // Both devices edit from a common encrypted ancestor; independent records merge.
  const second = randomUUID();
  a.commit([
    {
      type: "create-host",
      id: second,
      data: { label: "Independent A", address: "a.invalid" },
    },
  ]);
  const bt = b.snapshot().tags[0];
  b.commit([
    {
      type: "update-tag",
      id: bt.id,
      expectedRevision: bt.revision,
      data: { label: "Changed by B" },
    },
  ]);
  value(await b.client.publish());
  value(await a.client.publish());
  value(await a.client.fetch());
  const independent = value(await a.client.review({ operationHashes: [] }));
  assert.equal(independent.conflicts.length, 0);
  value(
    await a.client.apply({
      reviewToken: independent.reviewToken,
      resolutions: [],
    }),
  );
  assert.equal(a.snapshot().tags[0].label, "Changed by B");
  assert.equal(a.snapshot().hosts.length, 2);
  value(await a.client.publish());
  value(await b.client.fetch());
  const update = value(await b.client.review({ operationHashes: [] }));
  value(
    await b.client.apply({
      reviewToken: update.reviewToken,
      resolutions: update.conflicts.map((c) => ({
        key: c.key,
        choice: "remote" as const,
      })),
    }),
  );
  // Divergent edits require a captured explicit decision.
  const ah = a.snapshot().hosts.find((h) => h.id === host)!,
    bh = b.snapshot().hosts.find((h) => h.address === "fixture.invalid")!;
  a.commit([
    {
      type: "update-host",
      id: ah.id,
      expectedRevision: ah.revision,
      data: { label: "A changed" },
    },
  ]);
  b.commit([
    {
      type: "update-host",
      id: bh.id,
      expectedRevision: bh.revision,
      data: { label: "B changed" },
    },
  ]);
  value(await b.client.publish());
  value(await a.client.fetch());
  const divergent = value(await a.client.review({ operationHashes: [] }));
  assert.ok(divergent.conflicts.some((c) => c.reason === "different-edits"));
  assert.ok(
    divergent.conflicts.some(
      (c) =>
        c.localPreview.includes("A changed") &&
        c.remotePreview.includes("B changed"),
    ),
  );
  assert.ok(
    divergent.conflicts.every(
      (c) => c.localPreview.length <= 2048 && c.remotePreview.length <= 2048,
    ),
  );
  assert.equal(
    (
      await a.client.apply({
        reviewToken: divergent.reviewToken,
        resolutions: [],
      })
    ).ok,
    false,
  );
  const decided = value(await a.client.review({ operationHashes: [] }));
  value(
    await a.client.apply({
      reviewToken: decided.reviewToken,
      resolutions: decided.conflicts.map((c) => ({
        key: c.key,
        choice: "local" as const,
      })),
    }),
  );
  assert.equal(
    a.snapshot().hosts.find((h) => h.id === host)?.label,
    "A changed",
  );
  // Recovery kit is verified offline before publishing its descriptor, then fresh owner/epoch replaces lost owner.
  const kit = value(await a.client.createRecovery());
  assert.equal(a.client.state().recoveryReady, false);
  value(
    await a.client.confirmRecovery({
      confirmationToken: kit.confirmationToken,
      secret: kit.secret,
      kit: kit.kit,
    }),
  );
  assert.equal(a.client.state().recoveryReady, true);
  const recovered = await lab.peer("recovered");
  const previous = a.client.state();
  value(
    await recovered.client.recover({
      endpoint: lab.url,
      token: lab.token.toString("base64url"),
      expectedScope: lab.scope,
      expectedOwnerFingerprint: previous.ownerFingerprint!,
      secret: kit.secret,
      kit: kit.kit,
    }),
  );
  assert.equal(recovered.client.state().epoch, previous.epoch + 1);
  assert.notEqual(
    recovered.client.state().ownerFingerprint,
    previous.ownerFingerprint,
  );
  assert.equal(
    recovered.client
      .state()
      .devices.some((d) => d.deviceId === previous.deviceId),
    false,
  );
  value(await recovered.client.fetch());
  const recoverReview = value(
    await recovered.client.review({ operationHashes: [] }),
  );
  value(
    await recovered.client.apply({
      reviewToken: recoverReview.reviewToken,
      resolutions: recoverReview.conflicts.map((c) => ({
        key: c.key,
        choice: "remote" as const,
      })),
    }),
  );
  assert.ok(recovered.snapshot().hosts.length >= 1);
});

test("provider ambiguity, cold restart, single-use enrollment and lock fences preserve durable immutable state", async (t) => {
  const lab = await fixture(t);
  const a = await lab.peer("owner");
  a.keys.ambiguous = true;
  value(
    await a.client.create({
      endpoint: lab.url,
      token: lab.token.toString("base64url"),
      expectedScope: lab.scope,
    }),
  );
  const b = await lab.peer("pending");
  const candidate = value(
    await b.client.beginJoin({
      endpoint: lab.url,
      token: lab.token.toString("base64url"),
      expectedScope: lab.scope,
      expectedOwnerFingerprint: a.client.state().ownerFingerprint!,
      role: "reader",
    }),
  );
  const challenge = value(await a.client.challengeEnrollment(candidate));
  const proof = value(await b.client.proveEnrollment(challenge));
  assert.equal(
    (
      await a.client.approveEnrollment({
        ...proof,
        confirmedFingerprint: "0".repeat(64),
      })
    ).ok,
    false,
  );
  value(
    await a.client.approveEnrollment({
      ...proof,
      confirmedFingerprint: proof.fingerprint,
    }),
  );
  assert.equal(
    (
      await a.client.approveEnrollment({
        ...proof,
        confirmedFingerprint: proof.fingerprint,
      })
    ).ok,
    false,
  );
  value(await b.client.finishJoin());
  assert.deepEqual(await b.client.publish(), { ok: false, code: "forbidden" });
  const before = a.client.state();
  await a.client.dispose();
  const fresh = new SyncClient(a.options);
  fresh.unlock();
  assert.equal(fresh.state().deviceId, before.deviceId);
  value(await fresh.fetch());
  // A provider read finishing after lock cannot publish or cache its bytes.
  let release!: () => void;
  a.keys.gate = new Promise<void>((r) => (release = r));
  const pending = fresh.publish();
  await new Promise((r) => setImmediate(r));
  fresh.lock();
  release();
  assert.deepEqual(await pending, { ok: false, code: "fenced" });
  a.keys.gate = null;
  fresh.unlock();
  a.keys.unavailable = true;
  assert.deepEqual(await fresh.publish(), {
    ok: false,
    code: "key-unavailable",
  });
  a.keys.unavailable = false;
  await fresh.dispose();
});

test("unseen historical author after revocation is retained as conflict and requires fresh current-writer reconciliation", async (t) => {
  const lab = await fixture(t),
    a = await lab.owner(),
    b = await lab.joinPeer(a, "remaining"),
    c = await lab.joinPeer(a, "later-revoked");
  const host = randomUUID();
  c.commit([
    {
      type: "create-host",
      id: host,
      data: { label: "Unseen historical value", address: "owned.invalid" },
    },
  ]);
  value(await c.client.publish());
  const stale = c.repository.operations().find((o) => o.direction === "out")!;
  value(
    await a.client.rotate({
      removeDeviceIds: [c.client.state().deviceId!],
      readerDeviceIds: [],
    }),
  );
  assert.deepEqual(await c.client.fetch(), { ok: false, code: "forbidden" });
  assert.equal(c.client.state().status, "revoked");
  assert.equal(c.snapshot().hosts[0].label, "Unseen historical value");
  value(await b.client.fetch());
  assert.ok(
    b.repository
      .operations()
      .some((o) => o.hash === stale.hash && o.verdict === "conflict"),
  );
  const review = value(
    await b.client.review({ operationHashes: [stale.hash] }),
  );
  assert.ok(review.conflicts.some((r) => r.reason === "stale-control"));
  assert.deepEqual(
    await b.client.apply({ reviewToken: review.reviewToken, resolutions: [] }),
    { ok: false, code: "stale-control" },
  );
  assert.equal(b.snapshot().hosts.length, 0);
  const accepted = value(
    await b.client.review({ operationHashes: [stale.hash] }),
  );
  value(
    await b.client.apply({
      reviewToken: accepted.reviewToken,
      resolutions: accepted.conflicts.map((r) => ({
        key: r.key,
        choice: "remote" as const,
      })),
    }),
  );
  assert.equal(b.snapshot().hosts[0].label, "Unseen historical value");
  const fresh = b.repository
    .operations()
    .find((o) => o.direction === "out" && o.hash !== stale.hash)!;
  assert.ok(fresh);
  assert.notEqual(fresh.salt, stale.salt);
  assert.notEqual(fresh.operationId, stale.operationId);
  assert.equal(fresh.epoch, b.client.state().epoch);
  assert.ok(fresh.sequence);
  // Historical plaintext can be read as ancestry, but a demoted reader cannot authorize reconciliation.
  value(
    await a.client.rotate({
      removeDeviceIds: [],
      readerDeviceIds: [b.client.state().deviceId!],
    }),
  );
  value(await b.client.fetch());
  const reader = value(
    await b.client.review({ operationHashes: [stale.hash] }),
  );
  assert.deepEqual(
    await b.client.apply({
      reviewToken: reader.reviewToken,
      resolutions: reader.conflicts.map((r) => ({
        key: r.key,
        choice: "remote" as const,
      })),
    }),
    { ok: false, code: "forbidden" },
  );
});

test("Keychain checkpoint high-water fences restored SQL and verifies contiguous reconciliation", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const lab = await fixture(t),
    a = await lab.owner();
  const oldConfiguration = a.repository.get("configuration");
  const before = a.client.state();
  await lab.joinPeer(a, "enrolled-after-backup");
  const generation = a.client.state().generation;
  assert.ok(generation > before.generation);
  // Restore the public SQL metadata from an older backup while OS Keychain keeps the newer pin.
  const db = new DatabaseSync(join(a.home, "sync.sqlite"));
  db.prepare("DELETE FROM control WHERE generation>?").run(before.generation);
  a.repository.set("configuration", oldConfiguration);
  db.close();
  assert.deepEqual(await a.client.publish(), {
    ok: false,
    code: "stale-control",
  });
  assert.equal(a.repository.operations().length, 0);
  value(await a.client.fetch());
  assert.equal(a.client.state().generation, generation);
  // A conflicting checkpoint at the same generation is never overwritten by discovery/server trust.
  const checkpoint = [...a.keys.items.keys()].find((k) =>
    k.includes("/checkpoint/"),
  )!;
  const exact = Buffer.from(a.keys.items.get(checkpoint)!);
  const forged = JSON.parse(exact.toString());
  forged.hash = "0".repeat(64);
  a.keys.items.set(checkpoint, Buffer.from(JSON.stringify(forged)));
  assert.deepEqual(await a.client.publish(), {
    ok: false,
    code: "stale-control",
  });
  assert.deepEqual(await a.client.fetch(), {
    ok: false,
    code: "stale-control",
  });
  a.keys.items.set(checkpoint, exact);
  value(await a.client.fetch());
});

test("catalog and sync-store crash windows reconcile without duplicate catalog imports or plaintext journals", async (t) => {
  const lab = await fixture(t),
    a = await lab.owner(),
    b = await lab.joinPeer(a, "crash-target");
  a.commit([
    {
      type: "create-host",
      id: randomUUID(),
      data: { label: "Crash-safe import", address: "owned.invalid" },
    },
  ]);
  value(await a.client.publish());
  value(await b.client.fetch());
  let mode: "before" | "after" | "none" = "before";
  const catalog = {
    snapshot: b.catalog.snapshot.bind(b.catalog),
    backup: b.catalog.backup.bind(b.catalog),
    close: () => {},
    commit: (request: Parameters<typeof b.catalog.commit>[0]) => {
      if (mode === "before") throw new Error("owned crash before commit");
      const result = b.catalog.commit(request);
      if (mode === "after") throw new Error("owned crash after commit");
      return result;
    },
  };
  let client = new SyncClient({ ...b.options, catalog });
  let review = value(await client.review({ operationHashes: [] }));
  assert.equal(
    (await client.apply({ reviewToken: review.reviewToken, resolutions: [] }))
      .ok,
    false,
  );
  assert.equal(b.snapshot().hosts.length, 0);
  assert.ok(b.repository.get("materialization"));
  await client.dispose();
  client = new SyncClient({ ...b.options, catalog });
  mode = "after";
  review = value(await client.review({ operationHashes: [] }));
  assert.equal(b.repository.get("materialization"), null);
  assert.equal(
    (await client.apply({ reviewToken: review.reviewToken, resolutions: [] }))
      .ok,
    false,
  );
  assert.equal(b.snapshot().hosts.length, 1);
  const revision = b.snapshot().catalogRevision;
  assert.ok(b.repository.get("materialization"));
  await client.dispose();
  client = new SyncClient({ ...b.options, catalog });
  mode = "none";
  value(await client.review({ operationHashes: [] }));
  assert.equal(b.repository.get("materialization"), null);
  assert.equal(b.snapshot().hosts.length, 1);
  assert.equal(b.snapshot().catalogRevision, revision);
  assert.equal(
    readFileSync(join(b.home, "sync.sqlite-wal")).includes(
      Buffer.from("Crash-safe import"),
    ),
    false,
  );
  await client.dispose();
});

test("unpublished setup cancellation deletes exact staged refs with readback and permits explicit fresh setup", async (t) => {
  const lab = await fixture(t),
    a = await lab.peer("failed-setup");
  a.keys.dropWrites = true;
  assert.deepEqual(
    await a.client.create({
      endpoint: lab.url,
      token: lab.token.toString("base64url"),
      expectedScope: lab.scope,
    }),
    { ok: false, code: "key-unavailable" },
  );
  const old = a.repository.get<{ deviceId: string; refs: { token: string } }>(
    "configuration",
  )!;
  assert.ok(old.refs.token);
  assert.equal(a.client.state().ownerFingerprint, null);
  assert.equal(a.client.state().canCancelSetup, true);
  assert.equal(a.repository.controls().length, 0);
  assert.equal(a.repository.get("pendingControl"), null);
  // An ambiguous deletion with the exact item still present leaves a retryable cancellation journal.
  const account = a.repository.get<{ account: string }>(
    "provider/" + old.refs.token,
  )!.account;
  a.keys.items.set(account, Buffer.from(lab.token));
  a.keys.refuseDelete = true;
  assert.deepEqual(await a.client.cancelSetup(), {
    ok: false,
    code: "key-unavailable",
  });
  assert.ok(a.repository.get("setupCancellation"));
  assert.ok(a.repository.get("configuration"));
  a.keys.refuseDelete = false;
  value(await a.client.cancelSetup());
  assert.equal(a.keys.items.size, 0);
  assert.equal(a.client.state().status, "disabled");
  assert.equal(a.repository.get("setupCancellation"), null);
  a.keys.dropWrites = false;
  value(
    await a.client.create({
      endpoint: lab.url,
      token: lab.token.toString("base64url"),
      expectedScope: lab.scope,
    }),
  );
  assert.notEqual(a.client.state().deviceId, old.deviceId);
  assert.deepEqual(await a.client.cancelSetup(), {
    ok: false,
    code: "conflict",
  });
});

test("logout token forgetting resumes the existing device without replacing encryption identities", async (t) => {
  const lab = await fixture(t),
    a = await lab.owner();
  a.commit([
    {
      type: "create-host",
      id: randomUUID(),
      data: { label: "Retained across logout", address: "owned.invalid" },
    },
  ]);
  value(await a.client.publish());
  const before = a.client.state();
  const refs = structuredClone(
    a.repository.get<{ refs: Record<string, string> }>("configuration")!.refs,
  );
  value(await a.client.logout({ forgetTransportToken: true }));
  assert.equal(a.client.state().needsToken, true);
  a.client.unlock();
  const count = a.keys.items.size;
  assert.deepEqual(
    await a.client.resume({ token: randomBytes(32).toString("base64url") }),
    { ok: false, code: "unauthorized" },
  );
  assert.equal(a.client.state().needsToken, true);
  assert.equal(a.keys.items.size, count);
  assert.equal(a.repository.get("resumeToken"), null);
  // A dropped OS write retains its exact unpublished reference for a same-token lookup/retry.
  a.keys.dropWrites = true;
  assert.deepEqual(
    await a.client.resume({ token: lab.token.toString("base64url") }),
    { ok: false, code: "key-unavailable" },
  );
  const pending = a.repository.get<{ ref: string }>("resumeToken")!;
  assert.ok(pending.ref);
  assert.equal(a.client.state().needsToken, true);
  a.keys.dropWrites = false;
  value(await a.client.resume({ token: lab.token.toString("base64url") }));
  const after = a.client.state();
  assert.equal(after.needsToken, false);
  assert.equal(after.deviceId, before.deviceId);
  assert.equal(after.epoch, before.epoch);
  assert.equal(after.ownerFingerprint, before.ownerFingerprint);
  const resumed = a.repository.get<{ refs: Record<string, string> }>(
    "configuration",
  )!.refs;
  assert.equal(resumed.token, pending.ref);
  for (const [slot, ref] of Object.entries(refs))
    if (slot !== "token") assert.equal(resumed[slot], ref);
  assert.notEqual(resumed.token, refs.token);
  assert.equal(a.snapshot().hosts[0].label, "Retained across logout");
  value(await a.client.fetch());
  assert.deepEqual(
    await a.client.resume({ token: lab.token.toString("base64url") }),
    { ok: false, code: "conflict" },
  );
});

test("forget token also deletes a confirmed resume token that revocation prevented attaching", async (t) => {
  const lab = await fixture(t),
    owner = await lab.owner(),
    peer = await lab.joinPeer(owner, "revoked-resume");
  peer.commit([
    {
      type: "create-host",
      id: randomUUID(),
      data: { label: "Retained revoked catalog", address: "owned.invalid" },
    },
  ]);
  const identity = peer.client.state().deviceId;
  const original = structuredClone(
    peer.repository.get<{ refs: Record<string, string> }>("configuration")!
      .refs,
  );
  value(await peer.client.logout({ forgetTransportToken: true }));
  value(
    await owner.client.rotate({
      removeDeviceIds: [identity!],
      readerDeviceIds: [],
    }),
  );
  peer.client.unlock();
  const keyCount = peer.keys.items.size;
  assert.deepEqual(
    await peer.client.resume({ token: lab.token.toString("base64url") }),
    { ok: false, code: "forbidden" },
  );
  assert.equal(peer.client.state().status, "revoked");
  assert.equal(peer.client.state().needsToken, true);
  const pending = peer.repository.get<{ ref: string }>("resumeToken")!;
  const provider = peer.repository.get<{ state: string; account: string }>(
    "provider/" + pending.ref,
  )!;
  assert.equal(provider.state, "confirmed");
  assert.ok(peer.keys.items.has(provider.account));
  assert.equal(peer.keys.items.size, keyCount + 1);
  assert.equal(
    peer.repository.get<{ refs: Record<string, string> }>("configuration")!.refs
      .token,
    undefined,
  );
  peer.keys.refuseDelete = true;
  assert.deepEqual(await peer.client.logout({ forgetTransportToken: true }), {
    ok: false,
    code: "key-unavailable",
  });
  assert.ok(peer.repository.get("tokenDeletion"));
  assert.ok(peer.repository.get("resumeToken"));
  assert.ok(peer.keys.items.has(provider.account));
  peer.keys.refuseDelete = false;
  value(await peer.client.logout({ forgetTransportToken: true }));
  assert.equal(peer.repository.get("resumeToken"), null);
  assert.equal(peer.repository.get("provider/" + pending.ref), null);
  assert.equal(peer.repository.get("tokenDeletion"), null);
  assert.equal(peer.keys.items.has(provider.account), false);
  assert.equal(peer.keys.items.size, keyCount);
  assert.equal(peer.client.state().deviceId, identity);
  const retained = peer.repository.get<{ refs: Record<string, string> }>(
    "configuration",
  )!.refs;
  for (const [slot, ref] of Object.entries(original))
    if (slot !== "token") assert.equal(retained[slot], ref);
  assert.equal(peer.snapshot().hosts[0].label, "Retained revoked catalog");
});

test("Review warns before remote login changes detach a locally saved password without mutating provider or catalog", async (t) => {
  const lab = await fixture(t),
    a = await lab.owner(),
    b = await lab.joinPeer(a, "saved-password-consent");
  const identity = randomUUID();
  a.commit([
    {
      type: "create-identity",
      id: identity,
      data: { label: "Portable login", username: "alice", method: "password" },
    },
  ]);
  value(await a.client.publish());
  value(await b.client.fetch());
  const initial = value(await b.client.review({ operationHashes: [] }));
  value(
    await b.client.apply({ reviewToken: initial.reviewToken, resolutions: [] }),
  );
  const imported = b.snapshot().identities[0];
  const password = Buffer.from("owned-local-password-never-reviewed");
  try {
    assert.equal(
      (
        await b.secrets.storeSecret({
          kind: "password",
          owner: {
            type: "identity",
            id: imported.id,
            expectedRevision: imported.revision,
          },
          value: password,
        })
      ).status,
      "published",
    );
  } finally {
    password.fill(0);
  }
  const before = b.snapshot();
  const saved = before.identities[0];
  assert.ok(saved.passwordRef);
  const providerBefore = [...b.localProvider.items.entries()].map(
    ([key, body]) => [key, Buffer.from(body)] as const,
  );
  const writes = b.localProvider.count("write"),
    deletes = b.localProvider.count("delete");
  const remote = a.snapshot().identities.find((row) => row.id === identity)!;
  a.commit([
    {
      type: "update-identity",
      id: identity,
      expectedRevision: remote.revision,
      data: { username: "bob" },
    },
  ]);
  value(await a.client.publish());
  value(await b.client.fetch());
  const review = value(await b.client.review({ operationHashes: [] }));
  assert.ok(
    review.warnings.some(
      (w) =>
        w.includes("1 saved login(s)") &&
        w.includes("detaches the local password") &&
        w.includes("Keychain cleanup after Apply"),
    ),
  );
  assert.equal(b.snapshot().catalogRevision, before.catalogRevision);
  assert.equal(b.snapshot().identities[0].username, "alice");
  assert.equal(b.snapshot().identities[0].passwordRef, saved.passwordRef);
  assert.equal(b.localProvider.count("write"), writes);
  assert.equal(b.localProvider.count("delete"), deletes);
  assert.deepEqual([...b.localProvider.items.entries()], providerBefore);
  assert.equal(
    b.snapshot().secretOperations.some((op) => op.state === "cleanup"),
    false,
  );
  assert.equal(
    JSON.stringify(review).includes("owned-local-password-never-reviewed"),
    false,
  );
  assert.equal(JSON.stringify(review).includes(saved.passwordRef!), false);
  for (const [, body] of providerBefore) body.fill(0);
});

test("bounded sync mutation admission refuses excess queued work and releases permits after lock fencing", async (t) => {
  const lab = await fixture(t);
  const owner = await lab.owner();
  let release!: () => void;
  owner.keys.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = Array.from({ length: 8 }, () => owner.client.fetch());
  try {
    assert.deepEqual(await owner.client.fetch(), { ok: false, code: "busy" });
    owner.client.lock();
    release();
    for (const result of await Promise.all(admitted))
      assert.deepEqual(result, { ok: false, code: "fenced" });
    owner.keys.gate = null;
    owner.client.unlock();
    value(await owner.client.fetch());
  } finally {
    owner.keys.gate = null;
    release();
  }
});

test("control history admission is bounded without evicting existing checkpoints or breaking exact retries", async (t) => {
  const directory = mkdtempSync("/private/tmp/ssterm-sync-control-budget-");
  const path = join(directory, "sync.sqlite");
  let repository = openSyncRepository(path);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (let generation = 1; generation <= 256; generation++)
    repository.addControl({
      generation,
      hash: generation.toString(16).padStart(64, "0"),
      publication: { owned: "opaque storage fixture" },
    });
  repository.addControl({
    generation: 256,
    hash: (256).toString(16).padStart(64, "0"),
    publication: { owned: "opaque storage fixture" },
  });
  assert.throws(
    () =>
      repository.addControl({
        generation: 257,
        hash: (257).toString(16).padStart(64, "0"),
        publication: { owned: "rejected storage fixture" },
      }),
    (error) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "too-large",
  );
  assert.equal(repository.controls().length, 256);
  repository.close();
  repository = openSyncRepository(path);
  assert.equal(repository.controls().length, 256);
});
