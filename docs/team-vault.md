# Team vault — SST-037 behavior and protocol

**Implemented contract;** see [delivery](agent-runs/sst-037-delivery.md) for actual verification and remaining manual checks. SST-037/T046 follows personal sync commit `06303ca`. One team/profile and one team/config/database/listener. Personal035/protocol bytes stay unchanged; use production [sync crypto](sync-crypto.md), never fixtures. No deploy/SSO/external accounts.

## Human permissions and data boundaries

| Human role | View metadata | Terminal connect | Edit metadata | Shared-password mutation | Membership / recovery |
|---|---|---|---|---|---|
| Owner | Yes | Yes | Yes | Yes | Yes |
| Editor | Yes | Yes | Yes | No | No |
| Connector | Yes | Yes | No | No | No |
| Viewer | Yes | No | No | No | No |

One active Owner principal with exactly one approved authority device. Reject extra Owner-device joins; recovery replaces it. Other principals support multiple devices. canManage requires this device/key. Metadata roles: owner device=owner, Editor=writer, Connector/Viewer=reader. Credentials: owner device=owner, other connect-capable devices=reader; Viewer gets no certificate/wrap/payload.

Separate metadata/credential vault UUIDs, epoch keys, controls and snapshots; policy binds both. Approved device keys may occur in both scope-bound rosters. Team authority/Keychain/store/recovery never reuse personal/local/app-lock material.

Initial metadata: direct hosts and encrypted member labels. Online CAS only; cached metadata read-only offline. No team snippets/key sharing/jumps/proxies/SFTP/tunnels/templates. Separate Owner-opt-in password records contain `{credentialId,recordId,targetDigest,password}` only inside credential ciphertext. No passwords in metadata/policy/catalog/personal sync/events/projections.

`targetDigest = SHA256(F('ssterm-team-target-v1',teamId,recordId,address,portDecimal,username))` uses exact validated effective fields. Password use requires matching record/digest; Editor endpoint changes require Owner re-sharing. No personal/provider/prompt fallback or implicit local password path.

## Frozen shared types

`packages/domain/src/team.ts` defines strict pure validators and types below, importing existing SyncScope/SyncControlPublication/SyncOperationPublication. Canonical lowercase UUID/hash, unpadded base64url; strict fields and compact JSON roundtrip.

