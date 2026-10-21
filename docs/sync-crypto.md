# Independent sync cryptography — SST-036

**SST-036 protocol specification, adopted by opt-in personal sync in SST-035.** See [personal sync](sync.md) for the current implementation and limits. [ADR 0006](adr/0006-sync-cryptography-and-key-lifecycle.md) selects this independent construction. The application still uses catalog schema4 and existing local protection; SST-036 itself introduced no server, account, enrollment, export or external request. SST-035 adopts these bytes behind separate opt-in boundaries. The reference suite checks the selected primitives and bounded protocol behavior, not a deployed E2EE system or external cryptographic audit.

## Assumptions and threat model

**Assumptions:** a trusted macOS arm64 client, functioning OS CSPRNG/Keychain and Node/OpenSSL, an explicitly selected future self-hosted deployment, and an owner who can compare enrollment material over an authenticated independent channel. SST-035 implements personal sync; SST-037 adds distinct team authorization. The server's authentication service and TLS configuration remain future integration work.

Protect encrypted records from a server/database/backup reader without client keys; detect ciphertext/context tampering, unauthorized signers, cross-tenant substitution and rollback against an existing device's pinned control state. The server may replay, omit, reorder, fork or deny service. A valid signature proves possession of a signing key, not user intent, factual record content or remote SSH command success.

Excluded guarantees: a compromised client/OS, malicious authorized readers, access after plaintext export, screen/clipboard capture, traffic-analysis resistance, post-quantum security, forward secrecy, secure deletion of backups and remote erasure. A new/reset client lacks the old device's high-water marks; no transparency service or independent global freshness witness is specified. Server forks can remain undetected while devices are isolated. A malicious authorized reader can copy keys/plaintext outside the protocol.

## Existing behavior and component boundaries

`packages/adapters/src/protection.ts` owns local `aes-256-gcm-v1` and recording segment AEAD. `packages/services/src/secrets.ts` orders the metadata/provider journal and transient lifetimes. The local Keychain provider uses opaque refs; `SecretKind` currently permits only password/private-key/passphrase/content-key. App-lock password/recovery verifiers and Google identity are access gates. None is an account encryption key or sync recovery credential.

Future boundaries, with no application implementation in SST-036:

| Boundary | Responsibility and API contract |
|---|---|
| `SyncCryptoProvider` | Parse/canonicalize bounded headers, `sealOperation/openOperation`, `sign/verify`, `wrapEpoch/unwrapEpoch`, `sealRecovery/openRecovery`; no network, UI or database writes. Returns owned byte buffers or typed sanitized failures. |
| `SyncKeyStore` | Separate versioned Keychain identities, private-key/epoch-key access and publication presence lookup. No renderer values or transport access. Missing/unknown provider outcomes never create a replacement under an existing identity. |
| `SyncKeyLifecycle` | Owner approval, enrollment, control checkpoints, recovery/rotation and journal reconciliation. Serializes control mutations and generation-fences asynchronous work against lock/logout. |
| `SyncRepository` | Immutable ciphertext outbox/inbox, control checkpoints/certificates/wraps, pinned authority and high-water commitments, pending provider/publication operations. Atomic local transactions; never claims atomicity with Keychain/server. |
| `SyncTransport` | Authenticated bounded exchange of ciphertext/public control material. No decryption, plaintext catalog access or OS secrets. |

The existing catalog/services materialize only authenticated, authorized, schema-validated plaintext through existing domain interfaces. Renderer commands capture targets, validate payload/ownership in main and never receive sync private keys. Expected outcomes include `unsupported`, `invalid`, `authentication-failed`, `untrusted-authority`, `stale-control`, `key-unavailable`, `fenced` and typed storage/transport failures. Raw OpenSSL errors, payloads and key material do not cross the seam.

## Keys and exact algorithms

Suite identifier, encoded literally throughout v1:

`rsa3072-oaep-sha256_ed25519_hkdf-sha256_aes256gcm`

