import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ssh2 from "ssh2";
import {
  decodeHostPublicKey,
  openMetadata,
  validHostKeyIdentity,
} from "../../packages/adapters/src/index.ts";
import {
  CatalogModule,
  KnownHostPolicy,
  SessionRegistry,
  TransientSecrets,
  type KnownHostResult,
  type TrustChallenge,
  type TrustDecision,
} from "../../packages/services/src/index.ts";
import type {
  MetadataRepository,
  ResolvedHostConfig,
  StoreResult,
} from "../../packages/domain/src/index.ts";

function value<T>(result: StoreResult<T> | KnownHostResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}
function code(
  result: KnownHostResult<unknown> | StoreResult<unknown>,
  expected: string,
): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, expected);
    assert(
      !/SELECT|fixture-sensitive|private|BEGIN/u.test(result.error.message),
    );
  }
}
function ed25519(): Buffer {
  const key = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .subarray(-32);
  const type = Buffer.from("ssh-ed25519");
  const length = (size: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(size);
    return bytes;
  };
  return Buffer.concat([length(type.length), type, length(key.length), key]);
}
const key = ed25519(),
  replacement = ed25519(),
  third = ed25519();
async function fixture(t: TestContext) {
  const dir = mkdtempSync("/private/tmp/ssterm-known-hosts-");
  const path = join(dir, "metadata.db");
  const repository = value(await openMetadata({ path }));
  let now = new Date("2026-10-15T10:00:00.000Z");
  const policy = new KnownHostPolicy({ repository, now: () => now });
  t.after(() => {
    policy.dispose();
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const verify = (
    decision: TrustDecision = "remember",
    publicKey = key,
    endpointHost = "EXAMPLE.COM.",
    endpointPort = 22,
  ) =>
    policy.verify({
      endpointHost,
      endpointPort,
      publicKey,
      signal: new AbortController().signal,
      requestDecision: async () => decision,
    });
  /** A prompt held open until the test answers it; the policy reads trust when called. */
  const held = (publicKey: Buffer, endpointHost = "example.com") => {
    let answer!: (decision: TrustDecision) => void;
    const result = policy.verify({
      endpointHost,
      endpointPort: 22,
      publicKey,
      signal: new AbortController().signal,
      requestDecision: () =>
        new Promise((done) => {
          answer = done;
        }),
    });
    return { result, answer: (decision: TrustDecision) => answer(decision) };
  };
  const unrelatedSave = () => {
    const snapshot = value(repository.snapshot());
    value(
      repository.commit({
        expectedCatalogRevision: snapshot.catalogRevision,
        changes: [
          {
            type: "update-vault",
            expectedRevision: snapshot.vault.revision,
            data: { label: randomUUID() },
          },
        ],
      }),
    );
  };
  return {
    policy,
    repository,
    path,
    verify,
    held,
    unrelatedSave,
    time: (time: string) => {
      now = new Date(time);
    },
  };
}

test("mature parser accepts all selected public key algorithms and rejects non-wire, private, unsupported and trailing bytes", () => {
  const samples: Buffer[] = [key];
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = rsa.privateKey.export({ type: "pkcs1", format: "pem" });
  for (const pem of [
    privateKey,
    ...["prime256v1", "secp384r1", "secp521r1"].map((namedCurve) =>
      generateKeyPairSync("ec", { namedCurve }).privateKey.export({
        type: "sec1",
        format: "pem",
      }),
    ),
  ]) {
    const parsed = ssh2.utils.parseKey(pem);
    assert(!(parsed instanceof Error) && !Array.isArray(parsed));
    samples.push(parsed.getPublicSSH());
  }
  assert.deepEqual(
    samples.map((bytes) => valueIdentity(bytes).algorithm),
    [
      "ssh-ed25519",
      "ssh-rsa",
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
    ],
  );
  for (const wire of samples) {
    const identity = valueIdentity(wire);
    assert(validHostKeyIdentity(identity));
    assert(!validHostKeyIdentity({ ...identity, algorithm: "ssh-dss" }));
    assert(
      !validHostKeyIdentity({
        ...identity,
        fingerprint: `SHA256:${"A".repeat(43)}`,
      }),
    );
    assert(
      !validHostKeyIdentity({
        ...identity,
        publicKey: identity.publicKey + " comment",
      }),
    );
    assert.equal(
      decodeHostPublicKey(Buffer.concat([wire, Buffer.from([0])])),
      undefined,
    );
    assert.equal(
      decodeHostPublicKey(wire.subarray(0, wire.length - 1)),
      undefined,
    );
  }
  for (const wire of [
    Buffer.alloc(0),
    Buffer.alloc(16_385),
    Buffer.from("fixture-sensitive"),
    Buffer.from(privateKey),
    Buffer.from(valueIdentity(key).publicKey),
    Buffer.from([0, 0, 0, 7, ...Buffer.from("ssh-dss")]),
  ])
    assert.equal(decodeHostPublicKey(wire), undefined);
});
function valueIdentity(wire: Uint8Array) {
  const identity = decodeHostPublicKey(wire);
  assert(identity);
  return identity;
}

test("unknown reject/accept-once never persist; remember and matching keys persist timestamps across restart", async (t) => {
  const f = await fixture(t);
  code(await f.verify("reject"), "untrusted");
  assert.equal(value(await f.verify("accept-once")).decision, "accept-once");
  assert.deepEqual(value(f.policy.list()), []);
  assert.equal(value(await f.verify()).decision, "remember");
  const first = value(f.policy.list())[0]!;
  assert.equal(first.endpointHost, "example.com");
  assert(!("publicKey" in first));
  f.time("2026-10-15T10:01:00.000Z");
  const catalogRevision = value(f.repository.snapshot()).catalogRevision;
  assert.equal(value(await f.verify("reject")).decision, "known");
  const verified = value(f.policy.list())[0]!;
  // A match records lastVerifiedAt without revising the row or the catalog.
  assert.equal(verified.revision, 1);
  assert.equal(value(f.repository.snapshot()).catalogRevision, catalogRevision);
  assert.equal(verified.firstAcceptedAt, first.firstAcceptedAt);
  assert.equal(verified.lastVerifiedAt, "2026-10-15T10:01:00.000Z");
  f.repository.close();
  const reopened = value(await openMetadata({ path: f.path }));
  t.after(() => reopened.close());
  const policy = new KnownHostPolicy({ repository: reopened });
  assert.equal(
    value(
      await policy.verify({
        endpointHost: "example.com",
        endpointPort: 22,
        publicKey: key,
        signal: new AbortController().signal,
        requestDecision: async () => {
          assert.fail("matching key prompted");
        },
      }),
    ).decision,
    "known",
  );
});

test("changed keys expose old/new identities and allow only deliberate replacement, preserving endpoint identity", async (t) => {
  const f = await fixture(t);
  value(await f.verify());
  const first = value(f.policy.list())[0]!;
  let challenge: TrustChallenge | undefined;
  const changed = (decision: TrustDecision) =>
    f.policy.verify({
      endpointHost: "example.com",
      endpointPort: 22,
      publicKey: replacement,
      signal: new AbortController().signal,
      requestDecision: async (input) => {
        challenge = input;
        return decision;
      },
    });
  code(await changed("reject"), "changed");
  code(await changed("accept-once"), "invalid-request");
  code(await changed("remember"), "invalid-request");
  assert.equal(challenge?.kind, "changed");
  if (challenge?.kind === "changed") {
    assert.equal(challenge.previousFingerprint, first.fingerprint);
    assert.equal(challenge.fingerprint, valueIdentity(replacement).fingerprint);
  }
  assert.equal(value(f.policy.list())[0]!.revision, 1);
  f.time("2026-10-15T11:00:00.000Z");
  assert.equal(value(await changed("replace")).decision, "replace");
  const after = value(f.policy.list())[0]!;
  assert.equal(after.id, first.id);
  assert.equal(after.revision, 2);
  assert.equal(after.firstAcceptedAt, "2026-10-15T11:00:00.000Z");
  assert.equal(value(await f.verify("reject", replacement)).decision, "known");
});

test("normalized IDNA/IPv6 and distinct ports share trust independently of catalog edits", async (t) => {
  const f = await fixture(t);
  value(await f.verify("remember", key, "bücher.example", 2222));
  assert.equal(
    value(await f.verify("reject", key, "xn--bcher-kva.example", 2222))
      .decision,
    "known",
  );
  value(await f.verify("remember", key, "[2001:0db8::1]"));
  assert.equal(
    value(await f.verify("reject", key, "2001:db8::1")).decision,
    "known",
  );
  value(await f.verify("remember", key, "bücher.example", 22));
  const id = randomUUID();
  let snapshot = value(f.repository.snapshot());
  value(
    f.repository.commit({
      expectedCatalogRevision: snapshot.catalogRevision,
      changes: [
        {
          type: "create-host",
          id,
          data: { label: "ก่อน", address: "bücher.example" },
        },
      ],
    }),
  );
  snapshot = value(f.repository.snapshot());
  value(
    f.repository.commit({
      expectedCatalogRevision: snapshot.catalogRevision,
      changes: [
        {
          type: "update-host",
          id,
          expectedRevision: 1,
          data: { label: "หลัง" },
        },
      ],
    }),
  );
  assert.equal(
    value(await f.verify("reject", key, "bücher.example", 2222)).decision,
    "known",
  );
  snapshot = value(f.repository.snapshot());
  value(
    f.repository.commit({
      expectedCatalogRevision: snapshot.catalogRevision,
      changes: [{ type: "delete-host", id, expectedRevision: 2 }],
    }),
  );
  assert.equal(
    value(await f.verify("reject", key, "bücher.example", 22)).decision,
    "known",
  );
  assert.equal(value(f.policy.list()).length, 3);
  for (const port of [0, 65536, 1.1, NaN])
    code(
      await f.verify("remember", key, "example.com", port),
      "invalid-request",
    );
});

test("terminal, SFTP and tunnel callers share one endpoint decision and one changed-key block", async (t) => {
  const f = await fixture(t);
  const callers = ["terminal", "sftp", "tunnel"] as const;
  const prompted: string[] = [];
  const verify = (caller: string, publicKey: Buffer, decision: TrustDecision) =>
    f.policy.verify({
      endpointHost: "shared.example",
      endpointPort: 22,
      publicKey,
      signal: new AbortController().signal,
      requestDecision: async (challenge) => {
        prompted.push(`${caller}:${challenge.kind}`);
        return decision;
      },
    });
  value(await verify("terminal", key, "remember"));
  for (const caller of callers)
    assert.equal(value(await verify(caller, key, "reject")).decision, "known");
  for (const caller of callers)
    code(await verify(caller, replacement, "reject"), "changed");
  assert.deepEqual(prompted, [
    "terminal:unknown",
    "terminal:changed",
    "sftp:changed",
    "tunnel:changed",
  ]);
  const [row] = value(f.policy.list());
  assert.equal(row!.fingerprint, valueIdentity(key).fingerprint);
});

test("decisions survive unrelated saves and other endpoints but conflict when their own endpoint changed", async (t) => {
  const f = await fixture(t);
  value(await f.verify("remember", key, "c.example"));
  for (const decision of ["accept-once", "remember"] as const) {
    const b = f.held(key, "b.example");
    f.unrelatedSave();
    value(await f.verify("reject", key, "c.example"));
    if (decision === "remember")
      value(await f.verify("remember", key, "a.example"));
    b.answer(decision);
    assert.equal(value(await b.result).decision, decision);
  }
  // Two pending prompts for one endpoint: the first remembered key voids the second approval.
  const first = f.held(key, "d.example"),
    second = f.held(key, "d.example");
  first.answer("remember");
  value(await first.result);
  second.answer("accept-once");
  code(await second.result, "conflict");
  assert.deepEqual(
    value(f.policy.list()).map((row) => row.endpointHost),
    ["a.example", "b.example", "c.example", "d.example"],
  );
});

test("a routine match keeps catalog previews valid", async (t) => {
  const f = await fixture(t);
  value(await f.verify());
  const catalog = new CatalogModule({ repository: f.repository });
  const preview = value(
    catalog.prepare({
      type: "create-host",
      data: { label: "lab", address: "example.com" },
    }),
  );
  f.time("2026-10-15T10:05:00.000Z");
  assert.equal(value(await f.verify("reject")).decision, "known");
  assert.equal(
    value(f.policy.list())[0]!.lastVerifiedAt,
    "2026-10-15T10:05:00.000Z",
  );
  value(catalog.apply(preview.token));
});

test("cancellation during or after a prompt never persists or authorizes trust", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  code(
    await f.policy.verify({
      endpointHost: "example.com",
      endpointPort: 22,
      publicKey: key,
      signal: controller.signal,
      requestDecision: async () => {
        controller.abort();
        return "remember";
      },
    }),
    "cancelled",
  );
  assert.deepEqual(value(f.policy.list()), []);
  controller.abort();
  code(
    await f.policy.verify({
      endpointHost: "example.com",
      endpointPort: 22,
      publicKey: key,
      signal: controller.signal,
      requestDecision: async () => {
        assert.fail("aborted prompt");
      },
    }),
    "cancelled",
  );
  const ignored = new AbortController();
  const pending = f.policy.verify({
    endpointHost: "example.com",
    endpointPort: 22,
    publicKey: key,
    signal: ignored.signal,
    requestDecision: () => new Promise(() => {}),
  });
  ignored.abort();
  code(await pending, "cancelled");
});

test("stale remember, replace and revoke approvals conflict when their row changed and keep the newer trust", async (t) => {
  const f = await fixture(t);
  const fingerprint = () => value(f.policy.list())[0]!.fingerprint;
  const remember = f.held(replacement);
  value(await f.verify());
  remember.answer("remember");
  code(await remember.result, "conflict");
  assert.equal(fingerprint(), valueIdentity(key).fingerprint);
  // Changed prompt A→B pending while another session replaces A→C: the stale Replace must not overwrite C.
  const toB = f.held(replacement),
    toC = f.held(third);
  toC.answer("replace");
  assert.equal(value(await toC.result).decision, "replace");
  toB.answer("replace");
  code(await toB.result, "conflict");
  assert.equal(fingerprint(), valueIdentity(third).fingerprint);
  // A match only records lastVerifiedAt, so a pending replacement of that same key stays valid.
  const toKey = f.held(key);
  value(await f.verify("reject", third));
  toKey.answer("replace");
  assert.equal(value(await toKey.result).decision, "replace");
  // A revoke preview survives matches and unrelated saves, but not a key change.
  let row = value(f.policy.list())[0]!;
  const survives = value(f.policy.prepareRevoke("owner", row.id, row.revision));
  value(await f.verify("reject", key));
  f.unrelatedSave();
  value(f.policy.revoke("owner", survives.token));
  assert.deepEqual(value(f.policy.list()), []);
  value(await f.verify("remember", key));
  row = value(f.policy.list())[0]!;
  const stale = value(f.policy.prepareRevoke("owner", row.id, row.revision));
  value(await f.verify("replace", replacement));
  code(f.policy.revoke("owner", stale.token), "conflict");
  assert.equal(fingerprint(), valueIdentity(replacement).fingerprint);
  // Replace racing a revoke: trust stays revoked.
  const changing = f.held(key);
  row = value(f.policy.list())[0]!;
  value(
    f.policy.revoke(
      "owner",
      value(f.policy.prepareRevoke("owner", row.id, row.revision)).token,
    ),
  );
  changing.answer("replace");
  code(await changing.result, "conflict");
  assert.deepEqual(value(f.policy.list()), []);
});

test("lock and owner revocation while a host-trust prompt is pending write no trust and start no authentication", async (t) => {
  const config: ResolvedHostConfig = {
    hostRef: { id: "host-1", revision: 1, label: "lab", groupId: null },
    address: "example.com",
    environment: null,
    port: { value: 22, source: { kind: "default" } },
    auth: {
      selection: "identity",
      source: { kind: "default" },
      key: null,
      identity: null,
    },
    ancestry: [],
    catalogRevision: 1,
  };
  const until = async (check: () => boolean) => {
    for (let index = 0; index < 200 && !check(); index++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.ok(check());
  };
  for (const end of ["lock", "owner"] as const) {
    const f = await fixture(t);
    const results: KnownHostResult<unknown>[] = [];
    let authStarts = 0;
    const registry = new SessionRegistry({
      resolve: () => ({ ok: true, value: config }),
      transient: new TransientSecrets(),
      adapter: {
        start(context) {
          if (!context.verifyingHost()) return;
          void f.policy
            .verify({
              endpointHost: "example.com",
              endpointPort: 22,
              publicKey: key,
              signal: context.signal,
              requestDecision: async (challenge) => {
                const answer = await context.requestPrompt({
                  kind: "host-trust",
                  status: "unknown",
                  endpointHost: challenge.endpointHost,
                  endpointPort: challenge.endpointPort,
                  algorithm: challenge.algorithm,
                  fingerprint: challenge.fingerprint,
                });
                return answer.kind === "host-trust" ? answer.decision : "reject";
              },
            })
            .then((result) => {
              results.push(result);
              if (result.ok && context.authenticating()) authStarts += 1;
            });
        },
      },
    });
    t.after(() => registry.dispose());
    assert.ok(registry.connect("owner", "host-1").ok);
    await until(() => !!registry.snapshot("owner")[0]?.prompt);
    if (end === "lock") await registry.lock();
    else await registry.closeOwner("owner");
    await until(() => results.length === 1);
    code(results[0]!, "cancelled");
    assert.equal(authStarts, 0);
    assert.deepEqual(value(f.policy.list()), []);
    assert.equal(registry.snapshot("owner")[0]?.prompt, undefined);
  }
});

test("revocation plans bind owner/revision, expire, are one-use and bounded; revoke changes next verification to unknown", async (t) => {
  const f = await fixture(t);
  value(await f.verify());
  const row = value(f.policy.list())[0]!;
  const plan = value(f.policy.prepareRevoke("owner", row.id, row.revision));
  code(f.policy.revoke("other-owner", plan.token), "invalid-request");
  value(f.policy.revoke("owner", plan.token));
  code(f.policy.revoke("owner", plan.token), "invalid-request");
  assert.equal(value(await f.verify("accept-once")).decision, "accept-once");
  value(await f.verify());
  const current = value(f.policy.list())[0]!;
  const expired = value(
    f.policy.prepareRevoke("owner", current.id, current.revision),
  );
  f.time("2026-10-15T10:01:00.001Z");
  code(f.policy.revoke("owner", expired.token), "conflict");
  const revokedOwner = value(
    f.policy.prepareRevoke("owner", current.id, current.revision),
  );
  f.policy.revokeOwner("owner");
  code(f.policy.revoke("owner", revokedOwner.token), "invalid-request");
  for (let index = 0; index < 64; index++)
    value(f.policy.prepareRevoke("owner", current.id, current.revision));
  code(
    f.policy.prepareRevoke("owner", current.id, current.revision),
    "invalid-request",
  );
  f.policy.dispose();
  code(f.policy.list(), "cancelled");
});

test("known-host transactions reject inconsistent identities, unknown fields, endpoint edits and stale rows atomically", async (t) => {
  const f = await fixture(t);
  value(await f.verify());
  const snapshot = value(f.repository.snapshot()),
    row = snapshot.knownHosts[0]!;
  for (const change of [
    {
      type: "accept-known-host",
      id: randomUUID(),
      data: {
        endpointHost: "other.example",
        endpointPort: 22,
        ...valueIdentity(key),
        fingerprint: "SHA256:bad",
        acceptedAt: row.firstAcceptedAt,
      },
    },
    {
      type: "replace-known-host",
      id: row.id,
      expectedRevision: 1,
      data: {
        ...valueIdentity(replacement),
        endpointHost: "other.example",
        acceptedAt: row.firstAcceptedAt,
      },
    },
    {
      type: "verify-known-host",
      id: row.id,
      expectedRevision: 2,
      verifiedAt: row.lastVerifiedAt,
    },
  ]) {
    assert.equal(
      f.repository.commit({
        expectedCatalogRevision: snapshot.catalogRevision,
        changes: [change as never],
      }).ok,
      false,
    );
    assert.deepEqual(value(f.repository.snapshot()), snapshot);
  }
});

test("corrupt persisted algorithm/key/fingerprint fails read-only preflight and preserves original bytes", async (t) => {
  for (const [field, changed] of [
    ["algorithm", "ssh-dss"],
    ["publicKey", valueIdentity(replacement).publicKey],
    ["fingerprint", `SHA256:${"A".repeat(43)}`],
  ]) {
    const f = await fixture(t);
    value(await f.verify());
    f.repository.close();
    const writer = new DatabaseSync(f.path);
    writer.prepare(`UPDATE known_host SET ${field}=?`).run(changed!);
    writer.close();
    const before = readFileSync(f.path);
    code(await openMetadata({ path: f.path }), "corrupt");
    assert.deepEqual(readFileSync(f.path), before);
  }
});

test("storage failures and cancellation never authorize new trust; a failed match record still trusts; reentrant revocation applies next", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const policy = new KnownHostPolicy({
    repository: f.repository,
    now: () => {
      controller.abort();
      return new Date();
    },
  });
  code(
    await policy.verify({
      endpointHost: "example.com",
      endpointPort: 22,
      publicKey: key,
      signal: controller.signal,
      requestDecision: async () => "remember",
    }),
    "cancelled",
  );
  assert.deepEqual(value(f.policy.list()), []);
  const faulty: MetadataRepository = {
    ...f.repository,
    snapshot: () => f.repository.snapshot(),
    commit: () => ({
      ok: false,
      error: { code: "io", message: "fixture-sensitive" },
    }),
    close() {},
    backup: async () => {
      throw Error("fixture-sensitive");
    },
  };
  const failed = new KnownHostPolicy({ repository: faulty });
  code(
    await failed.verify({
      endpointHost: "example.com",
      endpointPort: 22,
      publicKey: key,
      signal: new AbortController().signal,
      requestDecision: async () => "remember",
    }),
    "storage",
  );
  let unsubscribe = () => {};
  unsubscribe = f.policy.subscribe(() => {
    unsubscribe();
    const row = value(f.policy.list())[0]!;
    const plan = value(f.policy.prepareRevoke("owner", row.id, row.revision));
    value(f.policy.revoke("owner", plan.token));
  });
  // The decision committed first; the revoke governs the next verification.
  assert.equal(value(await f.verify()).decision, "remember");
  assert.deepEqual(value(f.policy.list()), []);
  code(await f.verify("reject"), "untrusted");
  value(await f.verify());
  const recorded = value(f.policy.list())[0]!.lastVerifiedAt;
  assert.equal(
    value(
      await failed.verify({
        endpointHost: "example.com",
        endpointPort: 22,
        publicKey: key,
        signal: new AbortController().signal,
        requestDecision: async () => assert.fail("matching key prompted"),
      }),
    ).decision,
    "known",
  );
  assert.equal(value(f.policy.list())[0]!.lastVerifiedAt, recorded);
});
