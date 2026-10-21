# Independent personal sync — SST-035

**Implemented within the bounded personal-v1 scope; automated gates passed.** This document records the personal self-hosted transport and client boundaries frozen before coding. The exact cryptographic bytes remain [SST-036](sync-crypto.md) and [ADR 0006](adr/0006-sync-cryptography-and-key-lifecycle.md). No hosting, deployment, team ACL, Termius compatibility or external cryptographic audit is claimed.

## Decisions and assumptions

- Node 24 built-in HTTP(S), crypto and SQLite; no new server framework, account provider or crypto library. Each server configuration contains one explicitly provisioned personal account/vault; independent tenants use separate configurations/databases/listeners. Every request still checks the full deployment/account/vault scope; SST-037 can extend provisioning without conflating personal and team authorities.
- Sync is off until the user explicitly supplies an endpoint and account token. HTTPS is mandatory except literal loopback HTTP for owned local tests. Endpoints are origins (path empty or `/`) only. No redirects, URL credentials, fragments or query strings. Renderer never performs network requests or receives private signing/wrapping/epoch keys.
- Manual **Publish**, **Fetch**, **Review merge**, **Apply**: local edits remain local until Publish; fetching never silently replaces the catalog. Concurrent records and deletion/edit conflicts require explicit decisions. This is deliberate product behavior, not background automatic sync.
- The existing local catalog stays schema 4. A separate private `userData/sync/sync.sqlite` has its own application ID, identity manifest and schema 1. Keys/tokens live in separate versioned Keychain accounts. Local snippets retain their existing encryption format/content key.
- Assumptions: trusted client/OS; operator protects the server configuration and configures TLS for remote use; users compare complete enrollment fingerprints through an independent authenticated channel. The server can deny service/fork/omit. A reset device with a stale recovery kit has no independent freshness witness.

## Usage and bounded scope

Start the owned server using [the server guide](../apps/sync-server/README.md). In Settings → Encrypted personal sync, enter its URL, deployment/account/vault IDs and private account token; review the excluded-data policy before Create vault or Join device. Compare the complete owner/enrollment fingerprints independently. Publish captures local portable data; Fetch obtains ciphertext; Review shows merge decisions; Apply commits only the reviewed graph. Stop all starting, active or stopping tunnels first; main rechecks that existing catalog policy synchronously at the final commit, including if a tunnel started during asynchronous preparation. Stop sync can forget the token while retaining keys/data; Resume re-authenticates that same device. A removed device reports Revoked and retains only data it already had.

The complete portable snapshot is capped at 1 MiB, including all metadata, text and retained tombstones; reject rather than truncate. The client journal retains at most 256 immutable operations/64 MiB of operation records, plus 256 checkpoints/64 MiB of checkpoint records. A client admits at most eight active/queued mutations; desktop IPC permits one mutation/native dialog per window until completion. It does not silently prune ancestry, ciphertext, tombstones or the last decrypting key. Reaching these limits stops further sync and requires explicit future retention/migration work; it does not delete local data. Each control publication permits at most 256 total epoch-recipient wraps, so retained epochs and devices jointly consume that budget. These are bounded personal-v1 limits, not unlimited archival service guarantees.

## Frozen shared DTOs

The server owner creates `packages/domain/src/sync.ts` containing the following pure serializable types and strict shape/bounds validators. Node-only cryptographic parsing stays in adapters. Every byte string below is strict unpadded base64url; decode and re-encode must reproduce the original string. Unknown/duplicate JSON fields, unsupported versions, malformed UTF-8 and over-limit messages fail before cryptographic work. DTOs do not carry plaintext catalog content or private keys.

