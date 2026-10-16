# SST-011 delivery — transient authentication prompts

**Scope:** SST-011/T017 DONE through independent TEST/REVIEW/DELIVER, authorized by “ทำงานถัดไปเลย” after SST-010 `76d473f`. The subsequent user instruction “commit” authorizes this SST-011 delivery commit only. No push, PR, merge, deployment or SST-012+ implementation is authorized.

## Delivered behavior

Saved-host authentication can request a transient password, or a private-key passphrase with up to three entered decrypt attempts. A saved bad password retains its single selected auth attempt. Explicitly selected keyboard-interactive authentication accepts up to three nonempty challenge rounds, eight fields per round, and 64 KiB total, while preserving each field's echo flag. Empty informational rounds create no prompt. Generic `Response N` labels avoid exposing raw server instructions or questions.

Each prompt is bound to its owner, session, connection generation, and exact prompt ID. Submit, cancel, timeout, lock, owner removal, and shutdown fence stale responses. The main-process controller and validated preload bridge carry only prompt metadata and transient answers. The UI uses uncontrolled inputs and clears their values on submit, cancel, prompt change, and unmount. Answers are not persisted or cached across attempts or sessions. Owned scratch buffers and late provider/answer results are wiped where possible; immutable UTF-8 copies required at the ssh2 protocol boundary mean complete JavaScript/crypto-memory zeroization cannot be guaranteed. The native Keychain binding remains behind guarded lazy loading so importing SSH composition cannot crash startup when that binding is unavailable.

## Acceptance and boundaries

The implementation adds owner- and generation-fenced prompt handling to the saved-host authentication flow, including passphrase retries, selected keyboard-interactive challenges, cancellation and timeout cleanup, secret-free public prompt state, and a transient target-visible UI. It retains SST-010's shared host verification and captured identity behavior. No schema or dependency version change is required.

Keyboard-interactive fields use generic labels, so users must understand their challenge order. Physical IME behavior still needs manual confirmation. Terminal byte delivery and resize remain SST-012; terminal input, Thai/IME and clipboard remain SST-013. This ticket does not add terminal streaming or host-management UI.

## Verification evidence

- Independent typecheck and unit **157/157** passed; final whitespace checks passed.
- Root build, unsigned macOS arm64 package, full development E2E **19/19**, and packaged E2E **16/16** passed on final source, zero skipped/unexpected/flaky.
- Runtime receipts show no plaintext credentials in metadata/public events, no persisted passphrase, zero test-Keychain leftovers and cleaned fixtures. Tests use real OpenSSH password/encrypted-key auth plus loopback multi-round keyboard challenges through the shipped client and actual UI.
- Empty-input screenshots were inspected at 1280×800 and 960×640 reduced motion; target/PROD/focus/actions remain visible. Measured normal text contrast is at least **4.82:1**. Credential test trace/video are absent. Physical Thai IME remains unverified; synthetic composition Enter passes.
- The first full runtime run caught a fixture dialog-transition race; corrected live-prompt matching passed the final full suites. Review's two Low findings (UTF-8 byte validation and zero-round wording) are fixed; independent re-review found no new actionable findings. UTF-8 over-limit input is rejected locally, cleared and never silently truncated.
- Production SSH composition imports successfully with native Keychain loading deliberately blocked; its native binding remains in guarded lazy initialization. Packaged fixtures/tests/spikes are excluded.

See [detailed evidence](../auth-prompts.md) and [execution record](implementation-plan.md#final-sst-011-record--2026-10-16). No schema or dependency pins changed.

## Impact and rollback

The change adds a transient credential prompt flow to the local desktop. It adds no database migration, persistent credential record, or dependency version change. The macOS package is a local unsigned verification artifact; nothing has been published or deployed.

To roll back, dispose pending prompts and sessions, remove the credential controller/bridge/UI composition, and restore SST-010's credentials-required behavior. Catalog, known-host data, and OS-secret records need no deletion or migration. Revert only SST-011-owned changes if rollback is requested; preserve user data and unrelated work.
