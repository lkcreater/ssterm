# ADR 0003 — OS secret storage and snippet content protection

**2026-10-15 · SST-006/T009–T010 · implemented; awaiting independent TEST/REVIEW/DELIVERY**

## Decision

1. **Credential store:** [`@napi-rs/keyring` 2.1.1](https://github.com/Brooooooklyn/keyring-node) (MIT, exact pin, prebuilt `@napi-rs/keyring-darwin-arm64`) behind the main-only `SecretProvider` seam in `packages/domain`, implemented as `KeychainSecretProvider` in `packages/adapters/src/keychain.ts`. Items are macOS generic passwords: service = namespace, account = `<vaultId>/<kind>/<ref>`. Production namespace `dev.ssterm.desktop.secrets`; tests use only `dev.ssterm.test.<uuid>`. The constructor rejects any other namespace.
2. **Content protection:** Node/OpenSSL `crypto` **AES-256-GCM**, format `aes-256-gcm-v1`, envelope version 1 = version byte ‖ 12-byte random nonce ‖ ciphertext ‖ 16-byte tag. AAD = length-prefixed (u32 BE) UTF-8 encoding of format, envelope version, vaultId, snippetId and field `body`. The random 32-byte vault content key lives in the Keychain (kind `content-key`); SQLite stores only its opaque ref and the envelope. Decryption pins `authTagLength: 16`.
3. **Journal:** the metadata repository carries finite secret-operation changes inside its existing single-transaction commit; `SecretService` in the new `packages/services` orders SQL and OS steps per [domain/storage spec](../termius/domain-storage-spec.md#cross-store-journal-ordered-never-atomic).

## Evidence

| Check | Result |
|---|---|
| Root probe, host Node 24.11.1, throwaway `dev.ssterm.test.probe-*` | missing `getSecret` → `null`; missing delete → `false`; binary `setSecret`/`getSecret` round-trip; `findCredentialsAsync`; 300 KB secret; 0 items left |
| Coder probe (same host) | binary secret survives `findCredentialsAsync`; `setSecret` on an existing account updates in place (hence never write to a published ref); empty account rejects `Value of 'user' is invalid: cannot be empty`; 0 items left |
| Shipped binary strings | crates `keyring-core-1.0.0`, `apple-native-keyring-store-1.0.2`, `security-framework-3.7.0` |
| Crate source (crates.io downloads) | `keyring-core` Display prefixes: `Platform failure: `, `Couldn't access platform storage: `, `No matching credential found`, `Entry is matched by N credentials`, `Value of '…' is invalid/longer…`, `… data is malformed`. `apple-native-keyring-store::decode_error` maps only −61/−25244/−25291/−25292/−25294/−25295 to NoStorageAccess and −25300 to NoEntry; everything else (including errSecInteractionNotAllowed, errSecAuthFailed, user cancel) is PlatformFailure. `security-framework` Display prints only the localized `SecCopyErrorMessageString` text, no status code |
| Unit/Electron/packaged runs | see [secret storage](../secret-storage.md#verification-record) |

## Outcome mapping

The JavaScript error is `Error{code:'GenericFailure', message}`; the OS status code is not exposed and the message tail is localized OS text. Therefore:

- `locked` and `denied` are **never** produced by the Keychain Adapter: no stable evidence distinguishes them. Reads/lookups map NoStorageAccess, PlatformFailure and unrecognized errors to `unavailable`; ambiguous/invalid/malformed to `error`; `null` to `missing`.
- Rejected `setSecret`/`deleteCredential` map to `unknown` (the call may have reached the store), except keyring-core attribute validation (`Value of '…'`), which fails before any platform call → `error`. Delete `false` is documented definite absence → `missing`.
- Lookup reads the exact account and discards the value; it returns presence only. Raw messages never cross the seam, and binding construction errors are caught as well. Storage-access, platform and unrecognized failures share one internal class because they map to identical outcomes.
- The fixture provider can inject every outcome so `SecretService` behavior for `locked`/`denied` is still tested.

## Rejected options

- **Electron `safeStorage`:** an encryption facility keyed to the app's Keychain entry, not a credential-store API; no per-item lookup by stable ref for journal reconciliation ([Electron docs](https://www.electronjs.org/docs/latest/api/safe-storage)).
- **Custom or password-derived constructions, ChaCha20 libraries, whole-database encryption:** no added need over OpenSSL AES-GCM, more dependencies or untested native code; SQLite is not claimed to be encrypted.
- **keytar:** archived upstream; napi-rs keyring is the maintained ADR 0001 candidate and passed the capability gate.
- **Mapping localized OS text to `locked`/`denied`:** locale dependent and unverifiable; would fabricate outcomes.

## Limitations

- Unsigned builds: the Keychain ACL identifies the creating binary. Items created by one unsigned binary (Node, development Electron, packaged app) may prompt when read by another. Tests create and delete their items in the same binary and namespace. Signed release identity and ACL migration remain SST-028.
- Lock events: main purges transient secrets on `powerMonitor` `lock-screen`/`suspend` and on quit; app lock, generation invalidation and resource closure are SST-008/015. Startup reconciliation runs on open; an explicit "after unlock" gate arrives with app lock.
- Zeroization is best effort: buffers are overwritten, but JavaScript/V8 and the native binding (`getSecret` returns `number[]`) may retain copies.
- `NAPI_RS_NATIVE_LIBRARY_PATH` lets the environment choose the native library at load time; whoever controls the process environment already controls the app.
- No key rotation, export, recovery code or cross-device portability; a lost content key makes snippet bodies unrecoverable. KeyMetadata public fields are not yet validated against an imported key (SST-017 import flow).
- macOS arm64 only; other platforms' bindings are not shipped.
- Existing-owner credential replacement is a plain ref swap; changing a key's public fields together with its private key requires a new KeyMetadata record (reconciliation cannot reconstruct an extra payload).
- Migration still refuses protected vaults; the repository checks envelope structure only, so future IPC must never forward raw snippet/secret changes; startup reconciliation has no verified-restore fence; `powerMonitor` purge wiring is untested. Details: [secret storage](../secret-storage.md#known-limitations).