| Material | Generation/use |
|---|---|
| Personal owner/control key | Separate Ed25519 key pair; owner private key exists on the owner device and in the explicitly created encrypted recovery bundle only. Authorizes personal membership/control. Ordinary reader/writer devices do not receive it. |
| Device signing key | Fresh separate Ed25519 key pair per enrollment. Signs operation and authorized wrap transcripts. |
| Device wrapping key | Fresh RSA key pair, modulus exactly 3072 bits, exponent 65537. OAEP SHA-256 and MGF1-SHA256; wraps exactly 32 bytes. |
| Vault epoch key | Independent CSPRNG 32 bytes for each vault epoch. Not a local content key; never derived from an app-lock method or user password. |
| Operation key | HKDF-SHA256 from epoch key, fresh 32-byte operation salt and exact header-bound info; 32-byte output. One immutable operation only. |
| Recovery secret | Independent CSPRNG 32 bytes, shown once as unpadded base64url (43 characters); not persisted in plaintext and not reused from app lock. |

Public-key fingerprint = lowercase hex SHA-256 of canonical SPKI DER. Validate algorithm, modulus/exponent and key encoding before fingerprinting/use; a fingerprint supplied by the server is not a trust decision. Ed25519 signatures are exactly 64 raw bytes. RSA ciphertext is exactly 384 bytes. Use Node's explicit OAEP padding/hash/label options; never its default hash or RSA PKCS#1 v1.5 encryption.

## Canonical encoding

Define `F(x1, …, xn)` as concatenation, for every field in order, of `u32be(byteLength(xi)) || xi`. Strings use UTF-8; embedded encoded headers, ciphertext and signatures are raw byte fields. There is no field count or terminator in `F`: each message type fixes its field count. Reject missing/extra/trailing fields, truncated prefixes, lengths exceeding the enclosing message and noncanonical text before cryptographic use. Check size limits before allocation.

All identifiers below are canonical lowercase UUID strings. Integers are ASCII decimal without sign, whitespace or leading zero except literal `0`. Epoch/control generation is 1…4294967295. SHA-256 digests/fingerprints are 64 lowercase hex characters; salt is 64 lowercase hex characters; nonce is 24 lowercase hex characters. No Unicode normalization, object-key ordering or `JSON.stringify` occurs in a cryptographic transcript. Reject unknown protocol versions/suites without fallback. Public enums/domain labels below are exact case-sensitive ASCII.

An outer implementation may carry base64url byte strings in JSON, but must decode strictly, reject duplicate/unknown fields, reconstruct the exact canonical bytes and enforce all limits; the JSON representation itself is never signed. No outer JSON parser is shipped by this ticket.

Hard byte/count ceilings apply before copying, cryptographic parsing or allocation:

| Object | Maximum |
|---|---|
| Data/wrap/recovery/control header | 1024 bytes |
| Certificate/enrollment body | 1536 bytes |
| Certificate/control/wrap wire | 2048 bytes |
| Enrollment proof wire | 4096 bytes |
| Roster | 256 certificates and 1 MiB encoded |
| Parent list | 64 hashes and 8192 encoded bytes |
| Data envelope | 1 MiB + 2048 bytes, excluding separately bounded parents |
| Recovery envelope/payload | Envelope 8 MiB + 2048 bytes; plaintext payload 8 MiB |
| Recovery epoch list | 1…4096 unique epochs, 512 KiB encoded |
| Recovery descriptor | 1024 bytes |

Canonical Ed25519 public SPKI is exactly 44 bytes and private PKCS8 exactly 48 bytes (the seed-only RFC 8410 encoding without optional attributes). Canonical RSA-3072/e65537 SPKI is exactly 422 bytes. Import then re-export and compare bytes; reject noncanonical or wrong-algorithm keys before use. Private RSA PKCS8 is locally generated/provider-held, bounded to 4096 bytes and never transported in these formats.

## Immutable data operation

Parents are 0…64 unique lowercase SHA-256 envelope commitments, sorted lexicographically. Compute:

`parentsDigest = hex(SHA256(F('ssterm-sync-parents-v1', countDecimal, …sortedParentHashHex)))`

Canonical header, exactly 14 fields:

```text
F('ssterm-sync-data-v1', '1', suite,
  deploymentId, accountId, vaultId, epochDecimal,
  operationId, authorDeviceId, controlHashHex, parentsDigestHex,
  saltHex, nonceHex, plaintextLengthDecimal)
```

Plaintext length is 0…1048576. The complete parent list accompanies the envelope and must reproduce the header commitment; parent semantics and conflict/tombstone reconciliation are SST-035 work.

Generate fresh operation ID, 32-byte salt and 12-byte nonce for each new encryption. Derive:

```text
operationKey = HKDF-SHA256(
  IKM = epochKey32,
  salt = hexDecode(saltHex),
  info = F('ssterm-sync-data-key-v1', headerBytes), L = 32)
ciphertext = AES-256-GCM(operationKey, hexDecode(nonceHex),
                         plaintext, AAD = headerBytes) || tag16
signature = Ed25519(deviceSigningPrivate,
                     F('ssterm-sync-data-sign-v1', headerBytes, ciphertext))
envelopeHash = hex(SHA256(F('ssterm-sync-data-commit-v1',
                           headerBytes, ciphertext, signature)))
```

Ciphertext length must equal header plaintext length + 16. Canonical envelope wire bytes are `F(headerBytes, ciphertext, signature)`; parents are a separately bounded canonical list checked against `parentsDigest`. The author key must be certified and permitted to write at the referenced control checkpoint. Verify signature/authorization before decrypting; never materialize authenticated but schema-invalid content. Do not release GCM plaintext until tag verification succeeds; wipe intermediate buffers on failure.

Fresh salts derive independent operation keys without distributed nonce counters. This does not excuse RNG failure or reusing an operation key for another encryption. Persist immutable bytes for retries, never call encrypt again under reused salt/header/nonce. Editing or rebasing creates new immutable operation bytes. Duplicate operation IDs with differing commitments are conflicts/tampering, never last-write-wins replacement.

Each operation key performs one GCM encryption of at most 1 MiB. A compliant vault admits at most 4294967295 unique operations per epoch, then rotates before further writes; the future server and client ledger enforce the ceiling, preserving excess offline work for explicit reconciliation. Reject a reused salt within one epoch unless it is an exact byte-identical retry of the same envelope. Nonces are independent per operation key. A malicious authorized writer can violate generation rules before submitting, so these limits are not a defense against that writer leaking plaintext or creating arbitrary private ciphertext.

Encrypted payloads contain record ID/type, host labels/endpoints/users, tags/groups, snippet bodies, deletion markers and domain revisions. Local OS secret refs are device-local and must not be uploaded. Credentials/private keys, recordings/history, local paths, app-lock records and recovery plaintext are excluded from ordinary sync; future selective secret sharing needs its own explicit policy and consent. The server can observe deployment/account/vault/device IDs, control/parent relationships, epoch, operation count/size/timing and public memberships/roles. Encryption does not conceal those boundaries.

## Epoch-key wrap

Canonical wrap header, exactly 12 fields:

```text
F('ssterm-sync-wrap-v1', '1', suite,
  deploymentId, accountId, vaultId, epochDecimal,
  recipientDeviceId, recipientRsaFingerprintHex,
  issuerDeviceId, issuerSigningFingerprintHex, controlHashHex)
```

RSA-OAEP uses the complete `headerBytes` as its label, the certified recipient RSA key and exactly the 32-byte epoch key as plaintext. A wrong context or recipient must fail. Sign `F('ssterm-sync-wrap-sign-v1', headerBytes, ciphertext384)` using the issuer device Ed25519 key. Wire = `F(headerBytes, ciphertext384, signature64)`.

An issuer-supplied fingerprint does not select an arbitrary verification key: look it up in the pinned signed control roster and require the approved owner/key-management capability. Recipient/device/epoch must match that checkpoint. OAEP is encryption, not sender authentication; all wraps require the signature and certificate checks.

## Authority, enrollment and control state

Personal v1 has one owner authority. Genesis pins deployment/account/vault and the owner's SPKI fingerprint locally before the first upload. Server login, email, TLS and Google identity do not authorize new encryption keys. A device records accepted generation plus commitment transactionally and refuses older or conflicting checkpoints. The following formats are fixed even though the production control transport/journal is not implemented in SST-036.