```ts
type TeamRole = 'Owner' | 'Editor' | 'Connector' | 'Viewer';
interface TeamScope {
  deploymentId: string; accountId: string; teamId: string;
  metadataVaultId: string; credentialVaultId: string;
}
interface TeamPrincipal {
  principalId: string; role: TeamRole;
  status: 'active' | 'revoked'; tokenHash: string;
}
interface TeamDevice { deviceId: string; principalId: string }
interface TeamPolicy {
  format: 'ssterm-team-policy-v1'; scope: TeamScope;
  generation: number; previousHash: string;
  previousOwnerFingerprint: string; ownerSpki: string;
  ownerPrincipalId: string; ownerDeviceId: string;
  metadataControlHash: string; credentialControlHash: string;
  principals: TeamPrincipal[]; devices: TeamDevice[];
}
interface TeamSignedPolicy {
  body: TeamPolicy; oldOwnerSignature: string; newOwnerSignature: string;
}
interface TeamDomainPublication {
  control: SyncControlPublication; snapshot: SyncOperationPublication;
}
interface TeamRecoveryKit {
  format: 'ssterm-team-recovery-v1'; basePolicy: TeamSignedPolicy;
  metadataRecoveryWire: string; credentialRecoveryWire: string;
}
interface TeamAtomicPublication {
  policy: TeamSignedPolicy;
  metadata: TeamDomainPublication; credentials: TeamDomainPublication;
  recovery: TeamRecoveryKit | null;
}
interface TeamPublishRequest {
  expectedPolicyHash: string | null;
  expectedMetadataHash: string | null;
  expectedCredentialHash: string | null;
  publication: TeamAtomicPublication;
}
interface TeamReceipt {
  policyHash: string; generation: number;
  metadataHash: string; credentialHash: string;
}
interface TeamWriteRequest {
  policyHash: string; expectedHead: string;
  operation: SyncOperationPublication;
}
interface TeamWriteReceipt { policyHash: string; head: string }
interface TeamPolicyCheckpoint {
  policy: TeamSignedPolicy;
  metadataControl: SyncControlPublication;
  credentialControl: SyncControlPublication;
}
interface TeamPoliciesResponse {
  checkpoints: TeamPolicyCheckpoint[];
  nextGeneration: number; hasMore: boolean;
}
interface TeamStateRequest { knownPolicyHash: string | null }
interface TeamState {
  checkpoint: TeamPolicyCheckpoint;
  metadataHead: string; credentialHead: string;
  metadataSnapshot: SyncOperationPublication;
  credentialSnapshot: SyncOperationPublication | null;
  metadataWraps: string[]; credentialWraps: string[];
}
interface TeamRecoveryResponse {
  kit: TeamRecoveryKit | null;
  checkpoint: TeamPolicyCheckpoint;
  metadataHead: string; credentialHead: string;
  metadataSnapshot: SyncOperationPublication;
  credentialSnapshot: SyncOperationPublication;
}
interface TeamHost {
  recordId: string; label: string; address: string;
  port: number; username: string;
  environment: 'DEV' | 'STAGING' | 'PROD' | null;
}
interface TeamMetadataSnapshot {
  format: 'ssterm-team-metadata-v1'; hosts: TeamHost[];
  memberNames: {principalId:string; label:string}[];
}
interface TeamPassword {
  credentialId: string; recordId: string;
  targetDigest: string; password: string;
}
interface TeamCredentialSnapshot {
  format: 'ssterm-team-credentials-v1'; credentials: TeamPassword[];
}
interface TeamConnectRequest {
  requestId: string; policyHash: string;
  metadataHash: string; credentialHash: string; recordId: string;
}
interface TeamConnectGrant extends TeamConnectRequest { expiresAt: number }
interface TeamClientEvent {
  eventId: string; requestId: string; policyHash: string; recordId: string;
  action: 'connect-requested' | 'connect-ready' | 'connect-ended';
}
interface TeamAuditEntry {
  sequence: number; time: number; principalId: string | null;
  deviceId: string | null; recordId: string | null;
  policyHash: string | null; requestId: string | null;
  action: 'policy-published' | 'metadata-written' | 'credential-written'
    | 'connect-authorized' | 'request-denied'
    | 'client-connect-requested' | 'client-connect-ready' | 'client-connect-ended';
  outcome: 'accepted' | 'denied';
}
interface TeamAuditPage {
  entries: TeamAuditEntry[]; firstAvailableSequence: number;
  nextSequence: number; hasMore: boolean;
}
```

Scopes use `{deploymentId,accountId,vaultId}` with distinct metadata/credential vault IDs. Caps:32 total principals,128 active devices/hosts/credentials,1MiB plaintext/domain,256 policies/64MiB,256 operations/64MiB per domain,256 wraps/publication. Recovery wires128KiB each/kit512KiB; policy128KiB; signatures64/SPKI44. HTTP12MiB/four bodies; eight client mutations/one native or mutation IPC per window. Reject limits without protected-data pruning.

## Exact policy transcript and progression

Use the existing length-prefixed `F` encoding and suite literal. Sort principals by principal ID and devices by device ID; no duplicate IDs, token hashes or device assignments. A device ID/key pair cannot move to another principal across history. `principalsWire = F('ssterm-team-principals-v1', countDecimal, ...F(principalId, role, status, tokenHash))`; `devicesWire = F('ssterm-team-devices-v1', countDecimal, ...F(deviceId, principalId))`.

