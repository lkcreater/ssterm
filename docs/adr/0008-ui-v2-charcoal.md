# ADR 0008 — UI v2 Charcoal

- Date: 2026-10-22
- Status: Accepted (SST-040, [authorization and decisions](../agent-runs/implementation-plan.md#sst-040-authorization--ui-v2-charcoal-2026-10-22))
- Supersedes: the navy Signal Blue surfaces in [design-system.md](../termius/design-system.md) and the SST-004 contrast rule for the roles listed below

## Context

The user supplied a Charcoal v2 direction, logo/icon v2 and 42 UI concept PNGs ([handoff](../logo/ui-v2/README.md)) and asked to revise the whole UI. The PNGs are generated concepts; the handoff's visual and drawer contracts plus existing behavior govern.

## Decision

- **Tokens:** canvas `#1E1E1E`, sidebar `#202020`, surface/drawer `#252525`, field `#292929`, line `#383838`, text `#F3F3F3`/`#A3A3A3`, primary `#2563EB` with white text; cyan `#00C8E8` stays inside the logo. Status green/amber/red are re-tuned for charcoal at ≥4.5:1.
- **Accepted contrast exception (user choice):** `#2563EB` is also the focus ring, selection outline and blue text (2.97:1 on `#252525`, 3.23:1 on `#1E1E1E`), and `#383838` is also the control boundary (1.31:1 on `#252525`). Other text pairs keep ≥4.5:1; tests record the measured ratios of the excepted roles instead of asserting the old bar.
- **Shell:** titlebar holds only traffic lights and a drag region; session tabs and terminal actions live in the Terminals page header; Settings and Lock workspace sit in the sidebar footer; per-page header (title, subtitle, actions); no global status bar.
- **Overlays:** every in-app form, settings, workspace tool, shortcut list and confirmation is a right-edge drawer per the handoff drawer contract; no centered modal. Native Open/Save, Keychain and Google flows stay OS/external.
- **Restyle, not features:** controls drawn in the PNGs without existing behavior (sorting, row checkboxes, ⌘K, per-pane font/encoding, tab-strip "+") are not built. Exceptions decided with the user: the Files server picker (existing `sftp.open`) and manual Lock workspace ([ADR 0004](0004-local-app-lock.md) amendment).
- **Terminal:** independent Charcoal palette — background `#131313`, foreground/cursor `#F3F3F3`, green `#22C55E`, blue `#3B82F6`, neutral black `#737373`; stored `terminalPalette` value stays `signal-blue-dark`.
- **Brand:** `.icns` and in-app icon come from `docs/logo/icon-logo-v2.png` (charcoal tile, no sidebar wordmark); original artwork is preserved.

## Consequences

- Accessibility regression for the excepted roles is deliberate and documented; revisit with a lighter focus/text blue if low-vision use matters.
- Large E2E selector churn (titlebar tabs, dialogs → drawers); delivered in four separately committed phases.
- Light theme remains later scope.