Certificate body:

```text
F('ssterm-sync-certificate-v1', '1', suite,
  deploymentId, accountId, vaultId, deviceId,
  deviceEd25519SpkiRaw44, deviceRsaSpkiRaw422, role,
  enrollmentHashHex, ownerFingerprintHex, firstGenerationDecimal)
```

Role is exactly `owner`, `writer` or `reader`. Owner signs `F('ssterm-sync-certificate-sign-v1', certificateBody)`. Certificate wire = `F(certificateBody, ownerSignature64)`; certificate commitment = SHA-256 of `F('ssterm-sync-certificate-commit-v1', certificateBody, ownerSignature64)`. Fingerprints are derived from the embedded canonical keys. `firstGenerationDecimal` and `enrollmentHashHex` identify the **original admission of that device ID and both device keys**, not the latest certificate signature or role change. They are immutable while device ID and both keys are unchanged. Re-signing under a new owner authority, including owner rollover, preserves both admission fields; an authorized role change also preserves them. The first generation must not exceed the containing checkpoint generation.

Genesis contains exactly one certificate: its original owner device, first generation 1 and all-zero enrollment hash. In later rosters only that same original genesis device with both original keys may retain this first-generation/all-zero pair, including after re-signing or role change. No newly added/replacement device or changed device key may claim genesis admission. Any new device or replacement of either key requires a fresh approved enrollment with a nonzero fingerprint and first generation equal to the new admission checkpoint generation. Validate retained admission against the accepted roster/control history; a signed certificate alone does not prove original genesis identity.

Roster wire = `F('ssterm-sync-roster-v1', countDecimal, …certificateWireBytes)` ordered by canonical device ID. It contains 1…256 entries, unique device IDs, unique signing-key fingerprints and unique RSA-key fingerprints, with exactly one `owner` certificate. Roster digest = lowercase hex SHA-256 of roster wire. Every certificate must match checkpoint deployment/account/vault and verify under the checkpoint's new owner SPKI/fingerprint. The one owner certificate's device ID must match checkpoint `ownerDeviceId`; only that device may sign v1 key wraps. Reader devices can decrypt if currently enrolled; owner/writer devices can submit data. No role is inferred from possessing an epoch key.

Control body:

```text
F('ssterm-sync-control-v1', '1', suite,
  deploymentId, accountId, vaultId, generationDecimal,
  previousControlHashHex, previousOwnerFingerprintHex,
  newOwnerEd25519SpkiRaw44, ownerDeviceId, activeEpochDecimal,
  rosterDigestHex, recoveryDescriptorDigestHex)
```

The pinned old owner signs `F('ssterm-sync-control-authorize-v1', controlBody)`; the new owner signs `F('ssterm-sync-control-possession-v1', controlBody)`. Both signatures are required even when the key is unchanged. Control wire = `F(controlBody, oldOwnerSignature64, newOwnerSignature64)`; control commitment = SHA-256 of `F('ssterm-sync-control-commit-v1', controlBody, oldOwnerSignature64, newOwnerSignature64)`.

Genesis is generation 1, active epoch 1, previous hash all-zero, and previous-owner fingerprint equal to the independently pinned new-owner fingerprint. Verify both signatures against that pinned key. Later checkpoints must match scope, be exactly generation + 1, reference the accepted previous commitment, identify the pinned old owner and verify both signatures, roster and recovery descriptor. Active epoch stays unchanged or advances exactly one. Device removal, key replacement, writer-to-reader downgrade, owner-key rollover or owner-device transfer requires epoch + 1. Adding a device may retain the epoch. Rollover reissues all certificates under the new owner key; old-owner authorization covers the complete new roster commitment. Unknown roles or unsupported progression stops writes. Fetching a sequence gap does not authorize skipping intermediate checkpoints.

Enrollment request body:

```text
F('ssterm-sync-enroll-v1', '1', suite,
  deploymentId, accountId, vaultId, requestId, newDeviceId,
  deviceEd25519SpkiRaw44, deviceRsaSpkiRaw422, requestedRole,
  issuerOwnerFingerprintHex, baseControlHashHex,
  requestNonceHex64, expiresAtUnixDecimal)
```

The owner issues a random 32-byte request nonce and a separate secret 32-byte RSA challenge. Encrypt that secret using the requester's RSA key with OAEP label `F('ssterm-sync-enroll-oaep-v1', requestBody)`. The challenge plaintext is never included in the public request. Enrollment fingerprint = lowercase hex SHA-256 of `F('ssterm-sync-enroll-fingerprint-v1', requestBody, rsaChallengeCiphertext384)`. Compare the complete fingerprint over an authenticated independent channel before approval.

The requester decrypts the challenge and computes proof hash = lowercase hex SHA-256 of `F('ssterm-sync-enroll-decrypt-proof-v1', enrollmentFingerprintHex, rsaChallengeSecret32, rsaChallengeCiphertext384)`, then signs `F('ssterm-sync-enroll-sign-proof-v1', requestBody, rsaChallengeCiphertext384, proofHashHex)` with its new Ed25519 key. Enrollment proof wire = `F(requestBody, rsaChallengeCiphertext384, proofHashHex, deviceSignature64)`. The owner compares the expected proof, verifies the new signing key, current base checkpoint/owner/scope and independent fingerprint approval. Only then may it certify that exact device/role and publish its wrap/checkpoint.

Expiry is canonical Unix seconds 1…4102444800, at most 300 seconds after challenge issuance. An owner-side monotonic 300-second deadline and durable request-ID/nonce single-use state also apply; restart cancels unresolved challenges. A used/expired request cannot be refreshed by altering its timestamp, role or keys. A timestamp is an enrollment timeout, not evidence that a data write preceded revocation.

Generate/store device keys under fresh provider refs, reconcile ambiguous provider/publication writes and report enrolled only after durable publication confirmation. Ordinary reader/writer devices never obtain the owner private key. A lost owner device requires the independent recovery secret and valid bundle; an ordinary enrolled device is not silently promoted. Teams need separate authorities/vaults and explicit delegation in SST-037; do not hand a personal owner private key to all members.

For data receipt, validate its signature against the referenced authenticated historical checkpoint/certificate, but use the latest accepted checkpoint to decide materialization. A previously unseen operation with an old epoch, stale control commitment or now-revoked/downgraded author is retained as an authenticated conflict, never applied as a current mutation. No timestamp or old valid signature proves pre-revocation creation. Only explicit reconciliation by a currently authorized writer can create freshly encrypted/signed bytes under the current epoch/checkpoint. Exact already-accepted envelope retries are idempotent; already-materialized history may remain readable to a currently authorized reader under retention policy. A currently revoked local device does not newly decrypt/materialize merely because it cached historical keys; a hostile modified client remains outside that promise.

## Recovery format and key loss

Recovery is opt-in and explicit, not an automatic portable export of the current local store. A fresh 32-byte recovery secret is shown once, confirmed by the user and used to encrypt a bundle containing the owner Ed25519 PKCS8 private key and matching SPKI, the pinned control checkpoint/commitment, and explicitly retained epoch keys with vault/epoch identities. Never include local content keys, OS secret refs, authentication tokens or app-lock state. Recovery can recover only included sync material, not unsynced local credentials/snippets/recordings.

Recovery header, exactly 11 fields:

```text
F('ssterm-sync-recovery-v1', '1', suite,
  deploymentId, accountId, vaultId, recoveryId, controlHashHex,
  saltHex, nonceHex, plaintextLengthDecimal)
```

Salt/nonce are freshly random as for operations. Plaintext length is bounded at 8 MiB. Derive `HKDF-SHA256(recoverySecret32, hexDecode(saltHex), F('ssterm-sync-recovery-key-v1', headerBytes), 32)`, then AES-256-GCM with header AAD and 16-byte appended tag. Wire = `F(headerBytes, ciphertextAndTag)`. This is authenticated encryption under the high-entropy recovery secret; a server record or untrusted owner public key cannot substitute for that secret.