```text
policyBody = F('ssterm-team-policy-v1', '1', suite,
 deploymentId, accountId, teamId, metadataVaultId, credentialVaultId,
 generationDecimal, previousHashHex, previousOwnerFingerprintHex,
 ownerSpkiRaw44, ownerPrincipalId, ownerDeviceId,
 metadataControlHashHex, credentialControlHashHex,
 principalsWire, devicesWire)
oldSignature = Ed25519(oldOwner, F('ssterm-team-policy-authorize-v1', policyBody))
newSignature = Ed25519(newOwner, F('ssterm-team-policy-possession-v1', policyBody))
policyHash = SHA256(F('ssterm-team-policy-commit-v1', policyBody,
 oldSignatureRaw64, newSignatureRaw64))
```

Genesis: generation1, previousHash zero, old/new owner same independently pinned key, one Owner/device, two domain genesis controls. Initial Owner token authorizes first valid genesis: token squatting can deny initialization; client never adopts another authority. Later policy is exactly generation+1/previous hash/pinned old owner with both signatures. Both controls advance once per policy and share policy generation/authority device. Preserve retained certificate admission fields.

Policy devices exactly cover metadata roster and credential-eligible subset; Owner mapping count1 equals ownerDeviceId. Invited non-Owners can have zero devices. Revoked principal tombstones remain, but their current devices/certificates/wraps disappear. Reinvite as fresh principal/token/keys; device assignments cannot move principals. Non-Owner extra devices reuse their existing human token. Snapshot arrays are unique/sorted/exact-schema; no offline merge. Permanent virtual-host tombstones still prevent source fallback.

Revoke/role change rotates both epochs, removes ineligible devices, and re-encrypts complete current snapshots before one publication. Owner recovery also changes authority/device. Device addition may retain epochs. Recovery-descriptor confirmation retains epochs but advances controls and re-encrypts snapshots. CAS captures policy and both data heads to prevent overwriting concurrent edits. Preserve failed staged keys/bytes and freeze writes; never expose half-rekey. Remote SSH passwords require separate operator rotation.

Enrollment reuses production RSA challenge/Ed25519 proof in metadata scope, derived device role/current control,300s expiry, monotonic deadline and durable nonce/request single use. Candidate fixes principal/human role/base policy. `teamEnrollmentHash=SHA256(F('ssterm-team-enrollment-v1',teamId,principalId,humanRole,basePolicyHash,existingEnrollmentFingerprintHex))`; independently compare it. Both newly admitting controls carry that public proof and certificates use this hash/their admission generation. Team verifier checks this deliberate cross-domain binding/keys; personal verifier/bytes unchanged. Adding credential access needs fresh proof. Recovery has the kit exception below.

## Server / transport contract

Separate TeamServer/team-cli, private schema1 config/database with scope/listen/initialOwnerPrincipalId/initialOwnerTokenHash. Init reveals random32 Owner token once; store hashes only. After genesis signed policy controls active principal token hashes; initial token never bypasses membership. Owner stages new-principal tokens locally before publish; secret transfer is manual and explicit. Public candidate/challenge/proof never contains the token; no automatic messages.

Root-origin HTTPS (literal-loopback HTTP only), no redirects/renderer networking. Headers Deployment/Account/Team/Principal plus Bearer43; signed requests add Device/Nonce/Signature (all X-SSTerm-). Bind token principal to active policy device. Sign `F('ssterm-team-http-v1',method,path,deploymentId,accountId,teamId,principalId,deviceId,nonceHex64,SHA256(rawBody))`. Nonce60s/128 pending;120 requests/min team/principal/address,16KiB headers,15s completion. Token-only routes expose no wraps/data except explicit Owner recovery ciphertext.

