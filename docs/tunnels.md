# Local tunnels — SST-025

**2026-10-17 · T031 · DONE through independent TEST/REVIEW/DELIVER.** Main-only local port forwarding over saved hosts. Proposed ssterm behavior, independently implemented. See [ticket](termius/tickets.md#sst-025--local-tunnel-service), [execution plan](agent-runs/implementation-plan.md#sst-025-execution-plan--2026-10-17) and [delivery](agent-runs/sst-025-delivery.md). The rule editor, status UI and IPC are SST-026.

## Behavior

- **Rules** are the existing `TunnelRule` rows: `local` only, bind `127.0.0.1` (default) or `::1`, ports 1–65535, destination resolved by the SSH server. Saving a rule never starts it; nothing persists running state and nothing starts tunnels at launch.
- **Start** (`TunnelService.start(owner, ruleId)`) captures the rule, refuses one already active, **binds first** (a collision fails before any SSH work), then opens a `tunnel` session in the shared registry (same host-key policy, credentials, prompts, keepalive, lock, 32-session cap, generation fence `registry.tunnel`). State `starting` → `running` only when bound and the session is Ready. Local connections before `running` are closed and counted.
- **Bind errors** are typed: `address-in-use`, `permission-denied`, `address-unavailable`, `bind-failed`. Before binding, a connect probe detects a port already served on loopback — macOS would otherwise let a loopback bind shadow a wildcard (`0.0.0.0`/`::`) listener such as a Docker-published port. ssterm never binds a wildcard address.
- **Forwarding**: each accepted socket opens its own `direct-tcpip` channel (at most 16 opening, 64 streams per session, 64 connections per tunnel); `pipe` provides backpressure; half-close is kept like OpenSSH `-L`. A destination the server refuses closes that local connection only (`failedConnections`). Counters only; no peer addresses or payload are kept or logged.
- **Stop / failure / lock / quit / owner revocation** close the listener first, then every local socket and forwarded stream, then close and forget the session. Transport loss, keepalive timeout, auth failure and lock fail the tunnel with the session's code (`network`, `timeout`, `locked`, …). A failed tunnel can be restarted after its teardown finished; a stale teardown never reports over its successor. Quit destroys listeners synchronously and bounds the drain at 2 s alongside the session shutdown.

## Verification

Unit (`tests/unit/tunnels.test.ts`): exclusive loopback bind, collision and wildcard-occupant detection, half-close, close frees the port; channel bounds and late replies; service start/running/stop with a held connection, early refusals, refused destination, failure/lock teardown, cap, owner revocation, dispose, stop during bind, restart after failure. Runtime (`tests/e2e/tunnel.spec.ts`, development and packaged) through the shipped `out/main/ssh.js` on the Docker OpenSSH fixture (`PermitOpen 127.0.0.1:8080`): no listener after save; HTTP 200 with the fixture body; collision `address-in-use` with no extra session; refused destination; stop with an open connection; lock → `failed/locked`; start while locked refused; dispose; `docker stop` → `failed/network` and no listener.

## Limitations

- No UI or IPC yet (SST-026); editing or deleting a rule while its tunnel runs is not yet refused (`TunnelService.active(ruleId)` exists for that).
- The loopback probe and the bind are not atomic; a listener appearing in between can still be shadowed on macOS.
- More than 16 simultaneous new connections are refused, not queued.
- If the registry observer budget were exhausted, a tunnel would stay `starting` until stopped.
- The owner is a window: closing or reloading it stops its tunnels.

# Tunnel rules and status UI — SST-026

**2026-10-17 · T032 · DONE through independent TEST/REVIEW/DELIVER.** [Delivery](agent-runs/sst-026-delivery.md). Adds rule CRUD through the catalog, owner-bound tunnel IPC and the **Port forwarding** page.

## Behavior

- **Rules** are catalog intents (`create/update/delete-tunnel-rule`) with preview/apply and revision fences, projected in `CatalogState.tunnelRules`. Main validates name, ports (1–65535), the destination (normalized like any endpoint) and the server; problems are field errors. Duplicate local ports may be saved; the second start fails `address-in-use`.
- **Page**: each row shows name, `local → destination via server` with PROD, and a status with icon and text: Stopped, Starting, Running · N connections, Stopping, Failed with a fixed reason. Failed never reads as running; Start retries. The editor explains that the destination is resolved and connected by the SSH server, binds only to `127.0.0.1` or `::1`, and saving never starts anything.
- **Running rules**: main refuses editing or deleting a rule whose tunnel is starting, running or stopping, and deleting a server (or group subtree) with such rules, at prepare and again at apply. The editor (a right drawer since SST-040/06, titled per type: local, remote or SOCKS; Cancel on an edited rule shows a discard step) makes the restart explicit (“Save and restart”): a dry-run check first, then stop → save → start, with a clear message if the tunnel ends up stopped. Delete is an alert drawer (Cancel focused) and offers “Stop and delete”. Editing or deleting a failed rule clears its stale status first.
- **IPC**: `tunnelState`/`onTunnelState` (owner-sequenced, fixed error codes), `startTunnel` (the explicit action is the unlock), `stopTunnel` (idempotent). A stopped tunnel emits a final event so no row stays “Stopping”.
- **Restart**: rules persist; after relaunch every rule is Stopped and no listener exists.

## Verification

`tests/unit/tunnel-rules.test.ts` (intent guards, loopback default, field errors, normalization, running guards at prepare and apply, controller codes/unlock/idempotent stop, IPC fencing) and `tests/e2e/tunnels-ui.spec.ts` (F06 on Docker OpenSSH: create with validation, no listener after save, Start with host-key trust, HTTP 200, duplicate fails visibly, server delete refused while running, Save and restart, Stop closes the listener, contrast at 960×640, relaunch without autostart, delete). Full suite: 421 unit / 59 development / 56 packaged.

## Limitations

- When the catalog is truncated, a rule whose server is hidden shows “Missing server” and cannot be started from the page.
- The running guard is service-wide while status is per window; with one window this is the same.
- Editing a server while its tunnel runs is allowed; the tunnel keeps the settings it started with until restarted, and the server editor does not say so.

# Remote and dynamic (SOCKS5) forwarding — SST-031

**2026-10-17 · T039 · DONE through independent TEST/REVIEW/DELIVER.** [Execution plan](agent-runs/implementation-plan.md#sst-031-execution-plan--remote-and-dynamic-forwarding-2026-10-17), [delivery](agent-runs/sst-031-delivery.md). Proposed ssterm behavior, independently implemented. Same ownership, stop, lock, quit and owner-revocation contract as local rules above.

## Behavior

- **Rule types** (`type` column, schema 2): `local` (unchanged), `remote` and `dynamic`. Public bind addresses `0.0.0.0`/`::` and port `0` (server-assigned) are allowed **only** for `remote`, where the server listens; `local` and `dynamic` bind loopback on this Mac only. `dynamic` has no destination; `local`/`remote` require one. The same constraints are enforced by the DB CHECKs, the adapter validator, the contracts guard and main's per-field checks (which report every problem at once).
- **Remote** (`ssh -R`): no listener on this Mac. After the `tunnel` session is Ready, the service sends one `tcpip-forward`; the rule reads **Running only after the server confirms**, and the status carries the actual server port (`remotePort`, shown as “server port N”; `127.0.0.1:assigned` until then). Each server-side connection arrives over SSH and **this Mac** dials the saved destination (10 s dial timeout; failures counted). Only connections to listeners this session requested are accepted (ssh2 rejects others; `ssh.ts` rejects all for non-tunnel sessions). At most 4 server listeners per session (pending requests count). Stop/failure/dispose sends `cancel-tcpip-forward` best effort and destroys every stream.
- **Capability unavailable / refused** is explicit for remote rules: the server refusing the listener (port in use, `AllowTcpForwarding`, `PermitListen`, policy) fails the tunnel with `remote-bind-refused` and closes the session. No server text is shown. Requesting `0.0.0.0`/`::` shows “Public requested” and a warning in the editor; whether the server really listens publicly is its decision (`GatewayPorts`), which ssterm does not observe.
- **Dynamic** (`ssh -D`): a SOCKS5 server on the loopback bind. No authentication (method 0) and **CONNECT only** (BIND/UDP ASSOCIATE → reply 7); address types IPv4, domain and IPv6; domain names are passed to the SSH server unresolved (socks5h behaviour — this Mac does no DNS lookup); 10 s handshake timeout; an incomplete header is bounded at 600 bytes, while bytes sent after a complete request are kept for the stream. Success is replied only once the `direct-tcpip` stream exists and the tunnel is still running; a server refusal replies 5 (otherwise 1) and the connection is closed after the reply is flushed. Like local rules, a SOCKS rule whose server forbids forwarding stays Running and counts failed connections; the refusal is per connection, not per rule.
- **Storage migration**: schema 1 → 2 is the first real migration. On open, an older store gets a verified backup next to it (`catalog.sqlite.v1-<time>.backup` + manifest, kept for the user), then a single transaction rebuilds `tunnel_rule`; every v1 row is a valid local rule. The step leaves snippet ciphertext, secret refs, the vault key and the credential journal untouched, so protected vaults and stores with a pending journal (e.g. `needs-input`) upgrade and reconcile at runtime as before. A failed migration leaves the store unchanged and removes that attempt's backup. Older builds refuse a v2 store (`unsupported-schema`); restoring the backup is the way back.

## Verification

Unit: `tests/unit/tunnels.test.ts` (SOCKS5 parser incl. early data/limits/refusals; dynamic and remote service paths, assigned port, refusal, dial failure and timeout, same-tick connection; channel listeners, routing, cap, dispose), `tests/unit/tunnel-rules.test.ts` (per-type field errors, type changes), `tests/unit/storage.test.ts` (real schema-1 layout derived from the stored DDL: protected vault + encrypted snippet, pending journal, backup, reopen; failed-migration backup removal). Runtime on the Docker OpenSSH fixture (`AllowTcpForwarding yes`, `PermitOpen 127.0.0.1:8080`, `PermitListen 127.0.0.1:* localhost:*`, `GatewayPorts no`): `tunnel.spec.ts` — SOCKS IPv4/domain HTTP 200, refused CONNECT reply 5, remote assigned port reached from inside the container, listener gone after stop, port 22 → `remote-bind-refused`, a `0.0.0.0` request refused by `PermitListen`; `tunnels-ui.spec.ts` — SOCKS and remote rules created in the editor (public warning, usage text), real traffic, type-change validation; packaged `upgrade.spec.ts` — a schema-1 store migrates in the packaged build with one backup.

## Limitations

- SOCKS5 has no authentication: any local process on this Mac can use a running proxy (same exposure as a loopback local forward). No SOCKS4/4a, BIND or UDP.
- The bound address actually chosen by the server for a public request is not reported by SSH; only the port is.
- A remote rule that reaches `remote-bind-refused` because the port is briefly in use is not retried automatically.
- The fixture image was rebuilt here by layering the new `sshd_config` on the existing `m0` image (no package download); a clean `docker build tests/fixtures/ssh` produces the same configuration.