After decrypting, validate the private/public owner match, exact scope/epochs, checkpoint signature and expected owner fingerprint. Bound bundle parsing/epoch count before allocation. Re-enroll using fresh device keys, advance control state and rotate the active epoch before writes. Recovery may need separate server-account recovery, which grants no decryption authority by itself. Take an offline recovery drill before claiming a backup is usable.

Recovery payload bytes are exactly:

```text
epochsWire = F('ssterm-sync-recovery-epochs-v1', countDecimal,
               …F(epochDecimal, epochKeyRaw32))
payload = F('ssterm-sync-recovery-payload-v1', '1', suite,
            deploymentId, accountId, vaultId, recoveryId,
            ownerEd25519Pkcs8Raw48, ownerEd25519SpkiRaw44,
            previousOwnerEd25519SpkiRaw44, baseControlWire, epochsWire)
```

Epochs are unique and strictly numerically increasing, 1…4096 entries, each at most the base checkpoint's active epoch; the active epoch must be included. All keys refer to this one vault. Derive the public key from the canonical private key and require exact equality to the supplied public key and base checkpoint's new-owner SPKI. The included canonical previous-owner SPKI must hash to the base checkpoint's previous-owner fingerprint; use that key to verify the old-owner authorization signature, and the recovered new-owner key to verify the possession signature. This supports a base checkpoint that performed owner rollover without pretending the new key can verify its predecessor's signature. Base control wire must reproduce recovery-header `controlHashHex` and match scope. The authenticated recovery secret and independently expected owner fingerprint establish the kit's trust anchor; public keys merely supplied in a bundle do not. A valid base checkpoint does not establish that it is the server's freshest checkpoint.

Avoid a circular ciphertext/checkpoint commitment: the recovery envelope binds the already accepted **base** checkpoint. A subsequent checkpoint commits the recovery descriptor `F('ssterm-sync-recovery-descriptor-v1', '1', suite, deploymentId, accountId, vaultId, recoveryId, recoveryEnvelopeHashHex)`, where recovery-envelope hash = SHA-256 of complete recovery wire and descriptor digest = SHA-256 of descriptor bytes. An all-zero descriptor digest means no published recovery descriptor. Never put that subsequent checkpoint inside its own recovery ciphertext. After an epoch/control change, recovery readiness is pending until a matching updated bundle/descriptor is published and checked. Native storage/publication and the recovery UI/drill remain SST-035 adoption gates, not a shipped import/export API.

Losing all enrolled epoch keys and the recovery secret/bundle makes the affected ciphertext unrecoverable. Preserve bytes and identities; never replace the missing key under its old identity. Display a separate empty-vault creation choice only with explicit consent. A database backup alone does not contain Keychain private keys and is not a portable recovery kit.

Recovery-secret rotation republishes a newly encrypted bundle with a fresh recovery ID/salt/nonce and advances the signed descriptor. It does not erase older bundles or revoke the cryptographic ability of an old secret plus old bundle to recover old owner/epoch material. Suspected compromise requires owner-authority rollover, device review, epoch rotation and re-encryption; existing-device pins limit old-authority replay. A fully reset client with a stale kit cannot establish global freshness against a malicious server without an independent current commitment.

## Lock, logout, rotation and migration

Lock/suspend/quit cancels sync operations, advances lifecycle generations and purges plaintext/private/data-key caches; staged native work may finish, so publication checks generation again. Persistent Keychain entries and ciphertext remain. JS/V8/native copies make zeroization best effort. Unlock never replays remote commands, uploads a credential or bypasses the control checkpoint check.

Logout stops transport, revokes/removes server authentication when reachable and clears caches. The user must distinguish retaining local encrypted data/enrollment from explicitly removing local device private keys. Do not promise remote revocation while offline, erase the only recovery copy, or imply removal of local keys erases copies on other devices/backups.

