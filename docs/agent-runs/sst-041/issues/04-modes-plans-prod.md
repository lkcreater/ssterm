# 04: Modes, plan approval and PROD gates

**What to build:** Each agent session has a mode selector: Read only, Auto (default) and Full allow. In Auto the sub agent proposes a plan the user approves once. In-plan and read-only commands then run, and anything else asks first. PROD gets the extra confirmation, and Full allow on PROD needs the Settings opt-in.

**Blocked by:** 03

**Status:** done

- [ ] `propose_plan` shows a plan card (goal and commands). Approve or Reject; in Auto, nothing outside read-only runs before approval.
- [ ] Each in-plan command runs. An out-of-plan command shows a per-command approval card, and a rejection is returned to the agent.
- [ ] Full allow is an explicit per-session opt-in with a warning, and every new session starts in Auto.
- [ ] On PROD, plan approval needs the extra confirmation step. Full allow is unavailable unless Settings › 'Allow Full allow on PROD' is on (off by default); even then it still needs the PROD warning opt-in.
- [ ] The UI states that read-only classification is best effort.
- [ ] Unit and E2E tests cover each mode, plan matching, the out-of-plan path, both PROD gates and the setting.
