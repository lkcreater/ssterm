# ADR 0009 — AI terminal agent and MCP endpoint

- Date: 2026-10-23 (proposed and accepted the same day)
- Status: **Accepted** (2026-10-23, SST-041 ticket 08, after the release gates passed — [delivery](../agent-runs/sst-041-delivery.md)). Decisions [A1–A14](../agent-runs/implementation-plan.md#ai-terminal-agent--grilling-decisions-2026-10-23-proposed-sst-041).
- Supersedes, for this opt-in feature only: the "no AI feature / never sent" state of [AI scope](../ai-scope.md), and the AGENTS.md rule limiting app-related network contact to SSH, Google and the sync endpoint. The provider contact is made by the user's own CLI, not by ssterm.
- Behaviour: [AI agent](../ai-agent.md), [external MCP clients](../agent-external-clients.md). Evidence: [CLI isolation spike](../spikes/ai-cli-isolation.md).

## Context

The user wants an AI agent that operates the terminal of a connected SSH session. It should chat through the locally installed `claude` or `codex` CLI. A main "DevOps Engineer" agent delegates to sub agents that run commands through MCP. The same MCP endpoint should also serve other AI clients. [AI scope](../ai-scope.md) lists preconditions such a feature must meet; it now records how each one is met.

## Decision

As built in SST-041 tickets 01–07.

- **Execution policy (A1, A2):** each conversation or external binding has a mode, enforced in main.
  - **Read only:** a per-command option allowlist with path checks. Everything else is refused.
  - **Auto** (default for every new conversation and binding): `propose_plan` creates a plan card. Each approved command runs once, exactly as approved (surrounding spaces and tabs trimmed). Read-only commands also run. Any other command needs its own approval card.
  - **Full allow:** a per-conversation opt-in behind a warning step. It never carries over to a new conversation.
  - **PROD:** approving a plan or command needs the extra in-card PROD step. Full allow on PROD needs the Settings option "Allow Full allow on PROD" (off by default) and then its own warning.
  - **Read-only classification is best effort,** and the UI says so. Redirects, chaining, pipes into non-allowlisted programs, substitutions, subshells, `..`/device paths and writing options count as not read-only.
- **Data and consent (A3, A11):**
  - Off by default. Enabling needs the versioned disclosure acknowledged. It names the provider and lists what is sent, including what the CLI adds itself (temporary working-folder path, macOS version, platform, shell, model, date, CLI version, signed-in account email). The disclosure is always visible in every agent panel: a banner until SST-043, then an amber icon after the title whose full text shows on hover and on keyboard focus.
  - Sent: chat messages, the agent's commands, their output (64 KiB tail per command, truncation marked), the bound target's label, `user@host:port` and environment, and the user's additional instructions.
  - Never sent by ssterm: earlier scrollback, user-typed terminal input, other sessions, the catalog, snippet bodies, credentials and keys.
  - No redaction claim.
  - No conversation persistence: memory only. Claude runs with `--no-session-persistence`. Each run's folder, the CLI's per-run cache and session files, and any transcript naming the run are removed after the run and swept at the next launch.
- **Models (A14):** a bundled per-provider list, versioned with the verified CLI version, plus an optional custom model ID (one strict token) and an effort selector. The claude default is `claude-opus-5-5` at effort `xhigh`. It is marked verified by user decision: its live set was inconclusive only because the model declined two attack prompts, while the capture check passed. Only verified models run; a custom ID never counts as verified.
- **Passwords (A4, as hardened in ticket 05):**
  - A prompt is handed to the user only for a *simple* command (no control operators, substitutions or redirects) whose first word is a listed prompting program (`sudo`, `su`, `ssh`, `scp`, `sftp`, `ssh-keygen`, `ssh-add`, `passwd`, `git`, `docker login`), in a step that is not read-only. The card and banner name the command.
  - Read-only steps run with `</dev/null`, and any prompt there is refused.
  - The user types the entry in the pane. Input passes only up to the first Return or Ctrl+C; other held keys are dropped, never replayed.
  - If a finished entry (plain, trimmed or base64) appears in that command's output, the whole output is withheld from the agent. This leaks at most one bit per entry. The entry buffers are zeroed on a best-effort basis.
- **Orchestration (A5, A12):**
  - The main agent gets only `delegate_task`, `get_task_status` and `cancel_task`.
  - ssterm spawns one sub agent per task, with only the terminal tools and a per-task credential. One sub agent runs per session at a time; further tasks queue (at most 8 open tasks, 64 steps each).
  - Audit uses ssterm's own task record. The sub agent's own report is shown as unverified.
  - Instructions are bundled and versioned; the user can append up to 4,000 characters but cannot replace them.
- **Providers and local isolation (A6, ticket 06):**
  - **claude 2.1.309** runs only as the real native binary from fixed install paths (Mach-O check, wrappers refused), with its version re-checked at every spawn. It runs with every built-in tool disabled, only the ssterm MCP tools, no user or project settings, MCP servers, hooks, plugins, `@file` mentions or attachments, and stream-json over stdin. It is refused while a managed or MDM policy applies. An isolation detector on `init` and hook events revokes the credential and kills the process group on any violation.
  - **codex** has an adapter, but it is statically disabled: no version is verified (`$CODEX_HOME/AGENTS.md` is always sent, `apply_patch` cannot be removed, sub-agent tools appear). `codex --version` is not even run.
  - **Custom CLI providers** take an absolute binary path (no shells, `env` or interpreters), token arguments with whitelisted placeholders, and environment additions that refuse reserved or secret-like names. A provider runs only after its own isolation check passes for the exact definition, binary hash and version output. The check runs against ssterm's loopback test endpoint, or as a weaker, consented live check that sends two synthetic prompts. Claude Code configured as a custom provider keeps the claude controls and can never pass on a live-only check.
- **MCP endpoint (A7, A8, ticket 07):**
  - One hand-written JSON-RPC server in main, on `<profile>/mcp/ssterm.sock` (0600 socket, 0700 folder). No TCP. The bundled POSIX `ssterm-mcp` bridge (`/bin/sh`, `cat`, `nc -U`) serves stdio clients, including ssterm's own CLIs.
  - ssterm-launched agents use ephemeral per-conversation and per-task credentials, stored only as SHA-256 and revoked on lock, quit, panel close and generation end.
  - External clients are off by default. They pair through a one-time token (5 minutes, single use, rate-limited, burnt after wrong presentations) and a user-approved, unique client name. The `<id>_<secret>` credential is delivered once; Keychain keeps only its verifier, compared in constant time.
  - Clients cannot list sessions. A drawer lets the user bind one Ready SSH session of that window. A session has either an ssterm conversation or an external binding, never both, and `read_output`/`cancel` answer only for the caller's own commands.
  - Settings lists clients with Revoke. Lock drops every connection and binding. A banner names the controlling client and has Stop.
  - External clients get `propose_plan`, `run_command`, `read_output` and `cancel` under the same A1–A4 rules. Their cards expire at the shorter of 5 minutes and the client's tool timeout minus 5 seconds.
- **Execution (A9):**
  - A ready probe, then the one-line command typed into the visible pane's shell, wrapped in nonce-tagged start and done markers (`printf '\e]ssterm;done;<nonce>;%s\a' $?`). Only the span between the markers is returned.
  - User keystrokes are held while an agent command runs, except Ctrl+C and the password handoff. A banner shows "Agent running: <command>" with Stop.
  - Alternate-screen programs are refused.
  - Each command has a 10-minute timeout, after which ssterm sends Ctrl+C. **Deviation:** the timeout is fixed, not a Settings option; only test profiles can shorten it.
  - Commands are one line of at most 4,096 characters. Control and invisible characters are refused, so multi-line heredoc scripts cannot be sent.
  - ssterm refuses rather than probes when a prompt is already waiting.
