# SST-006 — OS secrets and protected snippet content

**2026-10-15 · T009–T010 · implementation complete; independent TEST/REVIEW/DELIVERY pending.** Decision record: [ADR 0003](adr/0003-secret-storage-and-content-protection.md). Contract: [domain/storage spec](termius/domain-storage-spec.md#field-protection-and-exposure).

## Implementation

- **Seam:** [domain types](../packages/domain/src/index.ts) define `SecretProvider` with `read`/`lookup`/`write`/`delete` and typed outcomes. Reads/lookups return `present|missing|locked|denied|unavailable|error`; writes `confirmed|denied|unavailable|unknown|error`; deletes add `missing`. Lookup returns presence only, never bytes. Providers never throw, including on binding construction errors.
- **Keychain Adapter:** [`keychain.ts`](../packages/adapters/src/keychain.ts), imported from the `@ssterm/adapters/keychain` subpath so the storage entry does not load the native binding. `clearTestNamespace` refuses anything but `dev.ssterm.test.<uuid>`.
- **Protection Module:** [`protection.ts`](../packages/adapters/src/protection.ts) `seal`/`open`. Failures raise `ProtectionFault` with `unsupported`, `corrupt` or `invalid` and never modify input bytes. Bodies are at most 1 MiB.
- **Repository:** new finite changes `stage-secret`, `transition-secret`, `publish-secret`, `queue-secret-cleanup`, `retire-secret`, `create/update/delete-key` and `create/update/delete-snippet`. Identity accepts saved `passwordRef` and `method: key`. Known-host trust remains refused (`unavailable`, SST-009). Schema stays v1; no migration was needed.
- **Graph invariants (every commit and open):** each descriptor comes from one completed create/replace operation; each published ref is live-referenced or pending cleanup, never both; at most one unresolved credential operation per owner and kind; unpublished refs have no descriptor; a key's private-key ref changes only through publication. Intended refs are reserved in the ID registry when staged.
- **Open/backup:** open accepts `aes-256-gcm-v1` and pending journal rows; other formats/envelope versions fail `unsupported-protection` with bytes preserved. Commits are no longer blocked by pending rows; backup and migration still are.
- **Service:** [`SecretService`](../packages/services/src/secrets.ts) serializes its work. `storeSecret` stages, writes under the stable intended ref, looks up before every retry (at most two writes) and publishes. Owner-creating changes are accepted only for a new owner; an existing owner gets a plain ref swap, which reconciliation can always reconstruct. `removeSecrets` commits reference removal plus cleanup journal first, then deletes. `reconcile`, `resume` (live re-entry) and `cancel` complete the spec steps. An item found present after `needs-input` publishes; a `needs-input` operation whose owner moved or vanished is cancelled so backup/migration are not blocked. `initializeContentKey` creates a key only for an uninitialized vault without ciphertext and resolves a pending key operation before ever staging another. `saveSnippet` authenticates an existing body before overwriting; `openSnippet` returns a transient holder, or a storage failure when the repository cannot be read.
- **Transient lifetime:** [`TransientSecrets`](../packages/services/src/transient.ts) copies into an owned `Buffer.alloc`, expires within 5 minutes (default 60 s), overwrites on dispose and purges all. Desktop main purges on `lock-screen`, `suspend` and `before-quit`.
- **Composition:** [desktop main](../apps/desktop/src/main/index.ts) lazily imports the Keychain Adapter after storage opens, keeps one `SecretService` and runs non-blocking reconciliation; it only touches the Keychain for unfinished journal rows. A binding load failure leaves storage health intact and secrets unavailable. No preload/renderer secret IPC exists. The main-only [`secrets` entry](../apps/desktop/src/main/secrets.ts) is built to `out/main/secrets.js` for runtime checks.
- **Packaging:** [`package-desktop.mjs`](../scripts/package-desktop.mjs) stages `@napi-rs/keyring` and `@napi-rs/keyring-darwin-arm64` and unpacks `**/*.node` from the ASAR.

## Verification record

Commands at repository root on macOS arm64, host Node 24.11.1, Electron 44.7.2:

| Command | Result |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund --cache /private/tmp/ssterm-m1/npm-cache` | PASS, 414 packages (lock unchanged in the fix round) |
| `npm run runtime:prepare` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS **55/55** (22 secret tests, 18 storage) |
| `npm run build` | PASS; `out/main/{index,storage,secrets}.js`; `index` loads the binding only through a lazy `keychain` chunk |
| `npm run test:e2e` | PASS **11/11**, 0 skipped/flaky |
| `npm run package:mac` | PASS; binding at `app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node` |
| `npm run test:packaged` | PASS **8/8**, 0 skipped/flaky |
| `git diff --check` | PASS |

[Unit tests](../tests/unit/secrets.test.ts) cover:

- one provider contract against the [fault-injection fixture](../tests/fixtures/secrets/memory-provider.ts) and the real Keychain under two fresh test namespaces, with teardown asserting zero items;
- recorded error-shape mapping;
- AES-GCM round trip (empty/Thai/binary), each envelope region, truncation, wrong key/vault/snippet/field and unknown version/format;
- refused payloads for existing owners; definite write refusals (`denied`/`unavailable`) staying pending with lookup before any retry; `locked` lookup/read keeping journal, refs and ciphertext; needs-input present/moved-owner paths; vanished drafts with missing items; still-referenced cleanup refused by repository and service (each guard mutation-checked);
- spec walkthroughs: new-owner publication, crash after OS write (no duplicate write), owner revision conflict cleanup, unknown→missing→needs-input→re-entry, delete with OS denial then retry, failed SQL leaving items, key/identity composition and restricted delete, vanished draft cancellation, first key init after crash and after an ambiguous attempt, restored backup without key, tampered ciphertext refusal;
- redaction across SQLite/WAL/backup/manifest bytes, captured console/stderr and returned results;
- transient TTL/dispose/purge.

[Electron E2E](../tests/e2e/secrets.spec.ts) runs the same spec in development and packaged projects through `out/main/secrets.js` and `storage.js`: direct Keychain binary round trip, content-key initialization, Thai snippet save/reopen/decrypt, password publish/replace/delete with old-ref cleanup, transient purge, no plaintext in database files, and `leftoverItems: 0` after namespace teardown. The packaged run asserts the binding loads from inside the app bundle.

After all runs, `security dump-keychain` attribute output (no secret data) showed **0** items with service `dev.ssterm.test*` and **0** with `dev.ssterm.desktop.secrets`. Tests never use the production namespace, user/Termius data or SSH.

## Known limitations

- Migration still refuses any protected vault ([`migrations.ts`](../packages/adapters/src/migrations.ts)); that gate must be lifted with provider-aware re-encryption before any schema v2.
- The repository validates envelope structure, format and refs, not authenticity or plaintext origin. Future IPC must never forward raw snippet/secret `MetadataChange`s from the renderer; only `SecretService` may produce them.
- Startup reconciliation has no verified-restore fence yet: a restored older database could publish/clean against current OS items. A restore UI does not exist; it must add the fence.
- The `powerMonitor` purge wiring in main has no automated test; only `TransientSecrets.purgeAll` is tested.
- `locked`/`denied` are never returned by the real Keychain Adapter (ADR 0003); their service handling is exercised only through the fixture.

## Remaining scope

No UI, IPC or catalog workflow consumes these capabilities yet (SST-017/023/024). App lock, generation invalidation and resource closure are SST-008/015. See [ADR limitations](adr/0003-secret-storage-and-content-protection.md#limitations).
