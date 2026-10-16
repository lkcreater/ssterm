# SST-010 delivery — saved-host SSH authentication

**Scope:** SST-010/T016 DONE through independent TEST/REVIEW/DELIVER. The subsequent user instruction “commit” authorizes this SST-010 delivery commit only. No push, PR, merge, deployment or SST-011+ implementation is authorized.

## Delivered behavior

The desktop main process now composes saved-host sessions through the production ssh2 adapter, shared known-host policy, saved catalog resolver, session registry, and approved Keychain secret provider. Connect and reconnect capture the current inherited host and identity configuration. Known-host verification happens before credential reads. Password authentication and an explicit imported-key allowlist are supported: single-key OpenSSH Ed25519 and traditional PEM RSA PKCS#1, each plain or passphrase-encrypted. Key metadata is checked against the parsed key. Failures use finite sanitized codes; authentication does not fall back to another credential method. Interactive shell channels are owned and disposed with the session, with output held paused until terminal-stream delivery is implemented.

Credential buffers and late provider results are cleared on disposal where owned by ssterm; transport, channel, abort and generation ownership handle cancellation and stale completions. A paused channel can delay its close event, so final drain waits on the owned client socket close as well. No schema migration or dependency version change is needed. The renderer and preload gain no connect or credential capability.

## Acceptance and boundaries

The scope covers password and supported imported-key authentication for a saved host, shared host verification before credentials, inherited identity resolution, fresh configuration on reconnect, sanitized authentication failures, and cancellation-safe session ownership. The owned Electron fixture exercises those paths through the shipped production composition in development and packaged apps.

Missing-credential/passphrase retry prompts and keyboard-interactive remain SST-011. Terminal output/input, resize, Thai/IME and clipboard remain SST-012/013; the successful shell intentionally remains paused until ordered terminal delivery exists. Host/identity UI remains SST-016/017. PPK, PKCS#8, SEC1/ECDSA, DSA, certificates and multi-key files are unsupported. This service work does not yet provide a usable terminal workspace.

## Verification evidence

On macOS arm64 with Node 24.11.1, Electron 44.7.2 and Docker 28.5.2:

- Independent tester: `npm run typecheck` passed; `npm test` passed **141/141**.
- Root verification: `npm run build` and `npm run package:mac` passed.
- Development E2E passed **18/18** and packaged E2E passed **15/15** against owned loopback SSH fixtures and fresh `dev.ssterm.test.<uuid>` Keychain namespaces. Independent inspection decoded both receipts and confirmed the production SSH entry and ssh2 dependency are present in the ASAR while fixture helpers and keys are excluded.
- Runtime assertions cover saved password and supported key formats, inherited identity, trust rejection before secret reads, key rotation and explicit replacement, wrong credentials, fresh SecretRef on reconnect, sanitized events, buffer wiping, lock cleanup, and zero remaining test namespace items.

The reviewer found one Medium fixture-cleanup robustness issue and one Low execution-plan filename mismatch; both are fixed, and independent re-review passed with no unresolved findings above low. Root then reran the full development suite (**18/18**) and packaged suite (**15/15**) after the fixture-only cleanup fix. The production source/package was unchanged. Initial sandbox denial of loopback/Keychain access was resolved by running the owned checks with host access. Final source/document whitespace, local-link, JSON and status checks passed; see the [execution record](implementation-plan.md#final-sst-010-record--2026-10-16).

## Impact and rollback

This change affects the local desktop's saved-host SSH authentication path. It adds no migration and does not alter persisted catalog, secret, or known-host records. There is no deployment or release impact in this delivery; the macOS package is an unsigned verification artifact only.

To roll back, remove the production adapter injection and restore the unavailable adapter, then dispose owned sessions before shutting down storage. No user data or secrets need deletion. Revert only SST-010-owned source changes if rollback is requested; retain user data and unrelated work.
