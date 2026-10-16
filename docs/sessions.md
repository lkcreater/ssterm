# SST-008 — Session lifecycle and resource ownership

**2026-10-15 · T013–T014 · DONE through implementation, independent TEST/REVIEW and DELIVERY; committed `bcbb693`.** Authorized by “commit และเริ่มงานถัดไป” after SST-007 commit `c124b1b`. Production trust and saved-host authentication are integrated by [SST-009](known-hosts.md) and [SST-010](ssh-auth.md); no renderer connection command is added by SST-008.

The verification counts below record SST-008 delivery. For current production transport/credential behavior and newer regression evidence, see [SSH authentication](ssh-auth.md).

## Interface and placement

[SessionRegistry](../packages/services/src/sessions.ts) is a main-only engine-independent Module. Its Interface owns configuration capture, lifecycle, prompt lifetimes, ownership and teardown:

- `connect(ownerId, hostId)` returns a new Connecting snapshot, then resolves configuration asynchronously. `reconnect(ownerId, id)` is explicit, requires Failed/Closed with finished teardown and captures current configuration with a new generation.
- `snapshot(ownerId, id?)` and `subscribe(ownerId, callback)` return fresh public metadata projections. An owner cannot inspect or mutate another owner's sessions. Root maps registered window ownership to `window:<windowId>:<windowGeneration>`; connection generation is separate.
- `answerPrompt(ownerId, id, generation, promptId, answer)` is one-shot and binds all identifiers. `cancel`/`close` synchronously fence callbacks and destroy resources before awaiting bounded drain. Repeated close is harmless; Failed/Closed records can be explicitly forgotten after teardown.
- `closeOwner`, `lock`, `unlock(checkAccess)` and `dispose` manage broader lifetimes. Main forgets disposed window records after drain so reloads do not consume retained slots forever.

The injected Adapter starts with a context containing the private captured config, AbortSignal and finite lifecycle/prompt/resource callbacks. It must synchronously register transport revocation with `own(resource)` before its first await. Every later capability acquisition goes through `own` or `ready`; stale resources are immediately disposed. Resource objects have one owner and dispose once; sharing an object cannot destroy another session's resource.

[Desktop composition](../apps/desktop/src/main/session-runtime.ts) is used by [main](../apps/desktop/src/main/index.ts) and fixtures. The main-only [sessions entry](../apps/desktop/src/main/sessions.ts) ships as `out/main/sessions.js`. The default Adapter fails with `subsystem-unavailable`; no fixture Adapter is packaged and no real saved-host connection is implied.

## States and events

Idle describes the unallocated state; `connect` allocates directly into Connecting. Valid progression is Connecting → VerifyingHost → Authenticating → Ready. Ready requires adoption of an interactive channel resource, not TCP connection or authentication alone. Credential prompts enter AwaitingInput and resume Authenticating; host-trust prompts stay VerifyingHost. Explicit trust rejection fences authentication with `host-key-untrusted`. Invalid phase changes reject.

Failure fences callbacks and retains a Failed record. Cancel/close from any active phase or Failed proceeds through Closing to Closed. Adapter end/EOF closes the attempt. Reconnect keeps the logical session ID, increments attempt generation, uses a fresh transport/config and has no input queue to replay. Late resolver, phase, prompt and capability completions cannot revive the old attempt.

Snapshots/events explicitly construct ID/generation, host ID, state, cleanup status, optional target metadata, prompt metadata and fixed error code/message. The target contains label/address/port/username/environment and host/catalog revisions. Full config/provenance, auth references, secret values and raw adapter errors never cross this public Interface. The private config is independently cloned and frozen; catalog edits cannot retarget it.

Finite errors cover invalid request/state/config, missing ownership, locked/disposed, host-key trust/change, auth denial, prompt cancellation, timeout, DNS/network, channel/subsystem failure and resource limits. Unknown thrown/rejected Adapter failures map to `subsystem-unavailable`. Error stacks, messages and attached upstream fields are not forwarded.

## Prompts, bounds and cleanup

Trust prompts allow known algorithm names and SHA256 fingerprints; decisions are accept-once/remember/reject. This Module transports decisions, while persistent trust policy/transactional remembering remains SST-009. Credential prompts use finite field IDs/echo flags, no arbitrary upstream instruction text, and at most eight fields. Each generation has one active prompt.

