# ADR 0006 — Independent sync cryptography and key lifecycle

**2026-10-20 · SST-036/T043 · protocol decision; internal review and conformance evidence recorded in the delivery record.**

## Context

The authorized SST-035/037 scope is an independent, opt-in, end-to-end encrypted sync system with a Node/SQLite self-hosted server, followed by teams. Current snippets and recordings use the main-only Node/OpenSSL AES-256-GCM adapter and a local Keychain content key ([ADR 0003](0003-secret-storage-and-content-protection.md)). Local app lock is an access gate, not an encryption account ([ADR 0004](0004-local-app-lock.md)). Neither current format provides device enrollment, portable recovery or revocation.

This ticket specifies and tests the construction before that integration. It does not enable sync, contact a server, add IPC/UI, migrate schema 4, or change existing encrypted bytes. Termius publications and observations are evidence of product capabilities, not verification of this independent construction.

## Decision

Adopt the exact v1 formats and lifecycle in [the protocol specification](../sync-crypto.md). Reuse Node/OpenSSL rather than add a cryptographic provider:

| Purpose | Construction |
|---|---|
| Immutable operation encryption | AES-256-GCM, 96-bit nonce, 128-bit tag; separate HKDF-SHA256-derived key per operation |
| Device epoch-key delivery | RSAES-OAEP, 3072-bit modulus, exponent 65537, SHA-256 and MGF1-SHA256; explicit context label |
| Device/control provenance | Separate Ed25519 signing keys; domain-separated canonical transcripts |
| Recovery | Independent random 256-bit secret; HKDF-SHA256 and AES-256-GCM over an explicit recovery bundle |
| Commitments/fingerprints | SHA-256; public-key fingerprints over SPKI DER |

RSA wraps only a 32-byte epoch key. It never directly encrypts a record or recovery bundle. SHA-1 defaults, RSA PKCS#1 v1.5 encryption, cross-purpose key reuse and handwritten asymmetric encryption are excluded. OAEP and GCM authentication errors have one sanitized failure outcome; successful decryption does not authorize a signer.

The RSA/Ed25519 choices provide approximately 128-bit classical asymmetric security; the AES key length is not an end-to-end 256-bit security claim. The protocol has no post-quantum or forward-secrecy claim.

## Boundaries and compatibility

Future `SyncCryptoProvider`, `SyncKeyStore`, `SyncKeyLifecycle`, `SyncRepository` and `SyncTransport` are main-only boundaries described in the specification. The server receives ciphertext, public authorization/control information and opaque routing identifiers. Renderer and transport cannot access private keys. A shared epoch key alone cannot establish authorship: operations also require an authorized device signature.

Current `SecretKind` and journal owner enums cannot represent these new keys without changes. SST-035 must introduce versioned sync Keychain accounts and a dedicated publication journal, patterned after `SecretService`; it must not disguise them as the existing local content key. Existing local encryption, app-lock password/Google/recovery and local `vaultId` semantics remain independent.

This ticket adds no dependency or database migration. A future migration requires the existing verified backup, transaction and unknown-version refusal contracts. Local plaintext credentials remain excluded from sync by default; any future secret sharing needs explicit separate policy and consent. Server deployment, accounts and network endpoints are not established by this ADR.

## Alternatives

- **HPKE (RFC 9180):** a suitable established future construction, but Node has no existing HPKE adapter in this repository. A new implementation requires a separate provider/dependency review, exact pins and runtime/packaged checks. The candidate hpke-js explicitly reports no formal audit and previously fixed concurrent-context nonce reuse. No manual X25519/HKDF/AEAD substitute is introduced.
- **Password-derived account keys:** unnecessary for an independent random recovery secret, and would couple online authentication to offline cryptographic guessing. Existing app-lock verifiers cannot derive the original password or recover sync material.
- **Reuse the local content key:** would couple local recovery and sync revocation, expose recordings/snippets outside their current boundary and require an unrequested format migration.
- **AEAD without device signatures:** any reader holding a shared key could impersonate another author; incompatible with later server/client write permissions.

## Review, adoption and rollback

Standards known-answer tests and a bounded reference harness verify primitives and selected protocol rejection behavior. They are not an audit, a proof of composition, a production E2EE implementation or evidence of deployed multi-device/team behavior. The delivery record must identify the exact tests run and unresolved findings.

SST-035 adoption requires real Keychain/publication-journal failure tests, enrollment and recovery drills, signed control/rollback handling, transport authorization, two-device offline conflict/tombstone reconciliation, explicit network-policy changes and development/packaged checks. SST-037 separately gates team tenant boundaries, roles, rekey and cached-access limits. No unresolved high/critical review finding may be carried into adoption.

Rollback of SST-036 removes documents and reference tests only. Later rollback must preserve unknown envelopes/key refs and disable sync writes; it must never downgrade ciphertext silently, erase an enrollment, restore an old provider journal automatically or substitute empty data.

## Primary references

- [RFC 8017, RSAES-OAEP](https://www.rfc-editor.org/rfc/rfc8017.html), [Node crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
- [RFC 5869, HKDF and test vectors](https://www.rfc-editor.org/rfc/rfc5869.html), [RFC 8032, Ed25519 and test vectors](https://www.rfc-editor.org/rfc/rfc8032.html).
- [NIST SP 800-38D, GCM](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf), [NIST SP 800-57 Part 1 Rev. 5, security strengths/key management](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-57pt1r5.pdf).
- [C2SP Wycheproof](https://github.com/C2SP/wycheproof), [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html), [hpke-js provider limitations](https://github.com/dajiaji/hpke-js), [upstream nonce-reuse advisory](https://github.com/dajiaji/hpke-js/security/advisories/GHSA-73g8-5h73-26h4).