| Route | Auth / exact request → response |
|---|---|
| `GET /team/v1/info` | Public → `{protocol:'ssterm-team-v1',scope,suite}`; discovery only |
| `GET /team/v1/challenge` | Active principal token → existing `SyncChallenge` |
| `GET /team/v1/policies/<afterGeneration>` | Principal token → `TeamPoliciesResponse`, pages <=8; every returned control has wraps empty and recoveryWire null |
| `POST /team/v1/publish` | Owner token plus signed policy/controls; genesis accepts initial Owner token → `TeamPublishRequest` / `TeamReceipt` |
| `POST /team/v1/state` | Signed active device → `TeamStateRequest` / `TeamState`; controls sanitized as above, wrap arrays only requesting device, credential snapshot/wraps null/empty for Viewer |
| `POST /team/v1/metadata` | Signed Owner/Editor → `TeamWriteRequest` / `TeamWriteReceipt` |
| `POST /team/v1/credentials` | Signed Owner designated authority device → `TeamWriteRequest` / `TeamWriteReceipt` |
| `POST /team/v1/connect` | Signed Owner/Editor/Connector → `TeamConnectRequest` / `TeamConnectGrant`, expiry <=15s |
| `GET /team/v1/audit/<afterSequence>` | Signed Owner device → `TeamAuditPage`, <=100 entries |
| `POST /team/v1/events` | Signed active connect-capable device → `{events:TeamClientEvent[]}` (<=16) / `{accepted:number}` |
| `GET /team/v1/recovery` | Current Owner token, no enrolled-device signature → `TeamRecoveryResponse`; encrypted kit and current encrypted snapshots plus sanitized public checkpoint, no wraps/private keys; full contiguous chain fetched through the paginated token-only policies route |

`createTeamTransport({endpoint:{url,scope},principalId,deviceId,readToken,signRequest,fetch?})` returns info/policies/publish/state/writeMetadata/writeCredentials/connect/audit/events/recovery, optional AbortSignal each. Fixed deviceId is required before constructing the signed transcript; signRequest returns `{deviceId,signature}` and must match it. Reuse SyncTransportResult codes, raw32 token/raw64 signature callbacks. Active invited-principal token allows public policy discovery before finishJoin; no data until device approval.

Publication validates signatures/controls/rosters/admissions/wraps/snapshot epochs and all three CAS heads before one SQL transaction. Both domains change atomically; exact retries return original receipts. Data writes require current policy/control/epoch, authorized device, expected head and exactly that parent. Stage immutable bytes before network; reply-loss lookup/retry never re-encrypts. Clients validate decrypted schemas and current disposition; server cannot inspect plaintext.

Connect checks active human/device/role and exact policy/heads; client checks record existence and target digest. Fresh nonce/TLS gives online enforcement, not global freshness against a malicious server withholding policy.

Audit: fixed IDs/actions/outcomes/hashes only; accepted mutation+event in one transaction, eventId deduplication. Keep10000 entries and report firstAvailableSequence; no protected-data pruning. Bound denial logging. Client Ready/End is self-reported, not proof of remote execution/completeness or server tamper resistance.

## Client, managed connection and UI seam

`TeamClient({repository,keyStore,transportFactory,now,monotonicNow,onAccessChange})` uses production crypto directly. Separate private team.sqlite schema1 stores ciphertext/pins/permanent virtual IDs/journals; separate `team/v1/...` Keychain owner/device/epoch/token/checkpoint refs. Apply035 stable-ref lookup/high-water/lifecycle fences; no replacement of missing published keys or SQL plaintext. Same-owner lock/native-dialog fencing applies.