```ts
export interface SyncScope {
  deploymentId: string;
  accountId: string;
  vaultId: string;
}
export interface SyncInfo extends SyncScope {
  protocol: 'ssterm-sync-v1';
  suite: 'rsa3072-oaep-sha256_ed25519_hkdf-sha256_aes256gcm';
}
export interface SyncEndpoint {
  url: string;
  scope: SyncScope;
}
export interface SyncControlPublication {
  controlWire: string;
  rosterWire: string;
  wraps: string[];
  recoveryDescriptorWire: string | null;
  recoveryWire: string | null;
  enrollmentProofs: string[];
}
export interface SyncOperationPublication {
  wire: string;
  parents: string[];
}
export interface SyncOperationEntry extends SyncOperationPublication {
  sequence: number;
}
export interface SyncChallenge {
  nonce: string; // 64 lowercase hex characters, generated by server
  expiresAt: number; // Unix seconds, no more than 60 seconds ahead
}
export interface SyncRequestAuth {
  deviceId: string;
  nonce: string;
  signature: string; // exact raw Ed25519 signature64, base64url
}
export interface SyncExchangeRequest {
  afterSequence: number;
  operations: SyncOperationPublication[];
}
export interface SyncExchangeResponse {
  operations: SyncOperationEntry[];
  nextSequence: number;
  hasMore: boolean;
}
export interface SyncControlsResponse {
  controls: SyncControlPublication[];
  nextGeneration: number;
  hasMore: boolean;
}
export interface SyncPublicationReceipt {
  controlHash: string;
  generation: number;
}
export interface SyncRecoveryResponse {
  publication: SyncControlPublication | null;
}
export type SyncTransportCode =
  | 'invalid' | 'unauthorized' | 'forbidden' | 'conflict'
  | 'stale-control' | 'rate-limited' | 'too-large'
  | 'unsupported' | 'unavailable' | 'cancelled';
export type SyncTransportResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SyncTransportCode };
```

All IDs are canonical lowercase UUIDs. Parents are unique sorted 64-character lowercase hashes, maximum 64. Sequence/cursor is a safe nonnegative integer; generation/epoch is 1…4294967295. A publication contains at most 256 wraps and 256 enrollment proofs, each bounded by the protocol. Data wire maximum is 1 MiB + 2048 bytes; operation plaintext maximum 1 MiB. An exchange carries at most 8 operations and at most 12 MiB decoded/raw HTTP bytes; each response page is at most 12 MiB, with no empty successful page while `hasMore` is true. Control GET pages at most 8 complete publications within the response cap. Recovery envelope maximum 8 MiB + 2048 bytes. A control publication with all fields encoded must fit the 12 MiB HTTP cap; reject before mutation if not. Outer HTTP JSON uses canonical compact `JSON.stringify` encoding: parsing and reserialization must exactly reproduce the UTF-8 bytes, rejecting duplicate fields and noncanonical whitespace/number representations; strict per-DTO validators separately reject unknown fields. Error body is exactly `{ok:false,code}` with a fixed code; never return exception messages, server paths, token fragments or payloads.

## Provisioning, routes and authenticated transport

The server CLI initializes an empty owned database from an explicit config file, created privately by the operator. Its config contains `deploymentId`, `accountId`, `vaultId`, `tokenHash` (SHA-256 of a CSPRNG 32-byte account token), database path and listen address. The init helper prints the random token once; it does not store plaintext tokens or generate owner encryption keys. Refuse nonempty/foreign/unsupported databases; a restart uses the same scope/token hash. A Docker/local fixture provisions only owned temporary data. No public registration, password authentication, Google identity or cloud service is introduced.

All routes except `GET /v1/info` require `Authorization: Bearer <43-character-base64url-token>` and exact `X-SSTerm-Deployment`, `X-SSTerm-Account`, `X-SSTerm-Vault` headers matching the configured scope. Constant-time compare the fixed-size token digest. Authentication failure reveals no tenant details. Do not log request bodies, Authorization, signatures, credentials or account tokens. CORS is disabled; this is a main-process API, not a browser service.

