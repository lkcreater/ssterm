# 08: Remove remaining centered dialogs

**What to build:** No in-app flow opens a centered modal anymore; the old dialog components are removed and the drawer contract is checked on every page. Contract step of the migration.

**Blocked by:** 03, 04, 05, 06, 07

**Status:** ready-for-agent

- [ ] No feature area renders a centered Dialog or AlertDialog; unused dialog components are deleted
- [ ] Native Open/Save, Keychain and Google flows are untouched
- [ ] Release-gate sweep opens every drawer at 960×640 and 1280×800 with reduced motion and checks right-edge placement, focus return and no overflow
- [ ] Full unit and E2E pass
