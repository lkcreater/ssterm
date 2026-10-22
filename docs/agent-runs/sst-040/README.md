# SST-040 tickets

From the [spec](../sst-040-spec.md). Work the frontier: any ticket whose blockers are done. One local commit per ticket after TEST and REVIEW; no push.

| # | Ticket | Blocked by |
|---|---|---|
| 01 | [Charcoal tokens, terminal palette and icon v2](issues/01-charcoal-tokens-terminal-icon.md) | None (can start immediately) |
| 02 | [Drawer primitive with Server and Group editors](issues/02-drawer-primitive-catalog-editors.md) | None (can start immediately) |
| 03 | [Identities, trust and auth prompts as drawers](issues/03-security-flows-to-drawers.md) | 02 |
| 04 | [Terminal flows as drawers](issues/04-terminal-flows-to-drawers.md) | 02 |
| 05 | [Files flows as drawers](issues/05-files-flows-to-drawers.md) | 02 |
| 06 | [Snippets, Port forwarding, Recordings and Team vault flows as drawers](issues/06-remaining-page-flows-to-drawers.md) | 02 |
| 07 | [Settings as one drawer with tabs](issues/07-settings-drawer.md) | 02 |
| 08 | [Remove remaining centered dialogs](issues/08-remove-centered-dialogs.md) | 03, 04, 05, 06, 07 |
| 09 | [Shell v2: sidebar, page headers and Terminals page](issues/09-shell-v2.md) | 01 |
| 10 | [Servers table with host drawer](issues/10-servers-table.md) | 02, 09 |
| 11 | [Files server picker](issues/11-files-server-picker.md) | 09 |
| 12 | [Lock workspace: immediate lock](issues/12-lock-workspace.md) | 09 |
| 13 | [Lock workspace: confirm when work is live](issues/13-lock-workspace-confirmation.md) | 02, 12 |
| 14 | [App-lock gate v2](issues/14-app-lock-gate-v2.md) | 01 |
| 15 | [Page polish and final gates](issues/15-page-polish-final-gates.md) | 08, 10, 11, 13, 14 |