| Route | Additional auth | Request / response |
|---|---|---|
| `GET /v1/info` | None | `SyncInfo`; the response is discovery, never an authority pin |
| `GET /v1/challenge` | Account bearer | `SyncChallenge`; bounded one-use nonce, max 60 seconds, no body |
| `POST /v1/controls` | Account bearer plus signed checkpoint | `SyncControlPublication` → `SyncPublicationReceipt`; atomic compare-and-publish |
| `GET /v1/controls/<afterGeneration>` | Account bearer | `SyncControlsResponse`; public control/roster/proofs, **wraps empty and recoveryWire null** in these discovery responses |
| `POST /v1/exchange` | Bearer + nonce/device signature | `SyncExchangeRequest` → `SyncExchangeResponse`; active reader may fetch, only owner/writer may submit |
| `GET /v1/wraps/<epoch>` | Bearer + nonce/device signature | `{wraps:string[]}` for that active authenticated recipient only; epoch bounded by accepted control |
| `GET /v1/recovery` | Account bearer | `SyncRecoveryResponse`; latest descriptor-bound encrypted kit and its public publication with **wraps empty**, user-initiated recovery; account recovery grants no plaintext/decryption authority |

Signed request headers are `X-SSTerm-Device`, `X-SSTerm-Nonce`, `X-SSTerm-Signature`. The device signs:

```text
F('ssterm-sync-http-v1', methodUppercase, exactPath,
  deploymentId, accountId, vaultId, nonceHex64,
  lowercaseHexSHA256(exactRawHttpBodyBytes))
```

The signature is separate from SST-036 envelope/control signatures; it does not change them. GET body is empty. Server consumes the nonce once, checks the current signed roster/device role immediately before handling, and rejects absent/revoked devices even when an older challenge was issued. Account-level token possession permits viewing public controls and encrypted recovery bytes and has the explicit empty-server initialization role below. It does not independently authorize operation ciphertext/wrap reads or data writes. Bound outstanding nonces to 128 per account and requests to 120 per minute per source address/account; reject excess challenge creation. Bound headers to 16 KiB, body to 12 MiB and request completion to 15 seconds before body accumulation. Restart invalidates all outstanding nonces. Invalid submissions consume their nonce; retries request a new nonce while resending identical immutable operation bytes.

**Genesis initialization:** the first structurally valid, correctly signed genesis submitted with the configured personal bootstrap bearer initializes an empty server vault. The server verifies both genesis signatures against the authority public key embedded in that genesis and the exact configured scope; it has no prior server-side owner fingerprint pin. The intended creating client generates its own owner authority independently, durably pins that exact fingerprint **before** upload, and verifies any returned checkpoint against its own pin. It never adopts a different owner merely because the server or bearer holder supplied it. Someone holding the bootstrap token can initialize the empty server first under their own authority, preventing the intended client from initializing it. That is an explicit initialization/availability risk: the intended client fails on the conflicting pinned authority, rather than accepting it or uploading data encrypted for it. The untrusted server can already deny service. Provision the bearer privately and complete first initialization before sharing it; this is an operator action, not an automatic client trust decision.

After genesis, control publication must advance exactly one generation from the currently stored hash and enforce all SST-036 public certificate, roster, epoch, admission and descriptor rules. Later authority changes require authorization by the already pinned old owner and possession proof by the new owner; the transport token alone cannot replace that authority. Exact already-stored publications are idempotent; same generation with another commitment conflicts. New admission proofs are checked for exact fingerprint/body/new-key signature linkage; only the owner can verify the confidential RSA challenge answer and its independent user approval, and the owner-signed certificate attests that approval.

The server stores each control publication, its verified public indices, wraps, optional descriptor/kit and all contained admission links in one SQLite transaction. A descriptor must match its kit hash and scope; no descriptor may name absent bytes. A control with all-zero descriptor has no active kit. Unchanged nonzero descriptor may reuse an already stored matching kit. Recovery readiness after epoch/control change is pending until a matching updated bundle/descriptor is checked; a stored older descriptor is not automatically current recovery coverage.

Exchange validates the active role, current epoch/control, signature, parents digest, operation ID/commitment/salt uniqueness and epoch operation ceiling before storing. Duplicate ID or salt with differing bytes is a conflict. An exact accepted retry remains idempotent after rotation but does not admit fresh stale bytes. Append sequence allocation, immutable insertion and deduplication are one transaction. Unknown parents cannot become applied heads; client retains incomplete causality until ancestors arrive. Server/client both preserve rejected offline immutable bytes for explicit conflict reconciliation rather than silently replacing them. Server acceptance alone never grants current materialization permission: the receiving client verifies the operation's historical signature/authorization, then separately checks its disposition against its latest accepted control. A previously unseen operation under an older epoch/control or from a now-revoked/downgraded author remains an authenticated conflict. It is not applied directly, even if a server presents a genuine old accepted operation. Only explicit reconciliation into fresh operation bytes signed by a currently authorized writer under the current epoch/control permits that pending mutation to materialize. Exact previously accepted history may remain readable under the documented retention/access policy; no timestamp proves a stale operation preceded revocation.