Credential answers are copied into owned `TransientSecrets`; a synchronous `use` callback consumes views, then overwrites/disposes them even if the consumer throws. Unconsumed answers expire and are purged on teardown/lock. Input buffer lifetime remains the caller's responsibility; garbage-collected memory zeroization is best effort.

Default limits: 32 retained sessions, 32 resources per attempt, 128 observers, 60-second prompt timeout, 120-second connection timeout and two-second drain timeout. Credential input is bounded to 16 KiB per field/64 KiB total. Constructor limits can reduce caps, with bounded deadline increases for fixtures. An injected scheduler tests deadlines deterministically.

Resource `dispose()` must synchronously revoke usability and initiate destruction. Optional `drained` promises represent final engine cleanup. Teardown catches thrown/rejected cleanup and reports `complete`, `failed` or `timeout`; it never waits indefinitely or reactivates callbacks. A completed wait alone does not prove successful cleanup: inspect its cleanup status. Terminal byte flow/backpressure, SFTP and tunnel capabilities remain later tickets.

## Desktop lock, window and quit integration

Window navigation rotates IPC ownership and revokes old sessions; renderer destruction and boundary shutdown revoke the corresponding owner. Lock-screen/suspend immediately latch session actions, fence every attempt before external abort/destructor callbacks, cancel prompts/resources and purge transient values. OS unlock does not resume actions. Explicit main-side unlock needs a successful access check whose epoch remains current and never reconnects/replays work.

Quit rejects new lifecycle work, revokes window ownership and awaits bounded session disposal before closing storage. Power listeners are removed during shutdown. There is no unlock UI/IPC yet, no physical-lock walkthrough claim, and no new SecretService provider/reconciliation cancellation policy. Existing [secret-storage limitations](secret-storage.md#known-limitations), verified-restore and later full app-lock/action integration remain applicable.

## Verification

Typecheck and full unit suite **106/106 PASS**: 21 focused registry tests, four desktop composition tests and the added boundary-revocation regression alongside existing catalog/storage/secrets/IPC checks. [Registry tests](../tests/unit/sessions.test.ts) cover delayed callbacks/config, cancellation in every active phase, stale prompts/generations, strict phases/trust rejection, zeroization, fresh reconnect, duplicate ownership/caps, cleanup failures/timeouts, reentrant observers, unlock epochs, ignored stale prompt rejections under strict Node policy and Closed notifications after completed failure cleanup.

[Runtime tests](../tests/e2e/sessions.spec.ts) load the shipped production entry. One uses owned SQLite config and emitted Electron power events to check capture/reconnect/lock/owner/listener behavior. The other invokes a [test-only SSH Adapter](../tests/fixtures/sessions/ssh.cjs) around the selected isolated spike through the new registry, opening a real interactive channel on the generated loopback Docker fixture, explicitly accepting fixture trust and checking close/cancel/reconnect/cleanup with no secret-bearing receipt.

Runtime suite prerequisites now include the running Docker daemon, owned `ssterm-ssh-fixture:m0` image (`docker build -t ssterm-ssh-fixture:m0 tests/fixtures/ssh`) and the isolated spike's locked dependencies (`npm ci --omit=optional --ignore-scripts` from `spikes/ssh-compat`). Root workspace installation alone does not install that isolated test dependency. Missing prerequisites fail the smoke instead of silently skipping it; packaging itself does not need or include them.

The Node real-fixture smoke, development E2E **15/15** and packaged E2E **12/12** passed on final source; no skipped/flaky/unexpected results. Independent TEST repeated typecheck and 33 session/runtime/boundary checks and decoded both reports. ASAR inspection confirmed the production entry and excluded test helpers. Independent REVIEW found no actionable findings; [delivery](agent-runs/sst-008-delivery.md) and the [execution record](agent-runs/implementation-plan.md#sst-008-execution-plan--2026-10-15) close all gates. Existing real Keychain regression fixtures retain isolated `dev.ssterm.test.*` namespaces; new SSH fixtures use no user/production/Termius systems. Schema, dependencies, renderer and preload methods are unchanged. No SST-008 commit/push/deployment is authorized.

[SST-011](auth-prompts.md) extends credential prompt metadata with optional finite purpose/attempt values and adds `cancelPrompt(ownerId,id,generation,promptId)`: only the matching live credential prompt can fail its attempt with `prompt-cancelled`. Main projects no answer bytes; transient one-use answers and timeout/ownership semantics remain unchanged.
