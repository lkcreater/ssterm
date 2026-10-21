# SST-037 — Team vault, human ACL and revocation

Status: delivered through independent TEST/REVIEW and final automated gates. Local commit follows this delivery record; no push or deployment.

## Behavior and boundaries

[Team vault](../team-vault.md) adds a separately configured team per profile and separately provisioned team server. Owner manages principals, approval, recovery and explicitly shared SSH passwords; Editor edits host metadata and connects; Connector connects; Viewer reads metadata without credential ciphertext/wrap access. Personal sync, app unlock and catalog schema 4 remain independent.

Two cryptographic domains and an Owner-signed policy bind human principals to approved device keys and tokens. Membership changes use online compare-and-swap and atomically re-encrypt current retained records. Role changes remove every device of the affected person, rotate both domains and require explicit fresh device enrollment. No private SSH-key sharing, managed Files/forwarding/jumps/proxies, offline editing or deployment is included.

Managed UUID bindings and tombstones never become personal catalog hosts or fall through to personal credentials. A direct Team terminal requires fresh online authorization before resolve and again after SSH host trust before password release. Observed access loss closes affected pending/live managed sessions; other personal/local sessions remain independent. Offline existing SSH can continue until access loss is observed. App revocation cannot erase copied credentials or change the server's SSH password. Opt-in terminal recording can retain Team terminal output.

Team recovery uses independent encrypted kits and secrets, checks current epoch coverage and replaces the sole Owner authority device. Native selection success is tested through the shipped dialog seam with owned files; actual native picker interaction remains a manual check.

## Review fixes

- Ordinary cross-domain device admission must carry the same enrollment identity/proof; recovery uses its explicitly paired per-domain kit hashes.
- Signed snapshot ancestry prevents replay of old data from moving observed data pins or retiring new virtual hosts.
- Monotonic OS checkpoint validation rejects restored pending write/policy journals before downgrading OS authority/data heads. Interrupted genuine transactions can reconcile exact bytes.
- Confirmed provider references retain confirmed state; missing published keys never silently regenerate. Authorization denial persists across restart and suppresses decrypted offline metadata.
- Explicit Team lock closes managed sessions and remains locked across state reads. Replacement tokens are staged before existing-profile enrollment policy fetch, while authority/scope/checkpoint pins remain validated.
- Native recovery drafts honor the service deadline across delayed Save, same-owner lock/re-unlock fences replies, and Open rejects special files without blocking.

## Verification

No unresolved high/critical findings remain in independent protocol/client and desktop reviews. Independent focused review passed 38/38 and 59/59; the final verified-ciphertext catch-up change passed independent affected tests 19/19. An independent owner-recovery → member-role-change → current-owner-fingerprint re-enrollment drill passed 1/1; the old fingerprint was rejected.

| Gate | Actual result |
|---|---|
| Final Node24 serial unit | 769 total / 768 passed / 1 skipped / 0 failed; Homebrew bash5 unavailable, owned Docker bash5.2 passed |
| Independent earlier full serial unit | 767 total / 766 passed / 1 skipped / 0 failed |
| Final `npm run typecheck` / build / macOS arm64 package | Passed; no lint script exists |
| Development full regression | 83 passed / 1 obsolete bridge-allowlist assertion failed; corrected and final focused shell/app-lock/Team/release gates passed 11/11 |
| Packaged full regression | 85/85 passed, no skips |
| Exact-final rebuilt package | 10/10 passed: Team2, personal Files/SFTP2, release sweep3, artifact3 |
| Owned Team Docker lab | 10/10 plus exact-container cleanup passed |
| Owned Team CLI provisioning/listener smoke | 2/2 passed |
| Markdown relative links / `git diff --check` | Passed |

The final two changes after the full runtime baseline are bounded, resumable verified-ciphertext ancestry caching and omission of unsupported Open in SFTP for Team pane menus. They received the final unit/typecheck/build, independent affected review and exact-final packaged focus above. The broad runtime suites were not repeated after those two scoped changes. The Team tests scan client DB/WAL/SHM and server storage for fixture passwords/metadata; native test namespaces are cleaned by the shared launch fixture.

Source-stage diagnostics: the first production Team connection exposed a UUID-only owner check, while the actual desktop owner is `window:<id>:<generation>`; the validator now matches the registry ownership namespace. Early bridge allowlists were updated for the two deliberate Team methods. The release sweep initially expected disabled status after page reload, but reload deliberately locks Team; it now asserts the available setup UI. A raw-IPC connect test now uses the real Team Connect UI to reveal the captured pane. These failures were corrected and their affected gates rerun, rather than reported as passed.

Evidence logs (local, not committed): `/private/tmp/ssterm-team-exact-final-unit.log`, `ssterm-team-independent-unit.log`, `ssterm-team-exact-final-typecheck.log`, `ssterm-team-full-development.log`, `ssterm-team-final-development-focused.log`, `ssterm-team-final-packaged.log`, `ssterm-team-exact-final-packaged-focused.log`, `ssterm-team-docker-lab.log`, `ssterm-team-cli-smoke.log`.

## Rollback and limits

Preserve the separate private `team/` database, encrypted snapshots, Keychain references, checkpoint/provider/publication journals and managed-host tombstones. Disable Team actions or roll back application code without routing its reserved IDs to personal hosts. No catalog migration occurs. Preserve old ciphertext and kits on failed recovery; do not recreate authority/key material to bypass a missing key.

Only owned loopback/Docker fixtures and fresh `dev.ssterm.test.*` Keychain namespaces are used. No service was hosted, no production credentials were read and nothing was pushed or published. Ad-hoc macOS arm64 packaging is not Developer ID signing or notarization. Existing manual Thai IME, VoiceOver, menu/TCC, native TextEdit and release/signing checks remain pending.

## Local artifact

The final zip is a local trial from the pre-commit dirty implementation tree (`06303ca` parent), not a clean-commit or Developer ID release. `npm run release:local -- --allow-dirty` verified the sealed ad-hoc bundle, and the exact-final artifact gate verified checksum and extraction. No upload or publication occurred.

- File: `artifacts/release/SSTerm-0.1.0-darwin-arm64.zip`
- Bytes: 136094806
- SHA-256: `b2601b64634e00886976256ddd1afbf717112e93d1a55f5955a44fbf8288f3ad`
