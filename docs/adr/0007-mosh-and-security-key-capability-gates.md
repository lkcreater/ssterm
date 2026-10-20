# ADR 0007 — Mosh and FIDO capability gates

- Date: 2026-10-20
- Status: Accepted for bounded investigation; production support is not enabled
- Scope: SST-038 / T044; [authorization](../agent-runs/implementation-plan.md#later-scope-authorization--sst-029-to-sst-038-2026-10-17)

## Context

ssterm currently implements SSH terminals through ssh2 and a separate local PTY adapter. Neither a Mosh transport nor FIDO signing is implemented. Static observations of another product's native symbols establish neither a callable public interface nor runtime capability. This decision uses public upstream documentation and independently owned lab fixtures; no proprietary native code is loaded.

The authorized choice is a Docker Mosh experiment and FIDO investigation/ADR only. Hardware PIN, touch and cancellation tests are deliberately deferred rather than inferred from OpenSSH support.

## Decision: Mosh

Investigate the upstream native client/server in an isolated Linux container. SSH authenticates and launches a server; subsequent terminal traffic uses UDP. This is upstream's documented architecture ([Mosh](https://mosh.org/)). The lab must verify its own bootstrap, temporary UDP loss and recovery rather than treating the upstream roaming claim as a local result.

Do not implement the protocol or cryptography independently, add a production transport, change SSH identity semantics, or bundle a binary in this ticket. A future adapter needs explicit ownership of bootstrap SSH, native client, transient session key, UDP reachability, PTY and remote server termination. Unknown/changed host keys must use the existing trust policy before bootstrap; no auto-accept or silent SSH fallback. The session key must remain transient and excluded from logs, receipts, IPC, recording and inherited local-shell environments. Upstream passes it to the client in an environment variable; platform-specific process/environment exposure must be reviewed before packaging.

A future capability selector must distinguish Mosh terminal connectivity from SSH SFTP/tunnels. SSH jump hosts and TCP proxies do not by themselves route Mosh UDP. Do not advertise those combinations until tested. Existing reconnect means a fresh SSH session; a resumed Mosh session needs a separate explicit lifecycle contract, without replaying commands.

Production gates include macOS arm64 native distribution and signing, exact binary/dependency/license inventory (including upstream [COPYING](https://github.com/mobile-shell/mosh/blob/master/COPYING)), approved redistribution approach, app lock/quit/crash cleanup, bounded IO/backpressure, UTF-8/IME and terminal rendering, honest prediction/stale-state presentation, cancellation and remote resource leaks. Linux lab results cannot satisfy these gates. Native packaging and UI integration require their own authorized implementation scope.

## Decision: FIDO SSH identities

Keep current identity methods unchanged. Do not treat a security-key handle as an ordinary exportable private key or claim ssh2 supports it. Evaluate a future provider behind the existing main-only authentication boundary; compare native OpenSSH agent/provider delegation and a maintained native signing adapter before choosing. An agent option needs socket ownership, identity selection and agent policy tests; its mere availability is not authorization to sign with arbitrary user identities.

OpenSSH documents `ecdsa-sk` / `ed25519-sk`, resident credentials, user-presence and verification requirements ([ssh-keygen](https://man.openbsd.org/ssh-keygen.1)). It also documents security-key provider configuration ([ssh_config](https://man.openbsd.org/ssh_config.5)). These are upstream capabilities, not tested ssterm capabilities. FIDO SSH and WebAuthn/Google app unlock are distinct operations; this ticket does not add a login mechanism.

A future implementation must keep PINs transient, redact provider errors, require explicit identity/target selection, preserve host trust before signing and honor authenticator/server touch and verification requirements. Never weaken a required policy to obtain success. Bound one prompt/sign operation, serialize device access, and invalidate late signatures on cancellation, disconnect, lock or generation change. A non-exportable hardware secret does not imply the handle, agent access or an already-open session is harmless. Losing a device needs an independent administrative recovery path; no export/recovery guarantee is made here.

## Required hardware matrix — all untested

| Scenario | Future gate |
|---|---|
| No device / unplug before or during sign | Finite error, no retry loop or retained prompt |
| Touch required / denied / timeout | Correct target shown; explicit cancellation and bounded wait |
| PIN required / incorrect / retry exhaustion | Transient prompt; finite failure; no PIN logging or automatic guesses |
| User verification required | Policy enforced; no fallback that weakens verification |
| Resident / nonresident / multiple credentials | Explicit identity selection and metadata/handle lifecycle |
| Cancel / lock / disconnect / app quit | Late result fenced, native operation cleaned up or honestly reported |
| Changed host key | Signing blocked until deliberate trust replacement |
| Key loss / revoked key / existing sessions | Recovery and revocation limits documented and tested |

## Consequences and evidence

No schema, dependency, IPC, UI, account or app-lock behavior changes. SST-035 can proceed independently of enabling either transport. See [capability report](../spikes/mosh-fido-capabilities.md) for actual runtime evidence and gaps. Revert the isolated fixture/docs commit to roll back this ticket; no user-data migration is involved.
