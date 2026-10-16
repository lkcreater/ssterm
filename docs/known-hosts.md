# SST-009 — Known-host verification and trust decisions

**2026-10-15 · T015 · DONE through implementation, independent TEST/REVIEW (with focused re-review) and DELIVERY; committed `0e71f80`.** Authorized by “ทำงานถัดไปต่อได้เลย” after SST-008 `bcbb693` and Makefile `b6716fd`. Production saved-host authentication is integrated by [SST-010](ssh-auth.md); SST-009 itself adds no connection/input/credential command.

## Shared policy and public-key identity

[KnownHostPolicy](../packages/services/src/known-hosts.ts) is a main-only Module shared by future terminal/SFTP/tunnel Adapters. `verify` accepts the normalized literal endpoint/port, raw server public-key bytes, the connection AbortSignal and a decision callback. It returns a finite result; no transport, DNS lookup or authentication is hidden inside it.

[Host-key validation](../packages/adapters/src/host-key.ts) uses the selected **ssh2 1.17.0** public `utils.parseKey` with a 16 KiB input bound, supported public-only key types and exact `getPublicSSH` byte round trip. It derives the algorithm and SHA-256 fingerprint from the actual wire key, then stores canonical `algorithm base64` without comments. Persisted key/algorithm/fingerprint agreement is checked on commit and repository preflight; invalid original storage fails closed without replacement.