- **UI (A10):**
  - The agent chat is a non-modal resizable right panel on Terminals, an explicit exception to the ADR 0008 drawer contract.
  - It is available for Ready SSH sessions only. Local terminals and Team-managed hosts are excluded.

## Consequences

- **Privacy shift:** terminal output reaches the CLI's provider under the user's account terms, by explicit opt-in. ssterm itself makes no AI network contact. Precondition 6 of AI scope ("no execution") is replaced by the mode/plan policy above.
- **New attack surface:** a local endpoint that can run commands on servers. It is mitigated by the socket permissions, pairing, per-session binding, the modes and the PROD gates.
- **Residual risks (accepted, documented in the [delivery](../agent-runs/sst-041-delivery.md#known-limitations-and-residual-risks)):**
  - **Same-user trust boundary:** any local process running as the same user that obtains a paired credential file, or an unused pairing token, can act within a binding the user grants. Any such process could also read `mcp.json` in a run folder while a run is live.
  - **Wrapper second prompts:** a second prompt under a listed wrapper (`sudo sh -c`, `ssh host 'cmd'`, askpass) can still be handed off. The warning naming the command is the control.
  - **Bridge lingering:** after revoke or lock, an established external client's bridge can linger on macOS until the client's next write. The server refuses at once.
  - **Best-effort zeroing:** password entry buffers are zeroed on a best-effort basis; JavaScript strings and the kernel/PTY path cannot be wiped.
  - **Read-only classifier:** best effort; an allowlisted program could still do more than it appears to.
  - **Provider and CLI:** provider-side retention is outside ssterm's control. Managed/MDM policy cannot be overridden (ssterm refuses to run under it).
- **Re-send to a new process (SST-043):** after a main CLI exits, is stopped (Stop, the 8-minute watchdog or a model change), the next process of the same provider is given the conversation's messages again from memory (not the command records). Nothing goes to another provider, and the disclosure already covers chat messages and replies.
- **CLI dependence:** behaviour depends on CLI flags that can change between versions, so support is gated per verified CLI version. Any CLI update requires re-running the isolation check before that version is enabled.

## Spike findings (SST-041/01, 2026-10-23)

See [CLI isolation spike](../spikes/ai-cli-isolation.md).

- **`claude` 2.1.309** passes the tested modes.
- **`codex-cli` 0.163.0** stays disabled. `$CODEX_HOME/AGENTS.md` is always sent, `apply_patch` cannot be removed (the read-only sandbox blocks it), and `multi_agent` tools still appear when disabled.

Production requirements carried into ticket 03 (all implemented):
- Spawn the real binary by absolute path and reject wrappers. On the test host, the PATH entries are cmux shims.
- Gate on the CLI version at every spawn, against versions that passed the check. The binary is a self-updating symlink, so pinning it alone is not enough.
- Use the spike's argument and environment builders. With the flags alone, claude still expands relative `@file` mentions inside the cwd, so `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` and `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` are mandatory. Use `--input-format stream-json` over stdin for multi-turn conversations, never argv prompts, which are visible to `ps` and limited by ARG_MAX.
- Stop processes with SIGTERM before SIGKILL, and kill the whole process group.
- After each conversation, delete that run's per-cwd `~/Library/Caches/claude-cli-nodejs` entries and its `sessions/<pid>.json`.
- Re-run the check on every CLI update before that version is enabled.

Amendments:
- **A11:** the "no transcript" decision still leaves transient metadata residue (MCP connection logs and session pid files), which the cleanup above removes.
- **A3:** the provider disclosure must also list the temporary working-directory path, the OS version, the date and the signed-in account email.
- **A6 limit:** managed/MDM policy settings still apply under `--restricted`. ssterm therefore refuses to run claude while one is present. None exist on the test host.
- **Re-check at acceptance (ticket 08):** the capture-mode check was re-run on the installed versions with no provider call. Results are in the [delivery](../agent-runs/sst-041-delivery.md#validation).
