import type { SecretItem, SecretProvider } from "@ssterm/domain";
import { createSshConnection, preparePrivateKey, type SshCredential } from "@ssterm/adapters/ssh";
import type { KnownHostPolicy } from "./known-hosts.ts";
import type { SessionAdapter, SessionContext, SessionErrorCode } from "./sessions.ts";

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
      if (!identity || config.auth.selection !== "identity" || identity.method === "keyboard-interactive") {
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
  const buffers: Buffer[] = [];
  const fail = (code: SessionErrorCode) => { if (!signal.aborted) context.failed(code); };
  const read = async (item: SecretItem): Promise<Buffer | undefined> => {
    if (signal.aborted) return;
    try {
      const result = await provider.read(item);
      if (result.status !== "present") {
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
        buffers.push(value);
        return value;
      } finally { result.value.fill(0); }
    } catch { fail("credentials-unavailable"); return; }
  };
  try {
    if (identity.method === "password") {
      if (!identity.passwordRef) { fail("credentials-required"); return; }
      const password = await read({ vaultId: identity.vaultId, kind: "password", ref: identity.passwordRef });
      if (!password || signal.aborted) return;
      // The transport owns this copy until authentication completes or it is disposed.
      const owned = Buffer.from(password);
      return { type: "password", password: owned, dispose() { owned.fill(0); } };
    }
    const metadata = config.auth.key;
    if (!metadata) { fail("credentials-required"); return; }
    const privateKey = await read({ vaultId: metadata.vaultId, kind: "private-key", ref: metadata.privateKeyRef });
    if (!privateKey || signal.aborted) return;
    const phrase = metadata.passphraseRef ? await read({ vaultId: metadata.vaultId, kind: "passphrase", ref: metadata.passphraseRef }) : undefined;
    if (signal.aborted || (metadata.passphraseRef && !phrase)) return;
    const parsed = preparePrivateKey(privateKey, phrase);
    if (!parsed.ok) { fail(parsed.code); return; }
    const key = parsed.key;
    if (key.identity.algorithm !== metadata.algorithm || key.identity.publicKey !== metadata.publicKey || key.identity.fingerprint !== metadata.fingerprint) {
      key.dispose();
      fail("key-mismatch");
      return;
    }
    if (signal.aborted) { key.dispose(); return; }
    return { type: "publickey", key, dispose() { key.dispose(); } };
  } finally { for (const buffer of buffers) buffer.fill(0); }
}
