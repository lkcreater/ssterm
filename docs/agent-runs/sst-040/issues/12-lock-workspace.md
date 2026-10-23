# 12: Lock workspace: immediate lock

**What to build:** Lock workspace in the sidebar footer locks the whole app: the existing session lock runs, then every window shows the app-lock gate and main refuses feature IPC until unlock.

**Blocked by:** 09 — Shell v2

**Status:** done

- [ ] New validated lock-now command on the app-lock boundary; main runs the existing screen-lock/suspend session lock for the whole process, then returns the app-lock controller to locked
- [ ] Every window shows the existing gate; feature IPC answers unauthorized until unlock
- [ ] Unlock uses the same method, backoff and Google offline grace as at app start
- [ ] Action is hidden when the app lock is off (test profiles); OS screen lock/suspend behavior unchanged
- [ ] Unit: relock transition, repeated lock-now, lock-now during an in-flight unlock, IPC between session lock and app lock answers unauthorized
- [ ] E2E with the app lock on: nothing live → immediate gate in all windows, unlock restores the workspace
