# 03: Identities, trust and auth prompts as drawers

**What to build:** Identity create/edit, SSH key import/rename/delete, unknown-host trust, changed-key block, trust revoke and password/passphrase/keyboard-interactive prompts all appear in the shared drawer.

**Blocked by:** 02 — Drawer primitive with Server and Group editors

**Status:** ready-for-agent

- [ ] Identity and SSH key forms and deletions use the drawer, with impact confirmation as a drawer step
- [ ] Unknown host key shows the trust drawer while the tab shows amber Awaiting trust and never a connected indicator
- [ ] Changed host key blocks in a red drawer with previous/presented fingerprints and an unchecked verification box; replacement stays disabled until checked
- [ ] Revoke trust is a drawer confirmation step
- [ ] Credential prompts use the drawer with empty fields; no secret prefill, trace or screenshot after entry
- [ ] Existing identities, known-hosts, auth and credentials E2E keep their behavioral assertions