| Public service method | Behavior / result |
|---|---|
| `state()` | Sanitized status/scope/principal role/device/policy generation/domain epochs/host views, canManage and recovery readiness; never passwords/keys/tokens |
| `create({endpoint,token,principalId,displayName})` | Pin independent authority, stage device/epoch/token refs and publish genesis; returns state |
| `invitePrincipal({label,role})` | Owner-only; role is Editor/Connector/Viewer. Stage fresh principal/token refs, online atomic policy publish with zero devices and encrypted member label; after confirmed publication return `{principalId,token,scope,ownerFingerprint,endpoint}` once for explicit secret transfer |
| `reissuePrincipalToken({principalId,expectedPolicyHash})` | Owner-only explicit replacement with fresh ref/hash and policy publication; old token invalidates, return new token once; never silently regenerate a lost token |
| `beginJoin({endpoint,token,principalId,expectedOwnerFingerprint})` | Stage fresh device keys; return `{candidateText}`; no membership inferred from possession of a token |
| `challengeEnrollment({candidateText,principalId,role})` | Owner-only; bind an already invited principal/current role, refuse second Owner device; return `{challengeText,fingerprint,expiresAt}` |
| `proveEnrollment({challengeText})` | Verify expected team/authority/principal, return `{proofText,fingerprint}` |
| `approveEnrollment({proofText,confirmedFingerprint})` | Owner-only, online CAS, one-use proof; return state; no token echo |
| `finishJoin()` / `fetch()` | Verify contiguous policy+controls/high-water and unwrap only authorized domains; cache authenticated current metadata read-only offline |
| `saveHost({record,expectedMetadataHash})` / `deleteHost({recordId,expectedMetadataHash})` | Owner/Editor online CAS; return state; no personal catalog mutation |
| `sharePassword({recordId,password,consent:true,expectedMetadataHash,expectedCredentialHash})` | Owner-only explicit target capture, fresh encrypted credential record; returns state |
| `replacePassword(...)` / `detachPassword({recordId,expectedCredentialHash})` | Owner-only online captured-target CAS; no renderer password readback |
| `changeRole({principalId,role,expectedPolicyHash})` / `revokePrincipal({principalId,expectedPolicyHash})` | Owner-only, all relevant devices, both domains rotate and complete snapshots re-encrypt before atomic publish; pending/error remains visible |
| `authorizeConnect({virtualHostId,session})` | Main-only, online state+role/head check; returns captured managed config/lease, no plaintext password |
| `loadManagedPassword({session,source})` | Main-only after host trust; online/expiry/source recheck; returns disposable owned password bytes, never renderer data |
| `audit({afterSequence})` / `reportConnection(event)` | Sanitized bounded pages / truthful client event submission |
| `createRecovery()` / `confirmRecovery({confirmationToken,secret,kit})` | Owner-only transient draft then offline drill/native-save confirmation + descriptor publication |
| `recover({endpoint,token,principalId,expectedOwnerFingerprint,secret,kit})` | Independent Owner kit, fresh authority/device, both epochs rotate, current retained data re-encrypted; returns state only after durable publication |
| `lock()` / `logout({forgetTransportToken})` | Generation fence, aborts/purge; preserves encrypted bytes and explicitly retained keys; no claim of remote erasure |

Results: `{ok:true,value:T}` or sanitized `{ok:false,code}`; sync codes plus key-unavailable/untrusted-authority/fenced for desktop. Recheck policy/heads/lifecycle after awaits. Notify onAccessChange before further managed actions. Invitation token uses stable journaled Keychain ref through reply loss, reveals once after confirmed explicit invitation; never SQL/log/audit/persistent UI. Names encrypted. Loss requires explicit Owner reissue.

**Shared gate:** `SessionRegistry.options.resolve(hostId,{ownerId,sessionId,generation,kind,signal})`; personal callbacks ignore context. All terminal/SFTP/tunnel/reconnect paths use it. Main checks permanent TeamRepository virtual UUID bindings first: denied/missing/revoked/error/collision never falls through to personal. No personal Host rows. Team nonterminal requests fail before network/credential work.

Cloneable/frozen config source only: `{kind:'team',teamId,principalId,deviceId,recordId,policyHash,metadataHash,credentialHash,leaseId}`. Guard registers pending exact session before awaits. Shared SSH managed-password hook runs after KnownHostPolicy trust; online policy/head/15s grant recheck before release. Changed target/policy aborts. Missing password/revoke/offline/digest mismatch fails closed, no provider/prompt fallback. Disposable owned bytes obey SSH abort/cleanup contracts.

