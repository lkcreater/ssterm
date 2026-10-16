# SST-013 delivery — terminal input, Unicode and clipboard

**Scope:** SST-013/T019 DONE through independent TEST/REVIEW/DELIVER, authorized by the standing instruction “ทำงานนี้เสร็จ commit -> ทำงานถัดไปต่อได้เลย -> loop จนจบ” after SST-012 `dba21d4`. That instruction authorizes this local commit and the next ticket; no push, PR, merge or deployment.

## Delivered behavior

Typing, Thai input, IME composition and Unicode 11 widths work in the focused pane, with the IUTF8 PTY mode so the remote erases whole characters. Copy and paste use the macOS Edit menu; paste is sanitized against control-sequence injection, refused over 256 KiB and confirmed (target, PROD, line count, preview) for risky multiline pastes, never adding Enter. Links open only on Cmd+click through a validated main-process handler with a native confirmation. Cmd+F searches the focused pane without sending input. An explicit menu removes reload and DevTools from packaged builds.

## Acceptance and boundaries

Acceptance covered: Thai/UTF-8/combining/wide/IME, copy and multiline paste with active-target feedback and bracketed paste, shortcuts/focus/search routed only to the focused pane, explicit clipboard and URL actions. Three renderer addons are pinned exactly ([ADR 0001 outcome](../adr/0001-mvp-platform-stack.md#sst-013-terminal-input-outcome--2026-10-16)). Physical layouts/IME, dictation and real menu clipboard remain a manual matrix. Snippet Paste/Run is SST-024, large-paste throughput SST-014, settings and pane navigation SST-018.

## Verification evidence

- Final source: typecheck PASS; unit **190/190**; build PASS; development E2E **21/21**; unsigned macOS arm64 package PASS; packaged E2E **18/18**.
- Independent tester: same suites on the pre-fix source (187/21/18), input spec 3× repeated, packaged runtime menu inspection and shipped link-confirmation probe.
- Independent review: no critical/high/medium; all lows and nits fixed before the final suites. A spec helper race (row spans replaced during link hover) was fixed by polling for a layout box; 6/6 repeats passed.

See [detailed evidence](../terminal-input.md) and [execution record](implementation-plan.md#final-sst-013-record--2026-10-16).

## Impact and rollback

Adds a native menu, one link IPC and renderer input policy; no schema or persistent data change. Roll back by removing the menu, link handler, input policy, addon pins and IUTF8 mode.
