# 10: Servers table with host drawer

**What to build:** Servers is a column table (Name, Address, Identity, Environment, Status) with Connect and a ⋯ menu per row, a footer summary, and host details/edit in the host drawer.

**Blocked by:** 02 — Drawer primitive with Server and Group editors; 09 — Shell v2

**Status:** done

- [ ] Table rows sorted by name as today; no sort controls, no row checkboxes, no ⌘K hint
- [ ] Each row has Connect and a ⋯ menu of existing actions (Edit, Open files, Delete …); keyboard row navigation preserved
- [ ] Activating a row opens the host drawer that replaces the former detail panel
- [ ] Footer summary shows workspace, server count and connected count
- [ ] Group/tag/search scoping unchanged; catalog-ui and catalog-connect E2E pass
- Note (SST-040/09 review): the removed global status bar's connected count included ready SFTP sessions as well as terminals; decide whether the Servers summary keeps that.