The main-only transport has this frozen interface. Each method fetches its own nonce when required, takes an AbortSignal, rejects redirects and bounds stream reads. `auth` is a callback which signs only the exact prepared request bytes; transport never receives a private key or plaintext record.

```ts
interface SyncTransport {
  info(signal?: AbortSignal): Promise<SyncTransportResult<SyncInfo>>;
  controls(afterGeneration: number, signal?: AbortSignal):
    Promise<SyncTransportResult<SyncControlsResponse>>;
  publishControl(publication: SyncControlPublication, signal?: AbortSignal):
    Promise<SyncTransportResult<SyncPublicationReceipt>>;
  exchange(request: SyncExchangeRequest, signal?: AbortSignal):
    Promise<SyncTransportResult<SyncExchangeResponse>>;
  wraps(epoch: number, signal?: AbortSignal):
    Promise<SyncTransportResult<{ wraps: string[] }>>;
  recovery(signal?: AbortSignal):
    Promise<SyncTransportResult<SyncRecoveryResponse>>;
}
```

`createSyncTransport({endpoint,readToken,signRequest,fetch?})` is implemented in `packages/adapters/src/sync-transport.ts`. `readToken():Promise<Uint8Array>` returns the raw 32-byte token (transport encodes it as 43-character base64url), and `signRequest(transcript:Uint8Array):Promise<{deviceId:string;signature:Uint8Array}>` returns a raw 64-byte signature. Both are main-only owned-buffer callbacks. Wipe returned token/signature buffers after constructing the bounded request; JS/native copies remain best effort. Enrollment messages are explicitly exchanged as bounded public text in the UI; no relay endpoint or transport-private challenge secret is needed.

## Client persistence and key lifecycle

`SyncRepository` owns `sync.sqlite`: identity/version/state; endpoint/scope/local-vault mapping; accepted controls and pinned owner/generation/hash; immutable outbox/inbox (wire, parents, commitment, sequence and verdict); local-to-sync record mapping; materialization baseline; provider/publication/materialization journals; used/cancelled enrollment IDs/nonces; current recovery descriptor/readiness. No private keys, epoch keys, token, recovery secret, plaintext snippet or decrypted snapshot belongs in SQL.

Separate `SyncKeyStore` accounts use `sync/v1/<scope>/<device>/<kind>/<ref>` with owner-signing, device-signing, device-wrapping, epoch and transport-token kinds, plus a public checkpoint high-water record. Account identity includes immutable fresh opaque refs. Stage intended refs durably before Keychain writes; after confirmed or ambiguous writes, lookup the exact same ref before retry. Never generate a replacement under a published identity. Keep complete device enrollment unpublished until every required provider item is confirmed and the immutable control publication is durably staged. Query/retry the same control hash after ambiguous server success. Reconcile by lookup/publication receipt on startup/unlock; missing published material becomes key-unavailable, never empty-vault creation. Restored/foreign journal identity fences writes and requires explicit reconciliation.

A public checkpoint high-water record in Keychain binds the repository identity, accepted generation and commitment, so restoring older SQL alone cannot silently lower a device’s control pin. A missing or conflicting published pin blocks writes; fetching the exact contiguous chain may reconcile an older SQL checkpoint. This is not a global freshness witness for a fully reset device.

`SyncClient` serializes mutations, uses a lifecycle generation and checks it again after every await and before SQL/server/catalog publication. Lock/suspend/logout/quit abort transport, cancel unresolved enrollment challenges, clear plaintext/private-key caches and wipe owned buffers. Persistent ciphertext/keys remain. Logout means stopping and forgetting the local transport token when explicitly selected; it does not claim remote device revocation. Device removal is a separate owner rotation action.