For rotation/revocation, serialize control changes, stage fresh epoch/provider refs and prepare wraps for remaining authorized devices. Publish one consistent signed checkpoint/roster/wrap set before accepting new-epoch writes. Freeze old-epoch writes; offline edits from that epoch become conflicts requiring authorized re-encryption under a fresh operation ID, never automatic accepted replay. Keep journaled partial state and retry lookup before ambiguous provider/publication writes. Atomicity applies only inside one database transaction, not across Keychain, clients and server.

Revoked readers retain plaintext/old keys/ciphertext already obtained. To protect current retained records from an old epoch key, re-encrypt them under the new epoch and stop serving old ciphertext where policy permits. Old server backups still expose old versions. Retain old keys until every retained record has a verified new copy or explicit deletion decision; never drop the last decrypting key merely because a new epoch exists.

Version migration is explicit, resumable and preserves original envelopes until verified publication/materialization. Unsupported versions/suites stop writes without fallback. Existing local v1 snippets/recordings never undergo this sync migration automatically. Future database migration requires the verified source-version backup and ordinary transaction/failure rules; restored provider journals are fenced against replay.

## Adoption data model and validation gates

SST-036 performs no schema or Keychain migration. SST-035 must design dedicated sync metadata: deployment/account/vault mapping; device certificates and pinned owner/control commitment/generation; immutable outbox/inbox; signed checkpoints, recipient wraps and active epoch; versioned recovery descriptors; pending key/provider/publication journal. No private key, epoch key, recovery secret or app-lock verifier belongs in sync tables, server storage or logs; sync outbox/inbox records are ciphertext. Ordinary local catalog metadata retains its existing plaintext storage classification after validated materialization. Opaque local-to-sync record mapping is local metadata and needs that same privacy classification.

Test sources must be pinned by immutable identity/hash with license attribution. Selected primitive evidence comprises RFC 5869 SHA-256 HKDF vectors, RFC 8032 Ed25519 vectors, AES-256-GCM published known-answer/tamper cases, and the C2SP Wycheproof RSA-OAEP-3072/SHA256/MGF1-SHA256 vector set. RSA encryption is randomized: published ciphertext decryption establishes the known answer; an independent encrypt/decrypt round trip checks the encryption path. Never replace known-answer assertions with self-generated round trips alone.

The reference harness should verify canonical golden headers/commitments, correct scope/epoch/recipient, independent salt/context derivation, signature/AEAD/OAEP mutation rejection, wrong recovery secret, unknown versions, noncanonical/truncated/oversized fields and no unauthenticated plaintext return. Tests of control/role decisions use explicit trusted fixture keys; they are not production enrollment or rollback persistence tests.

Before production adoption also require independent TEST/REVIEW, no unresolved high/critical findings, native Keychain and publication-journal failure recovery, real enrollment/recovery and owner-loss drills, two-device lock/logout/rotation/offline conflicts and tombstones, selective-secret policy, transport/rate/tenant validation and packaged checks. Teams additionally require backend/client role enforcement, tenant isolation, revocation/rekey and offline cache disclosure. These remain SST-035/037 work; internal protocol review is not an external audit.

Rollback of this ticket is documents/tests only. Later rollback disables incompatible sync writes and preserves ciphertext/key refs/checkpoints. Older builds must refuse unfamiliar versions; rollback never silently downgrades protection, replays restored provider actions or creates empty replacement data.

## Primary standards

- [RSAES-OAEP: RFC 8017](https://www.rfc-editor.org/rfc/rfc8017.html) and [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
- [HKDF: RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html); [Ed25519: RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html).
- [Canonical Ed25519 key encodings: RFC 8410](https://www.rfc-editor.org/rfc/rfc8410.html).
- [AES-GCM: NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf); [key management/security strengths: NIST SP 800-57 Part 1 Rev. 5](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-57pt1r5.pdf).
- [C2SP Wycheproof primary vectors](https://github.com/C2SP/wycheproof); [HPKE: RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html).

SST-037 production adoption: [Team vault](team-vault.md) reuses the reviewed primitives with separate human ACL, Owner authority and metadata/credential domains; [delivery](agent-runs/sst-037-delivery.md) records its additional admission, replay, journal, native and runtime gates. Internal review does not constitute an external cryptographic audit.
