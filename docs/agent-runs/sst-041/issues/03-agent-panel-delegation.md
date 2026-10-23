# 03: Agent panel with main agent and delegated tasks

**What to build:** With AI Agent enabled in Settings (with consent), a Ready SSH pane shows AI Agent. It opens a non-modal right panel bound to that session. The user chats with the main DevOps Engineer agent, which delegates a task to a sub agent. The sub agent's commands run in the pane, and the main agent summarizes from ssterm's task record.

**Blocked by:** 01, 02

**Status:** done

- [ ] Settings › AI Agent is off by default. Enabling it names the provider and lists exactly what is sent; only providers verified in 01 can be chosen.
- [ ] The AI Agent button shows only on Ready SSH panes (not local or Team). The panel is non-modal and resizable, its header shows target/PROD, it stays bound across tab switches, and a provider banner is always visible.
- [ ] The main agent CLI gets only `delegate_task`, `get_task_status` and `cancel_task`. Sub agent CLIs get only the terminal tools for the bound session, one at a time, with further tasks queued.
- [ ] Task cards show progress. The expandable record (commands, exit codes, output, refusals) comes from ssterm, and `get_task_status` returns the same record.
- [ ] Bundled versioned instructions are used. The Settings field for additional instructions appends text and cannot replace them.
- [ ] Lock, session end, panel close and quit terminate CLI processes, clear the conversation, and refuse pending calls. No transcript is written to disk.
- [ ] E2E uses a fake MCP-speaking agent CLI: chat → delegate → commands in the pane → summary. Consent gating, cleanup, and no external requests made by ssterm.
- [ ] Production spawn requirements from the ADR 0009 "Spike findings" section are met: absolute binary path, a version gate, stdin stream-json, SIGTERM before SIGKILL with process-group kill, per-run cache/session cleanup, and the extended A3 disclosure.
