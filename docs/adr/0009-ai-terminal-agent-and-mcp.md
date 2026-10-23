# ADR 0009 — AI terminal agent and MCP endpoint

- Date: 2026-10-23
- Status: **Proposed** (SST-041 specified; implementation not authorized — [decisions A1–A13](../agent-runs/implementation-plan.md#ai-terminal-agent--grilling-decisions-2026-10-23-proposed-sst-041))
- Would supersede, once accepted: the "no AI feature / never sent" defaults of [AI scope](../ai-scope.md) for this feature only, and the AGENTS.md rule limiting app-related network contact to SSH, Google and the sync endpoint (the provider contact is made by the user's own CLI, not by ssterm)

## Context

The user wants an AI agent that operates the terminal of a connected SSH session. It should chat through the locally installed `claude` or `codex` CLI. A main "DevOps Engineer" agent delegates to sub agents that run commands through MCP. The same MCP endpoint should also serve other AI clients. [AI scope](../ai-scope.md) lists preconditions such a feature must meet; each is answered below.

## Decision

- **Execution policy (A1, A2):** each session has a mode.
  - **Read only:** strict allowlist of read-only commands; everything else is refused.
  - **Auto** (default): one approval per plan. In-plan and read-only commands run; any other command needs its own approval.
  - **Full allow:** a per-session opt-in.
  - **PROD:** plan approval needs the extra confirmation. Full allow is available on PROD only after the Settings option "Allow Full allow on PROD" is enabled.
  - **Read-only classification** is best effort and says so in the UI.
- **Data and consent (A3, A11):**
  - Off by default. Enabling names the provider and the data sent. A banner is shown on every agent session.
  - Sent: chat messages, commands, their output (64 KiB tail per command) and the bound target's label, `user@host:port` and environment.
  - Never sent: scrollback, typed input, other sessions, the catalog, snippet bodies, credentials.
  - No redaction claim.
  - No conversation persistence: memory only, and CLIs run without session persistence.
- **Passwords (A4):** password prompts pause the agent. The user types in the pane, and that input is excluded from agent output.
- **Orchestration (A5, A12):**
  - The main agent gets only `delegate_task`, `get_task_status` and `cancel_task`.
  - ssterm spawns sub agents that get only the terminal tools.
  - Audit uses ssterm's own task record.
  - Instructions are bundled and versioned; the user can append text but cannot replace them.
  - One sub agent per session; further tasks queue.
- **Local isolation (A6):**
  - CLIs run with every built-in local tool disabled and only the ssterm MCP tools.
  - Nothing from the user's CLI setup is loaded: other MCP servers, hooks, plugins or project instructions.
  - Each run gets an empty temporary working directory and an allowlisted environment.
  - A CLI version is enabled only after a spike proves local reads and local shell are refused.
- **MCP endpoint (A7, A8):**
  - One server in main, on a 0600 Unix socket in the profile, with no TCP. A bundled `ssterm-mcp` stdio bridge serves stdio-only clients.
  - ssterm-launched agents use ephemeral per-conversation credentials.
  - External clients pair through a one-time token. The resulting per-client credential is kept in Keychain, and the user approves the client in ssterm.
  - Clients cannot list sessions. The user binds a session in an ssterm drawer.
  - Settings lists clients with Revoke. Lock drops every connection. A banner names the controlling client.
  - External clients get terminal tools directly (`propose_plan`, `run_command`, `read_output`, `cancel`) under the same rules.
- **Execution (A9):**
  - Commands are typed into the visible pane's shell with a nonce-tagged completion marker carrying the exit code.
  - User keystrokes are held while an agent command runs, except Ctrl+C and password entry.
  - Full-screen programs are refused.
  - Each command has a timeout (default 10 min), after which ssterm sends Ctrl+C.
  - Commands are one line; heredoc scripts are never read-only.
- **UI (A10):**
  - The agent chat is a non-modal resizable right panel on Terminals, an explicit exception to the ADR 0008 drawer contract.
  - It is available for Ready SSH sessions only. Local terminals and Team-managed hosts are excluded in the first release.

## Consequences

- **Privacy shift:** terminal output reaches the CLI's provider under the user's account terms, by explicit opt-in. Precondition 6 of AI scope ("no execution") is replaced by the mode/plan policy above.
- **New attack surface:** a local endpoint that can run commands on servers. It is mitigated by the socket permissions, pairing, per-session binding, the modes and the PROD gates. Any local process running as the same user that obtains a paired credential can act within a bound session.
- **CLI dependence:** behaviour depends on CLI flags that can change between versions, so support is gated per verified CLI version.
- **Before acceptance:** this ADR becomes Accepted only when the user authorizes implementation. AI scope, AGENTS.md and privacy notes are then updated in the delivering ticket.

## Spike findings (SST-041/01, 2026-10-23)

See [CLI isolation spike](../spikes/ai-cli-isolation.md).

- **`claude` 2.1.309** passes the tested modes.
- **`codex-cli` 0.163.0** stays disabled. `$CODEX_HOME/AGENTS.md` is always sent, `apply_patch` cannot be removed (the read-only sandbox blocks it), and `multi_agent` tools still appear when disabled.

Production requirements carried into ticket 03:
- Spawn the real binary by absolute path and reject wrappers. On the test host, the PATH entries are cmux shims.
- Gate on the CLI version at every spawn, against versions that passed the check. The binary is a self-updating symlink, so pinning it alone is not enough.
- Use the spike's argument and environment builders. With the flags alone, claude still expands relative `@file` mentions inside the cwd, so `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` and `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` are mandatory. Use `--input-format stream-json` over stdin for multi-turn conversations, never argv prompts, which are visible to `ps` and limited by ARG_MAX.
- Stop processes with SIGTERM before SIGKILL, and kill the whole process group.
- After each conversation, delete that run's per-cwd `~/Library/Caches/claude-cli-nodejs` entries and its `sessions/<pid>.json`.
- Re-run the check on every CLI update before that version is enabled.

Amendments:
- **A11:** the "no transcript" decision still leaves transient metadata residue (MCP connection logs and session pid files), which the cleanup above removes.
- **A3:** the provider disclosure must also list the temporary working-directory path, the OS version, the date and the signed-in account email.
- **A6 limit:** managed/MDM policy settings still apply under `--restricted`. None exist on the test host.