Supported key identities: Ed25519, RSA and ECDSA nistp256/384/521. Unsupported keys/certificates fail closed. RSA public-key format `ssh-rsa` is separate from negotiated RSA signature algorithms; this ticket does not alter engine negotiation defaults. Protocol references: [RFC 4253](https://www.rfc-editor.org/rfc/rfc4253), [RFC 5656](https://www.rfc-editor.org/rfc/rfc5656), [RFC 8709](https://www.rfc-editor.org/rfc/rfc8709); parser Interface: [ssh2 utilities](https://github.com/mscdex/ssh2/tree/v1.17.0#utilities).

## Verification and persistence

- Unknown endpoint: accept-once, remember or reject. Accept-once writes no row and grants only the current invocation/generation. Remember commits the accepted key before returning trusted.
- Matching remembered key: trusted without a prompt. Recording `lastVerifiedAt` is best effort; a failed write never blocks a matching key.
- Changed key or algorithm: shows previous/new fingerprints and algorithms; only explicit replace or reject is valid. Accept-once/remember cannot bypass a saved mismatch. Replacement keeps the endpoint record ID, resets `firstAcceptedAt` and updates `lastVerifiedAt`.
- Reject, cancelled/expired prompt, lost ownership, failed storage or stale approval cannot authorize authentication. Abort is checked after the decision and before/after persistence; pending decisions race cancellation even if a callback ignores its signal.

Endpoint normalization reuses [normalizeEndpoint](../packages/domain/src/normalize.ts): IDNA/lowercase/trailing dot and IPv6 literal normalization without DNS equivalence. Trust is vault/endpoint/port scoped, independent of catalog labels, duplicates, moves or deletion; different ports remain separate identities.

Existing SQLite schema v1 already contains `known_host`; no migration is added. Finite `accept-known-host`, `verify-known-host`, `replace-known-host` and `revoke-known-host` changes enforce canonical identity and immutable endpoints, row revisions, ID history and atomic rollback. `verify-known-host` is an observation: fenced by the row revision, it updates only `lastVerifiedAt` and revises neither the row nor the catalog, so routine connections never invalidate catalog or revoke previews.

After a prompt, the policy re-reads trust and fences only that endpoint: an unknown endpoint must still have no row, and a changed one must keep the same row ID, revision and key. It then commits against that fresh snapshot in the same synchronous turn. Unrelated saves and other endpoints therefore keep the decision, while any change to this endpoint's trust, such as another session's Remember or Replace, voids it as `conflict` and keeps the newer trust. There is no automatic retry.

`list` returns public projections without raw key bytes. `prepareRevoke(ownerId,id,expectedRevision)` creates a one-minute, owner-bound, single-use preview; at most 64 previews are retained. `revoke(ownerId,token)` is fenced by the previewed row revision, so unrelated saves and matches keep the preview valid while a replacement voids it. Owner disposal removes previews. Revocation deletes only trust; active sessions keep their captured connection and the next verification becomes unknown.

## Desktop Interface and UI

[Controller](../apps/desktop/src/main/known-hosts.ts), [handler composition](../apps/desktop/src/main/known-host-runtime.ts) and [contracts](../packages/contracts/src/known-hosts.ts) expose only trust state/subscription, host-trust answers and prepare/apply revoke. A revoke whose row changed returns the IPC `conflict` code, shown as "This host's trust changed"; other failures stay generic. There is no raw key write, generic repository call or credential prompt bridge. Main composes the policy/controller with the existing registry; [SST-010](ssh-auth.md) now injects the production saved-host SSH adapter when storage and the Keychain provider are available.

The sender must be a registered live application main frame at the exact document, with its current window/generation owner. Decisions additionally bind session ID, attempt generation and prompt ID. State events carry owner/sequence and only host-trust prompts; credentials and secret refs remain main-side. Subscribe-before-snapshot and monotonic filtering prevent stale owner/events from restoring old prompts. Policy notifications refresh registered windows after persistence.

Trust state explicitly reports availability. On storage failure, current prompt removal/cancellation still propagates, approval/replacement is disabled and the UI displays a fixed error. The public known-host list is empty while unavailable; it is not silently treated as a successful empty read. One event carries at most 10,000 sorted entries with an explicit `truncated` flag shown in the list, so prompts are delivered regardless of list size.

[Known hosts UI](../apps/desktop/src/renderer/src/components/trust/known-hosts.tsx) uses existing Signal Blue/Base UI components: enabled navigation, list/empty/error states, explicit revoke confirmation and global unknown/changed-key prompts. Prompts use alert-dialog semantics: an outside click neither dismisses nor decides, and Escape is an explicit reject. They show the captured target label (Thai included), the `production` PROD badge (amber, independent of the red changed-key state), endpoint, algorithm and fingerprint. Reject receives initial focus. Replacement requires a separate verification checkbox. The revoke dialog focuses Cancel and returns focus to the trigger that opened it, even though that trigger is disabled while the preview is prepared. Header and actions stay fixed and only the details scroll, so the focused action remains visible at the 960×640 minimum window. Fingerprints wrap at narrow sizes and dialogs respect reduced motion.

An answered prompt stays visible (busy) until the ordered state stream removes it, so a second answer cannot be sent for it. Destructive confirmations (Replace key, Revoke trust) use the shared `destructive` button variant, now a solid destructive fill with the existing on-destructive ink token; the previous secondary fill with red text measured 4.33:1 and had no other consumer.

## Packaging

The SSH parser remains external to the main bundle (`require("ssh2")` in the validation chunk). [Packaging](../scripts/package-desktop.mjs) stages the pure JavaScript closure `ssh2`, `asn1`, `safer-buffer`, `bcrypt-pbkdf` and `tweetnacl`; optional CPU detection and SSH native acceleration are neither built nor staged. Upstream `ssh2/test` and `ssh2/examples` are filtered out because they are not runtime code and include private-key fixtures. Existing Keychain native binding packaging stays intact.

## Verification record

Commands at repository root on macOS arm64, host Node 24.11.1, Electron 44.7.2, Docker 28.5.2:

| Command | Result |
|---|---|
| `npm ci --ignore-scripts` | PASS, 424 packages (exact `ssh2` 1.17.0, `@types/ssh2` 1.15.6) |
| `npm run runtime:prepare` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS **129/129**, 0 skipped |
| `npm run build` | PASS; `out/main/{index,storage,secrets,catalog,sessions,trust}.js` |
| `npm run test:e2e` | PASS **17/17**, 0 skipped/flaky |
| `npm run package:mac` | PASS, unsigned arm64 |
| `npm run test:packaged` | PASS **14/14**, 0 skipped/flaky |
| `git diff --check` (including untracked files) | PASS |

[Unit tests](../tests/unit/known-hosts.test.ts) cover all supported key formats, malformed/private/unsupported/trailing input, corrupt stored identity preservation, endpoint/IDNA/IPv6/port normalization, restart, catalog rename and deletion independence, one decision shared by terminal/SFTP/tunnel callers, cancellation, lock/owner revocation during a pending prompt (no row, no authentication, prompt removed), decisions surviving unrelated saves and other endpoints, stale Remember/Replace/revoke conflicts that keep the newer trust (including Replace A→B racing A→C), best-effort match recording, preserved catalog previews, changed-key decisions and revoke preview ownership/expiry. [Boundary tests](../tests/unit/known-hosts-boundary.test.ts) cover strict DTOs, the shared algorithm list, IPC owner authorization, revoke `conflict` mapping, list truncation with prompt delivery and unavailable-storage prompt cleanup; [session tests](../tests/unit/sessions.test.ts) cover changed/unknown prompt decision sets.

[Electron tests](../tests/e2e/known-hosts.spec.ts) use the shipped [main-only entry](../apps/desktop/src/main/trust.ts), the production handler factory/controller/policy and the actual renderer. A [test-only raw-key SSH Adapter](../tests/fixtures/known-hosts/ssh.cjs) passes the real `ssh2` `hostVerifier` wire key from the owned OpenSSH Docker fixture to the production policy; there is no fixture fingerprint, auto-trust or packaged trigger. The development and packaged runs both pass this sequence:

1. unknown → an outside click leaves the prompt open and undecided; Reject, then Escape: `Failed`, no authentication, no row; focus returns to the Known hosts navigation;
2. session closed while its prompt is pending: the stale dialog disappears unanswered;
3. Accept once: authenticated, no row; Remember: row committed before authentication;
4. catalog rename → repository close/reopen → prompt-free match with the same fingerprint;
5. rotated server key: the changed prompt shows the renamed target, previous fingerprint and only Reject/Replace, with Reject and Replace in view at 960×640; Reject and Escape both fail `host-key-changed` with the authentication counter unchanged and trust preserved;
6. deliberate replacement keeps the row ID with a new fingerprint, followed by a prompt-free match that leaves the row revision unchanged;
7. revoke preview: Escape cancels and restores focus, confirmation removes trust, and the next connection is unknown again.

The test asserts, and the measured final-state receipt shows in both runs, decisions `reject, reject, accept-once, remember, reject, reject, replace, reject` and **5** authentication starts equal to **5** opened channels; the fixture cleanup receipt is `fixtureCleaned: true`.

The rendered gate captures settled screenshots of the unknown prompt (1280×800), changed key, replacement confirmation, known-hosts list and revoke confirmation (960×640 minimum window, reduced motion) under ignored `artifacts/test-results/{development,packaged}/known-hosts-verifies-real-*/`. The test checks focus containment over Tab, initial focus, Escape and focus return, no horizontal overflow, reduced-motion animation duration and rendered contrast by compositing every ancestor background. All 21 measured labels pass 4.5:1; the lowest are the muted key captions at 4.82:1 and PROD reaches 8.58:1.

Two E2E harness races were fixed in the test, not by weakening assertions: each answer now waits for its dialog to be removed before the next connection, and every main-process helper yields to a fresh macrotask first, since Playwright's inspector `evaluate` can interrupt synchronous main code mid-transaction.

After all runs, `security dump-keychain` attribute output (no secret data) showed **0** items with service `dev.ssterm*`. No fixture containers or the renderer port listener remained. ASAR inspection found the `trust` entry and no project test helper, spike or `ssh2` test/example file; the only `PRIVATE KEY` strings left are ssh2 runtime parser/keygen templates and its static Ed25519 capability-probe key. Test artifacts contain no private-key material. No user/Termius/production systems or credentials are used.

## Known limitations

- Runtime suites require the [owned fixture prerequisites](sessions.md#verification): the Docker daemon, `ssterm-ssh-fixture:m0` and the isolated spike dependencies.
- Remember, Replace and revoke still advance the catalog revision, so a catalog preview prepared before such a trust decision must be prepared again; matches no longer affect previews.
- SST-009 evidence below used a test-only transport. [SST-010](ssh-auth.md) separately verifies the production policy-to-transport glue with saved credentials in development and packaged Electron.
- No real SFTP or tunnel caller exists yet; the shared-policy unit test covers them by construction through the one policy instance.
- `ssh2/util/pagent.exe` (a Windows Pageant helper used only on Windows) is still staged; release packaging review belongs to SST-028.
- Physical OS lock, full app-lock/provider reconciliation, credential prompt workflows (SST-011), terminal byte streams, actual SFTP/tunnel adapters and release signing remain later gates. No SST-009 commit/push/deployment is included in this authorization.
