import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CatalogAuth, CatalogEffective } from "../../packages/contracts/src/index.ts";
import {
  algorithmLabel,
  credentialStatus,
  identityDraft,
  identityErrors,
  identityIntent,
  identityUsages,
  importProblemText,
  keyInUseReason,
  keyUsers,
  usageOf,
  usageText,
} from "../../apps/desktop/src/renderer/src/lib/identity-usage.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const value = (identityId: string): CatalogAuth => ({ mode: "value", identityId });
const inherit: CatalogAuth = { mode: "inherit" };
const effective = (identityId: string | null): Pick<CatalogEffective, "authSelection" | "identityId"> =>
  identityId ? { authSelection: "identity", identityId } : { authSelection: "none", identityId: null };
const host = (id: string, auth: CatalogAuth, resolved: string | null) => ({ id, auth, effective: effective(resolved) });

test("identity usage separates direct servers from servers inheriting through groups", () => {
  const usages = identityUsages(
    [
      host("h1", value(A), A),
      host("h2", inherit, A), // via group g1
      host("h3", inherit, A), // via nested group
      host("h4", value(B), B), // overrides g1's A
      host("h5", { mode: "clear" }, null),
    ],
    [{ id: "g1", auth: value(A) }, { id: "g2", auth: inherit }, { id: "g3", auth: value(B) }],
  );
  assert.deepEqual(usageOf(usages, A), { servers: 3, direct: 1, groups: 1 });
  assert.deepEqual(usageOf(usages, B), { servers: 1, direct: 1, groups: 1 });
  assert.deepEqual(usageOf(usages, "missing"), { servers: 0, direct: 0, groups: 0 });
  assert.equal(usageText(usageOf(usages, A)), "Used by 3 servers (1 direct, 2 via groups)");
  assert.equal(usageText({ servers: 1, direct: 0, groups: 1 }), "Used by 1 server (0 direct, 1 via groups)");
  assert.equal(usageText({ servers: 0, direct: 0, groups: 0 }), "Not used by any servers");
  assert.equal(usageText({ servers: 0, direct: 0, groups: 2 }), "Not used by any servers (set on 2 groups)");
});

test("credential status never depends on secret values and flags unresolved Keychain work first", () => {
  const keys = new Map([["k1", { id: "k1", label: "Deploy key" }]]);
  const base = { method: "password" as const, passwordSaved: false, keyId: null, pending: false };
  assert.deepEqual(credentialStatus({ ...base, passwordSaved: true }, keys), { tone: "saved", text: "Saved in Keychain" });
  assert.deepEqual(credentialStatus(base, keys), { tone: "asks", text: "Asks when connecting" });
  assert.deepEqual(credentialStatus({ ...base, method: "keyboard-interactive" }, keys), { tone: "asks", text: "Asks when connecting" });
  assert.deepEqual(credentialStatus({ ...base, method: "key", keyId: "k1" }, keys), { tone: "key", text: "Deploy key" });
  assert.deepEqual(credentialStatus({ ...base, method: "key", keyId: "gone" }, keys), { tone: "missing", text: "Key unavailable" });
  assert.deepEqual(credentialStatus({ ...base, passwordSaved: true, pending: true }, keys), {
    tone: "unresolved",
    text: "Keychain change unresolved",
  });
});

test("key usage names the blocking identities count and copy stays fixed", () => {
  const identities = [{ keyId: "k1" }, { keyId: null }, { keyId: "k1" }];
  assert.equal(keyUsers(identities, "k1").length, 2);
  assert.equal(keyInUseReason([]), undefined);
  assert.equal(keyInUseReason(["Lab"]), "Can't delete: used by Lab. Choose another key for it first.");
  assert.equal(
    keyInUseReason(["a", "b", "c", "d", "e"]),
    "Can't delete: used by a, b, c and 2 more. Choose another key for them first.",
  );
  assert.equal(algorithmLabel("ssh-ed25519"), "Ed25519");
  assert.equal(algorithmLabel("ssh-rsa"), "RSA");
  assert.match(importProblemText.unsupported, /ssh-keygen -p -m PEM/);
});

test("identity drafts validate locally and send only changed fields", () => {
  assert.deepEqual(identityErrors({ label: " ", username: "", method: "key", keyId: null }), {
    label: "Enter a name.",
    username: "Enter a user name.",
    keyId: "Choose a key, or import one.",
  });
  assert.deepEqual(identityErrors({ label: "ทีม", username: "deploy", method: "password", keyId: null }), {});
  assert.equal(identityErrors({ label: "x", username: "a".repeat(257), method: "password", keyId: null }).username, "Use 256 characters or fewer.");

  const draft = { label: " Lab ", username: " root ", method: "password" as const, keyId: null };
  assert.deepEqual(identityIntent(draft, undefined, false), {
    type: "create-identity",
    data: { label: "Lab", username: "root", method: "password" },
  });
  const base = { id: A, revision: 4, label: "Lab", username: "root", method: "password" as const, keyId: null };
  assert.equal(identityIntent(identityDraft(base), base, false), undefined);
  assert.deepEqual(identityIntent(identityDraft(base), base, true), {
    type: "update-identity", id: A, expectedRevision: 4, data: {}, forgetPassword: true,
  });
  // Switching to a key sends the key; main forgets the saved password itself.
  assert.deepEqual(identityIntent({ ...identityDraft(base), method: "key", keyId: "k1" }, base, true), {
    type: "update-identity", id: A, expectedRevision: 4, data: { method: "key", keyId: "k1" },
  });
  const keyed = { ...base, method: "key" as const, keyId: "k1" };
  assert.deepEqual(identityIntent({ ...identityDraft(keyed), keyId: "k2" }, keyed, false), {
    type: "update-identity", id: A, expectedRevision: 4, data: { keyId: "k2" },
  });
  assert.deepEqual(identityIntent({ ...identityDraft(keyed), method: "keyboard-interactive" }, keyed, false), {
    type: "update-identity", id: A, expectedRevision: 4, data: { method: "keyboard-interactive" },
  });
});
