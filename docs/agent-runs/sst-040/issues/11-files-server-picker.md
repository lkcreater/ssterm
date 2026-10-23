# 11: Files server picker

**What to build:** The Files header has a server picker that opens SFTP to the chosen server, behaving exactly like Servers → Open files.

**Blocked by:** 09 — Shell v2

**Status:** done

- [ ] Picker lists catalog hosts and calls the existing SFTP open; header shows the remote target and connection status
- [ ] Choosing another server closes the previous SFTP session through the existing close/confirmation path; a live transfer is never dropped silently
- [ ] Trust and auth flows are the same as Open files
- [ ] Open files on Servers still works
- [ ] E2E covers switching servers with and without a live transfer