Enrollment is an explicit public-text exchange: joining device creates fresh unpublished device keys and displays a candidate `{scope,newDeviceId,signingSpki,wrappingSpki,requestedRole}`. Owner issues the exact SST-036 challenge, records its secret transiently with monotonic deadline and durable single-use ID/nonce, and displays the challenge. Requester verifies scope/current owner pin, decrypts RSA challenge, signs proof and displays proof plus full fingerprint. Owner independently compares that fingerprint and approves; then signs the added certificate/control, wraps retained epochs for the device, and atomically publishes. Restart cancels unresolved challenges. Owner/writer/reader roles are explicit; ordinary members receive no owner private key.

Recovery export shows a fresh 43-character secret once and requires explicit confirmation. The encrypted kit contains the owner key, exact base checkpoint and retained epoch keys only. Save/export via a native dialog; never include account token, local content keys or app lock. A user recovery drill decrypts and verifies the saved kit against independently expected owner fingerprint before claiming readiness. Recovery on a fresh profile validates the kit plus every control continuation, creates fresh device keys, rolls owner authority and epoch, reissues retained certificates and wraps, publishes consistent control, and only then permits writes. A stale/contradictory server chain stops. Ordinary epoch rotation retains old keys until every retained record has a verified fresh snapshot or explicit deletion decision.

**Owner-loss admission clarification:** ordinary new devices require the normal owner challenge/proof/fingerprint approval. The one narrowly scoped exception admits a fresh replacement owner device during recovery: exactly one newly admitted certificate, role owner; both owner authority and owner device change; the previous owner device is removed; epoch advances exactly one; both old-owner authorization and new-owner possession signatures cover the complete new checkpoint/roster; the fresh device proves signing-key possession through its signed recipient wraps. Its nonzero certificate `enrollmentHash` is SHA-256 of an already published, same-scope, descriptor-bound encrypted recovery kit retained in current or historical control storage. The server must verify the matching stored descriptor and exact kit hash; a supplied arbitrary kit hash is insufficient. No other new certificates may use this exception and retained certificates preserve original admission metadata. The recovering client independently decrypts/verifies that kit, checks its externally expected owner fingerprint and contiguous control continuation, and rejects a changed authority or an active epoch beyond the kit's retained key coverage. A transport bearer does not substitute for either owner's signatures or kit validation. This is an explicit recovery admission path, not a general bypass of enrollment or a change to any SST-036 transcript bytes.

## Portable snapshots, merges and catalog materialization

One immutable encrypted operation contains one complete versioned portable snapshot, not a SQLite dump. Strict UTF-8 JSON payload fields are `format:'ssterm-catalog-sync-v1'`, `records`, `tombstones`. Each record is `{id,type,data}` using a stable sync UUID and one of `host`, `group`, `identity`, `tag`, `snippet`. Records and tombstones are unique sorted by `(type,id)`. A tombstone is `{id,type}` retained across subsequent snapshots; absence from one snapshot is not itself a delete. Links/auth references use sync IDs; local IDs, catalog revisions, timestamps, opaque secret refs and local vault IDs never cross the boundary. Host tag IDs/snippet tag IDs are sorted arrays in the respective record data. A snapshot must fit the 1 MiB protocol limit including all metadata/bodies/tombstones, and materialization must fit the existing 1000-change commit limit; reject explicitly without truncation/partial import.

Allowed fields follow the existing domain models: hosts include label/address/environment/port/group/jump/proxy and portable auth; groups include label/parent/port/auth; tags include label; snippets include label/body/tagIds; identities include label/username/method limited to password or keyboard-interactive. Password refs are always absent. Key identities and their metadata/private/public key bytes are excluded; auth referencing them becomes `clear` with a review warning that local authentication setup is required. Password metadata imports without a password. An existing local password ref may remain only for the same mapped identity with unchanged method and username, never attach another device's refs or silently transfer a credential to a renamed login.

Known-host trust, all SSH key metadata/private material, passwords/passphrases, local paths, tunnel rules, templates, app settings, recordings/history, app-lock state and recovery plaintext are excluded. Initial enable reviews this policy and labels. Export decrypts snippet bodies transiently through existing SecretService only for this explicit action; failure to open any selected body aborts the whole snapshot. No plaintext snapshot queue/cache persists to disk.

