# SST-035 / T045 — independent personal encrypted sync

Date: 2026-10-21. Independent TEST / REVIEW / DELIVER passed; authorized local commit follows.

## Result and scope

Personal sync is opt-in and manual: Publish, Fetch, Review and Apply. A self-hosted Node 24/SQLite server stores ciphertext and signed public control data; the desktop signs/encrypts in main, uses separate Keychain identities and a dedicated private sync journal, and keeps catalog schema 4/local snippet protection unchanged. No hosting, deployment, external account service or team feature is introduced.

Portable data includes hosts/groups/tags, password/keyboard-interactive login metadata without credentials, and snippet text. SSH keys, passwords/passphrases, known-host trust, local paths, settings, recordings/history and app-lock data stay local. Remote imports preserve an existing local password only for the same mapped method/username; explicit reviewed detach/delete queues ordinary local secret cleanup. Key identities are excluded and affected authentication is clearly flagged for local setup.

- [Behavior, protocol adoption and limits](../sync.md)
- [Cryptographic protocol](../sync-crypto.md), [ADR 0006](../adr/0006-sync-cryptography-and-key-lifecycle.md)
- [Server operation](../../apps/sync-server/README.md)
- [Execution plan and authorization](implementation-plan.md#sst-035-execution-plan--independent-self-hosted-encrypted-sync-2026-10-20)

## Validation evidence

- Independent final serialized unit: **707 total / 706 passed / 1 skipped**, no failures; Homebrew bash 5 is absent. Focused final sync suite **119/119**. Node 24.11.1 was used, including real loopback SQLite/service tests and fault-injected provider/publication/materialization boundaries.
- Server focused **17/17** and owned Linux arm64 Docker smoke **8/8**, with exact label-verified container cleanup. Standalone server CLI TypeScript check passed.
- `npm run typecheck`, `npm run build`, affected Markdown file links/JSON manifests and `git diff --check` passed. No lint script. Existing Rollup Zod annotation/circular catalog-chunk warnings remain.
- Full development E2E **81/81** before the late recovery-lock regression; final-build shell/app-lock/sync selection **8/8** before that finding. The red regression failed on the old package, then passed **1/1** on the rebuilt package, including dropped server publication response → exact retry, visible-secret purge, native Save lock/reopen without owner rotation, and no late kit/secret. Final-build development selection passed **9/9** after all lifecycle/resource fixes (shell, app-lock and all three sync cases); final packaged suite below covers the exact same source and all desktop cases plus this new regression.
- Final `npm run package:mac` passed: macOS arm64, ad-hoc signature only. `npm run release:local -- --allow-dirty` produced a local **trial** zip/checksum/manifest for artifact validation; nothing is published, notarized or Developer ID signed. This is a dirty-tree local trial, not a clean-commit production release.
- Final packaged suite: **83/83 passed**, no skips or retries, including the local trial zip checksum/extraction/signature test and native recovery-lock regression. Log: `/private/tmp/ssterm-sync-final-packaged.log`.

No test-only crypto harness is imported into application code. Credential-bearing tests disable automatic traces/screenshots/video. All profiles, keys, Keychain namespaces, tokens and server databases are owned disposable fixtures. Two-profile tests verify exact Thai/multiline snippet plaintext after local re-encryption, independent branch merge, preserved crypto identity after logout/resume, owner-loss recovery, and plaintext-at-rest scans. Keyboard/focus/reduced-motion/contrast/overflow checks cover 960×640 and 1280×800.

## Review and fixes

Independent crypto, server and client reviews found and resolved:

- Historical valid operations could bypass current revocation/role changes: unseen stale bytes now remain conflicts. Explicit per-record decisions by a current writer create fresh signed/encrypted operation bytes under the current checkpoint/epoch before materialization. Reader devices cannot authorize reconciliation.
- SQL-only checkpoint restore: separate Keychain public high-water binds repository identity/generation/commitment; missing/conflicting pins stop writes and only exact contiguous replay may reconcile older SQL.
- Native recovery Save race/lifetime: check owner/app gate and the captured lifecycle epoch after dialog and before rename, use private staging, bound kit reads even under file growth, expire/wipe both service and main drafts, cancel secret retention after native Save cancellation. An already-dispatched successful native rename can win a later lock; no retroactive erasure promise.
- Empty-vault genesis: personal bootstrap token explicitly authorizes the first valid signed genesis. A compromised token can squat an empty server; the intended client independently pins its own key and refuses the wrong authority. Later changes still require accepted owner signatures.
- Request memory: four authenticated body permits before accumulation; fifth request rejected, permits released on cancellation.
- Interrupted setup: explicit cancellation only before any accepted/staged control publication, with journaled provider deletion/readback. Potentially published or joining state remains preserved.
- Existing active-tunnel mutation policy: fast-fail before Apply and a synchronous borrowed-repository guard at the actual catalog commit prevent an async preparation race; two focused IPC/catalog regression cases pass.
- Logout/reconnect: forgetting transport authentication preserves encryption identities; resume authenticates before provider mutation and uses a fresh digest-pinned ref. Revoked devices remain blocked and keep only data already held.

Earlier validation failures are preserved candidly: missing private sync-directory creation was fixed; a broad E2E locator was scoped to the host row; an outdated bridge API allowlist was updated. A parallel full-unit run stalled in an existing native PTY cleanup test. Diagnostics showed no blocked write or surviving owned child; only its verified test child was terminated. Exact native test 1/1 and native file 11/11 passed without source changes, then serialized full unit passed. Docker restart smoke initially assumed a stable random published port; it now rediscovers the owned mapping. A later red unit and real pre-fix packaged regression proved that unchanged window ownership alone did not fence workspace-lock recovery callbacks or clear the secret view. Main now captures the service lifecycle epoch through native dialogs; UI observes the catalog lock epoch, unmounts sensitive Settings and ignores stale replies. The pre-fix package had 81 passes/one conditional release-zip skip; it is not the final delivery artifact. These unsuccessful or pre-fix runs are not counted as final passes.

## Limits, rollout and rollback

The server uses one explicitly configured personal tenant per database/listener, with full scope validation. Remote TLS/reverse-proxy/filesystem administration belongs to the operator. First bootstrap token confidentiality is essential; a malicious server can deny/fork/omit. Reset-client stale-kit global freshness, malicious authorized clients, plaintext exports, backups and remote erasure remain outside the guarantees. This is an internally reviewed independent construction, not an external cryptographic audit.

The payload is one complete snapshot, capped at 1 MiB including tombstones. Local immutable operation journal limits are 256 operations/64 MiB plus 256 checkpoints/64 MiB of checkpoint history, eight active/queued client mutations, one mutation/native dialog per desktop window, and 256 total epoch-recipient wraps per publication; reaching a cap stops sync without truncating/deleting local work. Automated pruning/migration beyond those bounds is not shipped. Conflict previews are capped at 2,048 characters per side and explicitly mark truncation. Native zeroization is best effort. Keychain calls/native work already dispatched may outlive cancellation; quit fences callbacks and bounds its drain.

Rollout: local opt-in only. Stop sync/forget token keeps encrypted data and encryption identities. Rollback disables incompatible writes and preserves sync ciphertext, control pins and provider journals; older builds ignore the separate sync directory. Do not silently delete keys or downgrade envelopes. No catalog schema migration occurred. Existing Thai IME/VoiceOver/menu/TCC/TextEdit manual release checks and Developer ID/notarization remain pending. Local commit only, no push or publication. SST-037 remains the next separately scoped ticket in the authorized order.
