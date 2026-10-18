# SST-030 delivery record — jump host / multi-hop / proxy

**Status: delivery gates complete — 2026-10-18.** Authorized by “ทำงาน SST-029 - SST-038 ให้จบ” and “ทำต่อให้เสร็จ”. Local commit only. Scope is the per-hop authenticated transport chain, HTTP CONNECT/SOCKS5 proxy capability, catalog editor, migration, and fixture-based verification described in the [SST-030 plan](implementation-plan.md#sst-030-execution-plan--jump-host--multi-hop--proxy-2026-10-17). Behavior and limitations are documented in [jump hosts and proxies](../jump-hosts.md).

## Delivered scope

- Saved hosts can use up to three chained jump hosts (four SSH endpoints including target), or an HTTP CONNECT/SOCKS5 proxy without proxy authentication.
- Each SSH hop uses its own effective identity and credentials, and independently follows the shared known-host trust policy. Prompt labels identify the hop and final target context.
- Downstream names in a jump chain are resolved by the current jump server. SOCKS5 names are sent unresolved for proxy-side DNS; direct connections resolve locally.
- Cycle/depth validation, jump-host in-use delete protection, typed failure mapping, cancellation/resource cleanup, host editor controls, and schema 2 → 3 migration are included.
- Migration adds nullable host route fields, preserving existing direct routes. Schema-2 backup is required for rollback because older builds refuse schema 3.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | PASS; final run after review fixes |
| `npm test` | PASS, 451/451 after review fixes (baseline 440) |
| `npm run test:e2e -- jump-hosts.spec.ts jump-hosts-ui.spec.ts` | PASS, 2/2; updated Jump UI rerun PASS, 1/1 at 960×640 with reduced motion, focus, overflow and contrast assertions |
| `npm run test:e2e` | PASS, 66/66; after the validation-text contrast fix, affected `catalog-ui.spec.ts` + `release-gate.spec.ts` rerun PASS, 8/8 |
| `npm run build` | PASS, including after the contrast fix |
| `npm run package:mac` | PASS, ad-hoc signed macOS arm64 / Electron 44.7.2 |
| `npm run test:packaged` | PASS, 67/67 on final source, including the new minimum-window assertions, upgrade, icon/signature/content checks |
| `git diff --check` | PASS |
| Independent review | PASS; no remaining material findings. Fixed HTTP header-size and SOCKS reply checks, explicit proxy-column non-NULL constraints, and downstream depth validation after upstream edits; regression tests added. Follow-up review also checked screenshot privacy, SSH hop cleanup/credential routing, and the derived validation-text token. |

Coverage present in the repository includes unit-level integration tests for HTTP CONNECT and SOCKS5 clients against test-owned proxies, plus a Docker/OpenSSH E2E for one- and two-jump chains. There is no proxy Docker E2E. See the verification coverage section in [jump-hosts.md](../jump-hosts.md) for scenarios and limits.

The additional rendered check found existing `destructive` text at 4.33:1 against the popover form surface. Invalid field labels and errors now use `destructive-text` (`#EE8686`); the state/fill token remains unchanged. The original assertion failed once; after the correction the Jump UI contrast/focus/overflow assertions and eight affected catalog/release checks passed. Test screenshots are captured before credential entry; automatic credential traces/screenshots/video remain disabled.

Visual review: macOS arm64, packaged Electron 44.7.2, CSS viewport 960×640, Retina screenshots 1920×1280, reduced motion. The jump editor's focused invalid selector/error and scrollable form/footer, and the bastion trust dialog's target context, Thai label and endpoint are legible. Safe evidence is kept under ignored `artifacts/sst030/screenshots/`.

## Acceptance status and remaining limits

SST-030/T038 acceptance is complete through independent TEST/REVIEW/DELIVER. Proxy authentication is unsupported; proxy and jump routing are mutually exclusive on a single host, though the outermost jump host can use a proxy. Maximum depth is three jump hosts. Proxy protocol integration uses owned loopback servers rather than Docker. Native Thai IME/VoiceOver/menu/TCC release checks and Developer ID signing/notarization remain separate pending gates.

Evidence logs and JSON reports are kept in ignored `artifacts/sst030/`. The first sandbox-only unit attempt could not bind loopback or access test Keychain items; the authorized host-fixture run passed all 451 tests. The build emits existing Rollup/Zod warnings. Packager warns about the optional `.icon` format; the generated `.icns` was verified by the packaged artifact checksum test. No lint script exists. Test teardown verified empty test Keychain namespaces (the jump receipt explicitly reports zero leftover items), and the final filtered Docker query found no fixture containers.

## Rollback and deployment impact

This change is local application behavior and schema metadata; it does not publish or deploy anything. A migrated schema-3 catalog cannot be opened by an older build. To roll back the app and data together, close ssterm, preserve the current catalog, restore the verified `catalog.sqlite.v2-*.backup`, and start the older build. Reverting the code without restoring schema 2 leaves the old build unable to open the catalog.
