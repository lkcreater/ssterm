# SST-039 delivery record — local app lock

**Status: delivery gates complete.** Authorized by “เริ่มงานตาม plan”. Local commit only.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | PASS |
| `npm test` | PASS, 431/431 (adds `app-lock.test.ts` ×9) |
| `npm run test:e2e` | PASS, 64/64 (adds `app-lock.spec.ts` ×2) |
| `npm run package:mac` / `npm run test:packaged` | PASS; 65/65 (fuses verified) |
| Independent security REVIEW | no critical; two highs: Keychain-record deletion reset (fixed with the profile marker + recovery path) and the offline grace needing no secret (the user's chosen design; documented as accepted risk, stricter option offered). Mediums fixed: fuses (RunAsNode, NODE_OPTIONS off, archive-only with integrity), unreadable-record retry. Lows fixed: fixed scrypt parameters, read-back after uncertain writes, `azp`/`email_verified`, Host check, port-consistent redirect, clearing passwords on failure |
| Hygiene | 0 test Keychain items, 0 fixture containers after the runs; no client secret in the repository |

During the work, disabling the `GrantFileProtocolExtraPrivileges` fuse stopped the packaged renderer from loading (file:// in the archive); it was left at its default. An interrupted packaged run left one Docker fixture container, removed before the final run.

## Rollback

Revert the commit: the gate and screens go; the Keychain record and `app-lock.json` become inert. No schema change.
