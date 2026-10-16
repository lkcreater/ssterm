import type { SecretItem, SecretProvider } from "@ssterm/domain";
import { createSshConnection, preparePrivateKey, type SshCredential, type PrivateKeyResult } from "@ssterm/adapters/ssh";
import type { KnownHostPolicy } from "./known-hosts.ts";
import type { SessionAdapter, SessionContext, SessionErrorCode, PromptFieldId } from "./sessions.ts";

/** Main-only composition. Resolved metadata is captured by the registry; bytes are fetched only after host trust. */
export function createSavedHostSshAdapter(options: {
  provider: SecretProvider;
  policy: KnownHostPolicy;
}): SessionAdapter {
  return {
    start(context) {
      const { config, signal } = context;
      if (signal.aborted) return;
      const identity = config.auth.identity;
      if (!identity || config.auth.selection !== "identity") {
        context.failed("credentials-required");
        return;
      }
      const connection = createSshConnection({
        host: config.address,
        port: config.port.value,
        username: identity.username,
        signal,
        async verifyHost(publicKey, initial) {
          if (signal.aborted || (initial && !context.verifyingHost())) return false;
          const result = await options.policy.verify({
            endpointHost: config.address,
            endpointPort: config.port.value,
            publicKey,
            signal,
            async requestDecision(challenge) {
              // Rekeys use shared policy but cannot open a prompt outside VerifyingHost.
              if (!initial || signal.aborted) return "reject";
              const { kind: _kind, ...fields } = challenge;
              const answer = await context.requestPrompt(challenge.kind === "changed" ? {
                kind: "host-trust", status: "changed", ...fields,
                previousAlgorithm: challenge.previousAlgorithm,
                previousFingerprint: challenge.previousFingerprint,
              } : { kind: "host-trust", status: "unknown", ...fields });
              return answer.kind === "host-trust" ? answer.decision : "reject";
            },
          });
          if (signal.aborted) return false;
          if (!result.ok) {
            context.failed(result.error.code === "changed" ? "host-key-changed" : "host-key-untrusted");
            return false;
          }
          return !initial || context.authenticating();
        },
        authenticate: () => loadCredential(context, options.provider),
        ready: (channel) => context.ready(channel),
        failed: (code) => context.failed(code),
        ended: () => context.ended(),
      });
      if (context.own(connection) && !signal.aborted) connection.start();
    },
  };
}

async function loadCredential(context: SessionContext, provider: SecretProvider): Promise<SshCredential | undefined> {
  const { signal, config } = context;
  const identity = config.auth.identity!;
  const buffers = new Set<Buffer>();
  const purge = () => { for (const buffer of buffers) buffer.fill(0); buffers.clear(); };
  // Wipe acquired bytes immediately on abort, including while another provider
  // read or a credential prompt remains unresolved.
  signal.addEventListener("abort", purge, { once: true });
  const fail = (code: SessionErrorCode) => { if (!signal.aborted) context.failed(code); };
  const read = async (item: SecretItem, allowMissing = false): Promise<Buffer | undefined> => {
    if (signal.aborted) return;
    try {
      const result = await provider.read(item);
      if (result.status !== "present") {
        if (!(allowMissing && result.status === "missing"))
          fail(result.status === "missing" ? "credentials-required" : "credentials-unavailable");
        return;
      }
      try {
        if (signal.aborted) return;
        if (result.value.length > (item.kind === "private-key" ? 65_536 : 16_384)) {
          fail(item.kind === "private-key" ? "invalid-private-key" : "credentials-unavailable");
          return;
        }
        const value = Buffer.from(result.value);
        buffers.add(value);
        return value;
      } finally { result.value.fill(0); }
    } catch { fail("credentials-unavailable"); return; }
  };
  const promptValue = async (purpose: "password" | "passphrase", attempt: 1 | 2 | 3): Promise<Buffer | undefined> => {
    const answer = await context.requestPrompt({ kind: "credentials", purpose, attempt, fields: [{ id: purpose, echo: false }] });
    if (signal.aborted || answer.kind !== "credentials") return;
    return answer.use((values) => {
      const value = values[purpose];
      if (!value) return;
      const copy = Buffer.from(value);
      buffers.add(copy);
      return copy;
    });
  };
  try {
    if (identity.method === "keyboard-interactive") {
      let rounds = 0;
      return {
        type: "keyboard-interactive", dispose() {},
        async respond(fields, finish) {
          if (signal.aborted) return;
          if (!fields.length) { finish([]); return; }
          if (++rounds > 3 || fields.length > 8 || fields.some((field) => typeof field.echo !== "boolean")) {
            fail("resource-limit"); return;
          }
          try {
            const ids = fields.map((_, index) => `response-${index + 1}` as PromptFieldId);
            const answer = await context.requestPrompt({
              kind: "credentials", purpose: "keyboard-interactive", attempt: rounds as 1 | 2 | 3,
              fields: fields.map((field, index) => ({ id: ids[index]!, echo: field.echo })),
            });
            if (signal.aborted || answer.kind !== "credentials") return;
            answer.use((values) => {
              if (!signal.aborted) finish(ids.map((id) => values[id]!));
            });
          } catch { if (!signal.aborted) fail("prompt-cancelled"); }
        },
      };
    }
    if (identity.method === "password") {
      const saved = identity.passwordRef
        ? await read({ vaultId: identity.vaultId, kind: "password", ref: identity.passwordRef }, true)
        : undefined;
      if (signal.aborted) return;
      const password = saved ?? await promptValue("password", 1);
      if (!password || signal.aborted) return;
      // The transport owns this copy until authentication completes or disposal.
      const owned = Buffer.from(password);
      return { type: "password", password: owned, dispose() { owned.fill(0); } };
    }
    const metadata = config.auth.key;
    if (!metadata) { fail("credentials-required"); return; }
    const privateKey = await read({ vaultId: metadata.vaultId, kind: "private-key", ref: metadata.privateKeyRef });
    if (!privateKey || signal.aborted) return;
    // Probe with the mature parser before any passphrase prompt: malformed and
    // unsupported plaintext formats must fail rather than ask for unrelated input.
    let parsed: PrivateKeyResult = preparePrivateKey(privateKey);
    if (!parsed.ok && parsed.code === "credentials-required") {
      const saved = metadata.passphraseRef
        ? await read({ vaultId: metadata.vaultId, kind: "passphrase", ref: metadata.passphraseRef }, true)
        : undefined;
      if (signal.aborted) return;
      if (saved) {
        parsed = preparePrivateKey(privateKey, saved);
        saved.fill(0); buffers.delete(saved);
      }
      for (let attempt = 1; !parsed.ok && attempt <= 3; attempt++) {
        const phrase = await promptValue("passphrase", attempt as 1 | 2 | 3);
        if (!phrase || signal.aborted) return;
        parsed = preparePrivateKey(privateKey, phrase);
        phrase.fill(0); buffers.delete(phrase);
      }
    }
    if (!parsed.ok) { fail(parsed.code === "credentials-required" ? "invalid-private-key" : parsed.code); return; }
    const key = parsed.key;
    if (key.identity.algorithm !== metadata.algorithm || key.identity.publicKey !== metadata.publicKey || key.identity.fingerprint !== metadata.fingerprint) {
      key.dispose(); fail("key-mismatch"); return;
    }
    if (signal.aborted) { key.dispose(); return; }
    return { type: "publickey", key, dispose() { key.dispose(); } };
  } catch { if (!signal.aborted) fail("prompt-cancelled"); return; }
  finally { signal.removeEventListener("abort", purge); purge(); }
}