Connection exports agreed with client/connection owners: `hasVirtualBinding(hostId):boolean` includes tombstones; `resolveCapturedHost({virtualHostId,session:{ownerId,sessionId,generation,kind,signal?}}):Promise<TeamResult<ResolvedHostConfig>>` (authorizeConnect alias); `loadManagedPassword({session,source}):Promise<TeamResult<{bytes:Uint8Array,dispose():void}>>`; `observePolicy(listener):()=>void`, event `{teamId,principalId,deviceId,role:TeamRole|null,policyHash:string|null,canConnect:boolean}`. `source.leaseId` is the initial grant requestId. Post-trust reauthorization uses a fresh requestId but requires identical captured policy/data heads and target digest; no capability/function crosses the config clone or IPC.

`TeamSessionGuard` tracks exact pending/live bindings; observed revoke/connect-role loss purges credentials and closes affected sessions via registry.close. Disclosed15s polling while managed sessions exist; no unrelated network. Offline new connects fail closed; existing SSH can continue until observed revoke/lock/close. Team/PROD source remains visible. Test raw UUID, reconnect/split/templates and SFTP/tunnel paths: UI disablement is insufficient.

## Independent recovery and limitations

Independent random32 team secret, transient5min draft/native Save/Open lifecycle fences. Two production recovery envelopes bind accepted base controls C and signed base policy P; include authority and retained domain epochs, no personal keys/tokens/app-lock. Offline verify both envelopes/scope/owner/control hashes. Subsequent P+1/C+1 descriptors commit those envelope hashes (epochs unchanged, current snapshots freshly encrypted), avoiding self-reference.

Recovery also needs independently retained current Owner transport token; lost login requires separate operator account recovery, never substitute authority. Fresh device cannot /state: Owner-token /recovery supplies kit/current ciphertext/public checkpoint, and /policies supplies contiguous chain. No wraps/private keys. Verify kit base/chain and retained keys cover current epochs before any publication; same-epoch edits recover, stale missing epoch fails preserving bytes, never empty replacement. Fresh sole owner replaces old owner device/authority, rotates both epochs/reissues retained devices/re-encrypts current data. Admission uses kit hash backed by historical descriptors plus dual old/new signatures; no other fresh admissions exempt. Ordinary members get no owner private key. Key changes mark recovery pending until fresh verified kit.

Exact recovery certificate admission: metadata `enrollmentHash=SHA256(decoded kit.metadataRecoveryWire)`; credential `enrollmentHash=SHA256(decoded kit.credentialRecoveryWire)`. Both must match their existing recovery descriptors in the **same historically accepted paired kit/basePolicy publication**, with exact scope; never mix envelopes from two kits. No new combined-kit cryptographic format. Require sole fresh owner device, old owner device removed, authority changed, both epochs+1 and fresh-device signed wraps; policy and both controls retain their old/new authority signatures.

Revocation cannot retract copied keys/plaintext, change remote SSH passwords or stop another SSH client. Connect-capable modified clients can extract credentials. Operator rotates remote credentials after disclosure. Old authorized metadata can remain cached offline until observed revoke/lock; no secure deletion/global freshness/backup erasure claim.

## Ownership / acceptance / rollback

- Server/protocol owner: `packages/domain/src/team.ts`, `packages/adapters/src/team-policy.ts`, `team-transport.ts`, `apps/sync-server/src/team-*.ts`, Team CLI/script and server/policy/transport fixtures/tests. Freeze exported DTOs first; no personal server mutation unless root coordinates a genuinely shared helper.
- Client owner: `packages/services/src/team*.ts`, `packages/adapters/src/team-repository.ts`, `team-keychain.ts`, client/password/recovery/rekey tests. Do not edit existing session or desktop files.
- Connection owner: `packages/domain/src/catalog.ts` optional source typing, `packages/services/src/sessions.ts`, `ssh-session.ts`, desktop `main/ssh.ts` and new team session guard; associated session/SSH gate tests. Root coordinates composition to avoid overlapping edits.
- Root: initial authorization/plan, exports/manifests/build, contracts/main IPC/preload/renderer/native dialogs, source-of-truth status and real development/packaged tests. Independent TEST/REVIEW/DELIVER and local commit follow; no push/deploy.

