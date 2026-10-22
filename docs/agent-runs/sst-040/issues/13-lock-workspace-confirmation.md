# 13: Lock workspace: confirm when work is live

**What to build:** When terminals, tunnels, transfers or remote edits are live, Lock workspace first shows a drawer listing what will close and offers Lock and close N.

**Blocked by:** 02 — Drawer primitive with Server and Group editors; 12 — Lock workspace: immediate lock

**Status:** ready-for-agent

- [ ] Main reports a live-resource summary (SSH/local terminals, tunnels, transfers, remote edits)
- [ ] Non-empty summary opens a confirmation drawer listing them with a red Lock and close N action; empty summary locks immediately
- [ ] Cancel leaves everything running
- [ ] A resource started between summary and confirm is still closed by the lock
- [ ] E2E with a live SSH terminal, local terminal, tunnel and transfer: Cancel keeps them, confirm closes them and shows the gate
