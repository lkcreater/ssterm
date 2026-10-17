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
