# 06: Snippets, Port forwarding, Recordings and Team vault flows as drawers

**What to build:** Create/edit/delete and configuration flows on Snippets, Port forwarding (local/remote/dynamic), Recordings and Team vault (managed host, members, setup/recovery) use the shared drawer.

**Blocked by:** 02 — Drawer primitive with Server and Group editors

**Status:** done

- [ ] Snippet editor and delete are drawer flows; bodies stay encrypted and decrypt only on explicit action
- [ ] Each forwarding rule type has its drawer form with existing per-type validation and public-bind warning
- [ ] Recording delete/export/forget confirmations are drawer steps
- [ ] Team managed host, members/roles and setup/recovery are drawers; role-gated actions unchanged
- [ ] snippets, tunnels-ui, recording and team E2E keep their behavioral assertions
