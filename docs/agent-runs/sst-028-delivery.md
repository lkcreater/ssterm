# SST-028 delivery record — macOS package / release readiness

**Status: automated release readiness complete; Developer ID signing/notarization and manual checks pending.** Authorized by “เริ่ม SST-028 ได้”. No credentials, publishing, upload, push or notarization were used. Local commit only.

## Scope

Derived app icon from `docs/logo/icon-logo.png` with alpha/padding QA; package hygiene (Info.plist usage strings, Electron device strings removed, Windows Pageant helper removed, xattrs stripped, `__MACOSX` removed); generated third-party notices plus Electron/Chromium licences; ad-hoc signature with stable identifier `dev.ssterm.desktop`; fixed data folder `appData/ssterm`; About panel; `release:local` (zip, SHA-256, manifest bound to the packaged commit); packaged artifact review and upgrade fixture; release guide and notes. Details: [release guide](../release/README.md), [0.1.0 notes](../release/0.1.0.md).

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | PASS |
| `npm test` | PASS, 422/422 |
| `npm run test:e2e` | PASS, 62/62 |
| `npm run package:mac` / `npm run test:packaged` | PASS; 63/63 (adds `package-artifact.spec.ts` ×3, `upgrade.spec.ts`) |
| `npm run release:local` | refuses a dirty/mismatched package; trial archive verified (checksum, no `__MACOSX`, extracted bundle passes `codesign --verify --deep --strict`); clean archive rebuilt after the commit |
| Icon QA | transparent corners; padding 10.8–12.7 % at every size; 32 px legible; 16 px not legible (limitation) |
| Independent REVIEW | no critical/high. Fixed: data folder now explicit (was derived from productName), TCC/Keychain cdhash binding documented, macOS 15 Open Anyway, manifest bound to the packaged commit with dirty refusal, upgrade-test Keychain cleanup, counts, native crate licence statement, xattr/`__MACOSX` stripping, DS06 marked partial. Recorded: cross-build Keychain prompt unverified |
| Keychain hygiene | a first upgrade-test design (dev-created items read by the packaged build) left 2 test items because of the signature-bound ACL; they were deleted with `security delete-generic-password` and the test was redesigned; 0 `dev.ssterm.test` items remain |
| `git diff --check` | PASS |

## Not done / limitations

- Developer ID signing and notarization (no credentials; separate gate). Ad-hoc grants (Keychain, folders) can prompt again after each rebuild.
- Manual: real menu ⌘C/⌘A, VoiceOver, TCC prompt from Finder, Thai IME, Dock/Finder icon review.
- 16 px icon needs an adapted variant; brand lockup not in About; wordmark font unverified.
- Tested on one macOS 15.7 arm64 machine with fresh profiles; no clean VM or other macOS versions.

## Rollback

Packaging scripts, build manifest plugin, About/userData lines, tests and docs; revert the commit. The explicit `appData/ssterm` folder equals the previous default on case-insensitive disks.
