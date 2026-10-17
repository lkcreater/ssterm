# SST-031 delivery record — remote and dynamic forwarding

**Status: delivery gates complete.** Authorized by “ทำงาน SST-029 - SST-038 ให้จบ” (first ticket of that range). Local commit only. Behavior: [tunnels](../tunnels.md#remote-and-dynamic-socks5-forwarding--sst-031); plan: [implementation plan](implementation-plan.md#sst-031-execution-plan--remote-and-dynamic-forwarding-2026-10-17).

## Scope delivered (T039)

- Schema 2 (first real migration, backup first, protected vaults and pending journals preserved): `tunnel_rule.type` local/remote/dynamic, per-type bind/destination constraints.
- Remote forwarding via `tcpip-forward` with the server-assigned port surfaced; typed `remote-bind-refused`; this Mac dials the destination (10 s timeout).
- Dynamic forwarding: loopback SOCKS5 (no auth, CONNECT, IPv4/domain/IPv6, socks5h) with bounded handshake.
- Contracts, main per-field checks, and the Port forwarding editor/list (type selector, public-request warning, SOCKS usage text, assigned port).
- Fixture: `AllowTcpForwarding yes`, `PermitListen 127.0.0.1:* localhost:*` (local forwarding still limited by `PermitOpen 127.0.0.1:8080`).

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | PASS |
| `npm test` | PASS, 440/440 (was 431; adds SOCKS5, remote/dynamic service, channel listener, migration and per-type rule tests) |
| `npm run test:e2e` | PASS, 64/64 (61 desktop + 3 showcase); `tunnel.spec.ts` and `tunnels-ui.spec.ts` extended with SOCKS/remote on Docker OpenSSH; `storage.spec.ts` expects schema 2 |
| `npm run package:mac` / `npm run test:packaged` | PASS, 65/65; `upgrade.spec.ts` now migrates a schema-1 store in the packaged build and checks the single backup |
| `git diff --check` | PASS |
| Independent REVIEW | no critical. High H1 (a store with a pending credential journal could not open after the upgrade) fixed with journal-preserving steps and a tolerant pre-migration backup, plus a unit test. Mediums fixed: handle closed on migration failure; rejection handling on the forward path; the v1 test layout now derives from the stored DDL. Lows fixed: same-tick remote connections, single listen request, port-0 confirmations, pending-listen cap, dead transport ≠ refusal, dial timeout, SOCKS early-data bound, SOCKS reply ordering/flush, failed-migration backup pile-up, softened “Public requested” wording, duplicate field error, misplaced doc comment. Documented rather than changed: SOCKS rules report forwarding refusals per connection, not per rule. |
| Hygiene | 0 test Keychain items and 0 fixture containers after the runs |

The reviewer's sandbox saw `listener: exclusive loopback bind…` fail and the unit process hang. That test was not changed by this ticket and passes locally in every run here (16/16 in `tunnels.test.ts`, 440/440 overall). The fixture image could not be rebuilt from scratch (no network for `apt-get`), so `ssterm-ssh-fixture:m0` was rebuilt by layering the new `sshd_config` on the existing image.

## Rollback

Revert the commit. A store already migrated to schema 2 is refused by older builds (`unsupported-schema`); restore `catalog.sqlite.v1-<time>.backup` (kept next to the store) to go back. Reverting `tests/fixtures/ssh/sshd_config` and rebuilding the image restores the local-only fixture.