Gates: real multi-human/multi-device role matrix and forged IPC; Viewer no credential decryption; Editor no secret mutation; principal-wide revoke/rekey; tenant substitutions; offline/stale CAS; changed endpoint rejects old password; UUID/reconnect/SFTP/tunnel bypass; trust-before-password; connecting/live closure; Keychain/reply-loss; team recovery; bounded audit; owned SSH and packaged cleanup/plaintext scans. Actual gate results and source-stage evidence are recorded in the [delivery](agent-runs/sst-037-delivery.md); the contract alone is not test evidence.

Rollback disables team actions, preserving ciphertext/pins/virtual tombstones/provider refs/journals. Personal schemas unchanged; team schema1 rejects unknown versions; future migration needs verified backup. Never replay restored journals/replace published keys or route managed IDs to personal hosts.

### Role changes and virtual host routing

Every role change removes all devices of that principal and rotates both key domains. The principal remains active with its new role; each device must complete explicit enrollment again with fresh device keys. A Viewer upgrade never grants a credential wrap to its old device keys. Re-enrollment preserves prior journals, pins and virtual-host tombstones.

Managed virtual host IDs use the reserved UUIDv8 prefix `7ea03700-`. This is a routing marker, not authorization: the shared resolver rejects the namespace when the team client or binding is unavailable, even if a personal catalog row has the same ID. Managed team hosts are never materialized as personal catalog rows.

An explicit server authorization denial also invalidates local team access and closes affected sessions. A revoked principal cannot retrieve the new signed policy with its old token, so this state means current access was denied; it does not claim the client decrypted a revocation publication. Network unavailability alone does not close established sessions; new managed connections still require an online check.

### Observed data heads and signed ancestry

A valid signature alone does not make an older snapshot current. Before changing a data pin, cached snapshot or virtual-host tombstone, the client verifies a single-parent signed operation chain back to its last observed head in each readable domain. Missing ancestors are read individually through signed `GET /team/v1/operations/{metadata|credentials}/{hash}` requests; Viewer requests for credential operations are denied. Each operation is checked against its authenticated historical control and exact requested commitment. Traversal is capped at 256 operations and 64 MiB per domain; cycles, old genesis, forks and missing history fail closed without moving data pins or retiring bindings. Current members may retrieve encrypted historical operations, but receive only current eligible epoch wraps.

### Explicit Team lock and local cache

Lock Team vault closes all managed Team sessions through the main session guard, clears decrypted metadata and transient enrollment/recovery state, and leaves the client locked. Reading Team state does not unlock it. A deliberate Fetch or Resume action can unlock the Team client; the application-wide lock still gates every Team IPC action first. Forget-token additionally removes the saved transport token without replacing encryption identities.

An observed authorization denial is persisted, so reopening the same client does not restore its old decrypted metadata cache. Successful authenticated current state or an accepted local publication clears that marker. Offline cache restore verifies both the OS data pin and the stored ciphertext commitment/signature before showing bounded metadata. It does not authorize a new SSH connection or a metadata edit.

Individually verified ciphertext ancestry proofs are retained before a catch-up completes, within the same immutable operation-history bounds. A rate-limited/interrupted retry can continue from those proofs without re-fetching the same prefix. This cache never advances current snapshots, OS data pins or virtual-host tombstones until the complete chain reaches the prior observed head. Valid detached ciphertext can consume the bounded history budget; limits fail closed without pruning protected records.
