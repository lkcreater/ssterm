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
- **Running rules**: main refuses editing or deleting a rule whose tunnel is starting, running or stopping, and deleting a server (or group subtree) with such rules, at prepare and again at apply. The editor makes the restart explicit (“Save and restart”): a dry-run check first, then stop → save → start, with a clear message if the tunnel ends up stopped. Delete offers “Stop and delete”. Editing or deleting a failed rule clears its stale status first.
- **IPC**: `tunnelState`/`onTunnelState` (owner-sequenced, fixed error codes), `startTunnel` (the explicit action is the unlock), `stopTunnel` (idempotent). A stopped tunnel emits a final event so no row stays “Stopping”.
- **Restart**: rules persist; after relaunch every rule is Stopped and no listener exists.

## Verification

`tests/unit/tunnel-rules.test.ts` (intent guards, loopback default, field errors, normalization, running guards at prepare and apply, controller codes/unlock/idempotent stop, IPC fencing) and `tests/e2e/tunnels-ui.spec.ts` (F06 on Docker OpenSSH: create with validation, no listener after save, Start with host-key trust, HTTP 200, duplicate fails visibly, server delete refused while running, Save and restart, Stop closes the listener, contrast at 960×640, relaunch without autostart, delete). Full suite: 421 unit / 59 development / 56 packaged.

## Limitations

- When the catalog is truncated, a rule whose server is hidden shows “Missing server” and cannot be started from the page.
- The running guard is service-wide while status is per window; with one window this is the same.
- Editing a server while its tunnel runs is allowed; the tunnel keeps the settings it started with until restarted, and the server editor does not say so.