Snapshot operations reference the sorted known heads as protocol parents. Compare base/local/remote portable records by canonical normalized content, not timestamps or catalog revision. A changed record on one branch merges with unchanged data on the other. Identical changes coalesce. Different edits of one record, delete versus edit, duplicate normalized tag labels, missing dependencies and invalid host/group cycles remain explicit conflicts. Delete/delete coalesces; tombstones prevent silent resurrection. Each conflict offers Keep local, Use remote or explicit Restore as new record with a fresh stable ID. No winner is chosen from time/arrival order. More than 64 heads or ambiguous/incomplete ancestry stops automatic reconciliation; user can explicitly review bounded branches and create a fresh current signed reconciliation operation.

Review captures the local catalog revision, mapping generation, source operation hashes and merged projected digest. Apply rechecks them, prepares local snippet ciphertext under the existing local content key, validates the complete projected domain graph, and commits all MetadataChanges once. Creating local content-key state is reconciled before apply; existing `SecretService.saveSnippet` calls must not be looped as a supposedly atomic snapshot import. Add a narrow main-only batch-preparation seam, never expose raw local keys over IPC.

A separate-database materialization journal is required: stage `{sourceHashes,expectedCatalogRevision,beforePortableDigest,projectedPortableDigest,state}` before the catalog transaction, then mark confirmed afterwards. A crash between stores can be reconciled by comparing current projected digest; if neither digest establishes the result, require explicit review instead of replaying catalog writes. Preserve stable sync→local mappings before apply; when a tombstoned local ID is permanently reserved by entity_registry, deliberate restore allocates a fresh local ID while retaining the chosen sync identity rules. Imported deletes/credential detachments are previewed with existing domain impacts and secret cleanup journaling; remote data never silently deletes local Keychain values. UI reports success only after confirmed local commit and materialization state.

## Public client API and desktop integration

`packages/services/src/sync.ts` exports `SyncClient`, accepting `{repository,keyStore,crypto,transportFactory,catalog,secrets,now,monotonicNow}`. Root owns composing these behind the existing WindowBoundary/app-lock feature gate. Each method returns sanitized `{ok:true,value}` or `{ok:false,code}`; code includes invalid, conflict, unsupported, key-unavailable, stale-control, untrusted-authority, fenced, unavailable. Native file dialogs remain desktop adapters; services use bytes and explicit consent tokens.

| Method | Input / result |
|---|---|
| `state()` | Counts/status, endpoint scope, device ID/role, accepted generation/epoch, recovery readiness and conflict summaries; no bodies/tokens/private keys |
| `create({endpoint,token,expectedScope,deviceLabel})` | Generate owner+device+epoch keys, journal, pin and publish genesis; return enrolled status only after durable confirmation |
| `beginJoin({endpoint,token,expectedScope,expectedOwnerFingerprint,role})` | Fresh pending device keys; return bounded candidate text |
| `challengeEnrollment({candidateText})` | Owner-only; return challenge text, request ID, complete fingerprint and expiry |
| `proveEnrollment({challengeText})` | Requester; verify owner/scope, return proof text and complete fingerprint |
| `approveEnrollment({proofText,confirmedFingerprint})` | Owner-only one-use approval; publish certificate/control/retained epoch wraps |
| `finishJoin()` | Fetch/verify full pinned chain; require exact device admission and confirmed provider keys, then unwrap epochs and mark enrolled |
| `fetch()` | Fetch controls first, verify and pin each contiguous checkpoint; then current-device ciphertext/wraps; store immutable inbox, report conflicts/counts, no catalog writes |
| `publish()` | Capture and validate current portable snapshot against baseline; store immutable encrypted outbox before network; exact retries reuse bytes; stale work remains conflict |
| `review({operationHashes})` | Decrypt authorized versions transiently, three-way merge; return review token, summaries and record-level conflicts with bounded user-visible values |
| `apply({reviewToken,resolutions})` | Revalidate captured catalog/sync generations, domain-validate and commit one batch; update baseline/journal only on confirmed result |
| `rotate({removeDeviceIds,readerDeviceIds})` | Owner-only; freeze old writes, stage epoch, publish current roster/wraps/checkpoint; mark recovery refresh pending |
| `createRecovery()` | Owner-only; return transient secret+encrypted kit+confirmation token, no plaintext persisted |
| `confirmRecovery({confirmationToken,secret,kit})` | Offline decrypt/validate drill, then publish descriptor checkpoint; report readiness only for verified retained material |
| `recover({endpoint,token,expectedScope,expectedOwnerFingerprint,secret,kit})` | Fresh device enrollment plus authority/epoch rotation as above; preserve kit/bytes on any failure |
| `cancelSetup()` | Explicitly cancel only a preparing setup with no accepted control and no staged publication. Journal deletion/readback of unpublished provider refs; leave partial cleanup retryable. Joining or potentially published state is preserved. |
| `lock()` | Synchronous generation fence/cache purge/AbortControllers; idempotent |
| `resume({token})` | Re-authenticate the same retained enrollment after forgetting its transport token. Wrong tokens cause no provider write; the new opaque transport ref is journaled/read back before attachment, without regenerating encryption identities. |
| `logout({forgetTransportToken})` | Fence, stop transport, optionally journal local token deletion; preserve encrypted store/enrollment and disclose remote-revocation limit |

Review tokens are random, generation-bound, short-lived and single-use. Conflict previews are transient plain text capped at 2,048 characters per local/remote version, with an explicit truncation marker; they never enter the sync database. The renderer observes the workspace catalog lock epoch, closes Settings and clears setup tokens, enrollment proof inputs, recovery secrets and review bodies on close/lock. Both main native-dialog callbacks and late UI replies are lifecycle-epoch fenced, including lock followed by re-unlock under the same unchanged window owner. No automatic traces/screenshots/video in credential-bearing tests. IPC requests/responses are strictly validated in main/preload and owner-scoped. The UI uses existing Signal Blue controls with explicit target endpoint/vault/device role and distinct pending/offline/conflict/key-loss states; recovery and app-lock recovery remain visually separate.

## Ownership, gates and rollback

- Crypto coder: `packages/adapters/src/sync-{crypto,control,recovery}.ts` and focused production crypto tests. Preserve exact SST-036 exports/bytes and test against independent known answers; never import the fixture harness.
- Server/transport coder: shared `packages/domain/src/sync.ts`, `apps/sync-server/**`, `packages/adapters/src/sync-transport.ts`, owned server fixtures and server/transport unit/integration tests. Implement the frozen DTO/routes above; ask root before changing a shared contract.
- Client coder: independent sync repository/keychain adapters and `packages/services/src/sync*.ts`, focused persistence/lifecycle/merge/materialization tests. Root coordinates a narrowly scoped local snippet-import preparation seam because existing secrets code overlaps integration.
- Root: package exports/build/typecheck inputs, desktop main/IPC/contracts/preload/renderer and native dialog integration; docs/status and end-to-end multi-device/packaged evidence. Independent tester/reviewer/delivery follow final implementation.

Required evidence: production primitive vectors; malformed/oversized/duplicate JSON and scope/token/nonce tests; revoked read/write and cross-tenant denial; SQL/provider ambiguity and crash recovery; owner→writer/reader enrollment, fingerprint mismatch/reuse/restart; real Keychain round trip/cleanup; offline independent merges and edit/delete conflicts/tombstones; local credential preservation/exclusion/plaintext-at-rest scans; recovery wrong-secret/stale-kit/owner-loss drill; lock/logout generation races; actual two-device owned server lab and desktop/preload/UI; development and packaged suites with native dependencies. Manual release checks/signing remain their existing independent gates. No acceptance item is marked complete by this design document.

Rollout is local opt-in only; no deployment. Backups identify catalog and sync stores separately and state that neither includes Keychain secrets. A future sync DB migration requires verified source-version backup and a resumable transaction chain. Unknown sync versions stop sync writes while preserving catalog access where safe. Rollback disables sync and preserves ciphertext, pins, provider refs and unfinished journals; older application builds ignore the separate directory. Never replay a restored provider journal automatically, silently downgrade envelopes or fabricate an empty replacement vault.
