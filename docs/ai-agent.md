# AI agent (SST-041, SST-043)

An opt-in AI agent that works in a connected SSH session, through the user's own installed AI CLI. Decisions are A1–A14 in the [implementation plan](agent-runs/implementation-plan.md#ai-terminal-agent--grilling-decisions-2026-10-23-proposed-sst-041). The architecture is in [ADR 0009](adr/0009-ai-terminal-agent-and-mcp.md), the privacy specification in [AI scope](ai-scope.md), and other AI apps that use the same tools in [external MCP clients](agent-external-clients.md). Evidence is in the [delivery record](agent-runs/sst-041-delivery.md).

## Turning it on

- **Off by default.** Settings › AI Agent › "Use the AI agent".
- **Consent:** turning it on needs "I understand what is sent to <provider>" checked against the disclosure, which lists exactly what is sent. The consent is stored with a disclosure version; if the disclosure text changes, the agent is off again until the user re-confirms.
- **Settings file:** `<profile>/agent-settings.json` (0600, allowlisted fields only). It holds on/off, the provider, the model and effort, the additional instructions, "Allow Full allow on PROD" and an optional custom provider definition. No secret is stored.

## Providers and models

- **`claude` (Anthropic):** verified for `claude` 2.1.309 only. ssterm runs the real native binary from its fixed install paths: a Mach-O check is made, wrappers and shims are refused, and the version is checked again at every spawn. A newer or older version is refused until the [isolation check](spikes/ai-cli-isolation.md) is re-run for it. ssterm also refuses to run claude while a managed or MDM policy file for it exists.
- **`codex` (OpenAI):** listed but disabled. No version has passed the isolation check (codex-cli 0.163.0 failed), so Settings shows the reasons and ssterm never runs `codex`, not even `codex --version`.
- **Custom CLI provider:** an absolute binary path (not a shell, `env` or script interpreter), arguments one per line with the placeholders `{model}`, `{effort}`, `{mcpConfigPath}`, `{systemPromptFile}` and `{allowedTools}`, and how prompts are sent (stream-json or one process per message). It can also have environment additions (names that look like secrets, or that ssterm sets or that load code, are refused), a test-endpoint variable and the client tool timeout (10–3600 s).
  - It runs only after **Run isolation check** passes. The check runs both roles in a poisoned working folder with canary files and a stub ssterm MCP server, and points the CLI at ssterm's loopback test endpoint. The verdict is bound to the definition, the binary's hash and its version output, and it is re-checked before each spawn.
  - A CLI with no endpoint variable can only get a weaker, explicitly consented live check, which sends two synthetic prompts to its provider. Claude Code set up as a custom provider keeps every claude control and never accepts a live-only pass.
- **Models (A14):** no CLI can list its models, so the list is bundled with the verified CLI version.
  - claude: `claude-opus-5-5` (`opus`, the default, verified by user decision), `claude-haiku-5-5` (`haiku`, verified), and `claude-fable-5-1` and `claude-sonnet-5-5` (listed, not verified).
  - Effort: low, medium, high, xhigh or max; the default is `xhigh`.
  - A custom model ID (one token) can be entered, but it is never verified. Only verified models run.
  - The choice applies to new conversations, and sub agents use the same model. The panel can also change a claude conversation's model and effort (SST-043, below).

## Using the agent

- **Opening:** the **AI Agent** button (bot icon) appears in the pane header of a **Ready SSH session**. It does not appear for local terminals or Team-managed hosts. It opens a non-modal, resizable panel on the right of Terminals: one panel per window, bound to the session it was opened from. The header shows the target and PROD badge, and stays on that session when tabs change. An amber shield icon right after the "AI Agent" title is the always-visible disclosure (SST-043 amends A3's banner): its text, that messages, commands and full output go to the provider, shows on hover and on keyboard focus and is the icon's accessible description.
- **Main agent and tasks:** the user chats with a main "DevOps Engineer" agent. It can only `delegate_task`, `get_task_status` and `cancel_task`; it cannot run commands. Each task is carried out by a sub agent with only `propose_plan`, `run_command`, `read_output` and `cancel` on this session.
  - One sub agent runs per session at a time; further tasks queue. Limits: 8 open tasks, 64 steps per task, 8 conversations.
  - A task card shows ssterm's own record of each command: the command, status, exit code and output (the last 4 KiB in the card, the 64 KiB tail in the record). The sub agent's own report is shown as "unverified". The main agent's summary is checked against ssterm's record, and success is only claimed from an exit code.
- **Additional instructions:** up to 4,000 characters in Settings, appended to the bundled, versioned instructions (`sst-043-01`). They cannot replace them. The safety rules are enforced by ssterm, not by the instructions.
- **Language (SST-043):** the main agent answers only in the language of the user's latest message. It writes `delegate_task` goals in English and ends each with the report language (for example "Report in Thai."); the sub agent writes its final report in that language, English if none is named.

## The panel (SST-043)

- **Conversation:**
  - Replies are bubbles under a sparkles icon with the model name; consecutive replies share one bubble.
  - Each task card sits in the bubble of the turn that delegated it (the task's `afterMessage`), as one line: status, the goal (truncated, full text as a tooltip), "N commands", Cancel while running, and **Expand**.
  - Expanding shows the full goal, a decided plan, ssterm's record and the collapsed "Sub agent report (unverified)".
  - User messages stay plain text in right-aligned bubbles.
- **Safe Markdown:** replies and sub-agent reports render with `react-markdown` 10.1.0 and `remark-gfm` 4.0.1.
  - Raw HTML is dropped (`skipHtml`, no `rehype-raw`), and images, media, frames, scripts, styles and form controls are removed.
  - Every URL attribute is emptied, and links become text followed by their URL: nothing is clickable or fetched.
  - GFM tables are real tables in a scrollable region named after their header cells. Task-list boxes show as ☑/☐ text, and footnote ids are prefixed per message. There is no syntax highlighter.
  - **Plain-text fallback:** text over 20,000 characters, with more than 12 nested quote or list markers or more than 48 columns of indentation, with a run of 48 `*_~[]` characters, or with more than 1,000 of them, is shown as plain text. Deep nesting would overflow the renderer's stack.
  - A render error in a message shows that message as plain text. One in the panel shows a "could not be shown" panel with Close. Anywhere else in the window, it shows a "Try again" notice instead of an empty window.
- **Composer:** a 3-row textarea that grows to about 160 px, then scrolls. Enter sends; Shift+Enter adds a line. Enter during IME composition never sends. The limit stays at 8,000 characters.
- **Waiting for you:** everything that needs a decision is pinned in a tray above the composer, outside the scrolling conversation, with a "N waiting for you" count:
  - plan and command cards, oldest task first, each with "Task N", the goal, the target and environment, the exact command(s) and its buttons (the PROD step happens inside the card);
  - the Full allow warning, the password notice, and an external binding's section with its cards.
  - The tray takes at most 45% of the panel, scrolls inside, and never covers the composer. A task with a waiting card shows "Waiting for you ↓" on its line.
  - A new card moves focus to its Reject button, only when focus is in the panel or nowhere and the composer holds no unsent text. Decisions go through the same IPC as before.
- **Progress, Stop and Stopping:**
  - While busy, a line above the composer says what the turn waits for ("Thinking…", "Waiting for task N: …", "Task N is waiting for your decision", "Task N is queued"), and **Stop** appears next to Send.
  - Stop cancels queued and running tasks (a running command gets Ctrl+C through its revoked credential), withdraws pending cards and records "Stopped by you…".
  - For claude it then sends the stream-json `interrupt` control request. Other providers, and a turn that has not ended 10 s later, have their process stopped instead.
  - Until the interrupted turn ends, the conversation is **Stopping…** and nothing can be sent, so no message is lost to the stopped turn. Anything the stopped turn still prints is dropped.
- **Watchdog:** a busy turn with no CLI event, recorded step or decision for **8 minutes** is stopped the same way, with a notice.
  - It only waits while a card waits for the user or a terminal call is in flight (each command has its own 10-minute timeout).
  - Trade-off: a very long silent model turn (extended thinking at high effort) is cut off after 8 minutes; Stop is there for shorter waits.
- **When a CLI stops:**
  - **Sub agent:** its record is final at its result, so the main agent's wait returns at once. A sub-agent CLI that lingers after reporting is stopped 10 s later. One that exits without a result fails its task with "The sub agent CLI exited without a report."
  - **Main agent:** if the main CLI exits or is stopped, a notice says so. The next message starts a new main process that is given the conversation's messages so far (not the earlier command records), as the one-shot providers always are. Messages that never reached a CLI are not replayed.
- **Model and effort:** the chevron after the model line lists the verified claude models and the efforts. It is disabled while the agent is busy or tasks are open, and for custom providers, whose model is part of their definition.
  - A change applies from the next message: the idle main process ends quietly and the next one starts with the new choice and the conversation's text. New tasks use it too.
  - It is checked in main (owner, generation, verified model); the version gate runs again at the next spawn.
  - "Also set as default" saves it in Settings for one change. A notice records "Model changed to X (effort Y)".
- **Context:** "N% context" after the model line is the main agent's latest request (input plus cache-read and cache-creation tokens, from the assistant event's `usage`) against the model's window from the CLI's result (`modelUsage[model].contextWindow`, field names from the claude 2.1.309 binary).
  - Nothing is shown until the CLI has reported both, and it resets with a new process. It is never estimated.
- **Session end:** when the panel's session disconnects, closes, exits, fails, locks or reconnects (a new generation), the panel closes with the toast "Agent conversation ended with the session", and focus returns to the active pane. Panels of other sessions stay.

## Modes, plans and PROD

- **Read only:** only commands classified read-only run; everything else is refused. Read-only steps run with `</dev/null`. The classification is a per-command option allowlist with path checks, and it is **best effort**, as the UI says. Redirects, chaining, pipes into other programs, substitutions, subshells, `..` or device paths and writing options all count as not read-only.
- **Auto** (default): the sub agent proposes a plan (a goal and commands), which the user approves or rejects once. Each approved command runs once, exactly as approved. Read-only commands also run. Any other command gets its own approval card. Cards wait at most 5 minutes, and a card is withdrawn if its call is cancelled.
- **Full allow:** every command runs without approval. It is chosen per conversation behind a warning, and every new conversation starts in Auto.
- **PROD:** approving a plan or command needs an extra "This is a PROD server" step. Full allow on PROD is unavailable unless **Allow Full allow on PROD** is on in Settings (off by default), and even then it has its own warning.

## How commands run

- **Execution:** each command is one line (at most 4,096 characters; control and invisible characters are refused, so multi-line scripts cannot be sent). ssterm first checks the shell is at a prompt, then types the command into the visible pane wrapped in nonce-tagged start and done markers. The done marker carries the exit code. Only the output between the markers is used, cut to the last 64 KiB with the cut marked.
- **While a command runs,** the pane shows "Agent running: <command>" with Stop. The user's keystrokes are held; Ctrl+C always passes.
- **Refusals and stops:** full-screen (alternate-screen) programs are stopped. Each command times out after 10 minutes, and ssterm then sends Ctrl+C. This timeout is fixed; it is not a Settings option.
- **Shared shell:** `cd` and environment changes persist, because it is the real shell.

## Password prompts

- **When a command asks for a password,** passphrase, OTP or PIN, the agent pauses. A card and a pane banner name the command and ask the user to type the entry in the terminal, "only if you expected this prompt".
- **Which commands:** this happens only for a *simple* command (no control operators, substitutions or redirects) that starts with a listed program: `sudo`, `su`, `ssh`, `scp`, `sftp`, `ssh-keygen`, `ssh-add`, `passwd`, `git` or `docker login`, in a step that is not read-only. Any other prompt is refused, and so is a prompt that is already waiting before a command starts.
- **The entry:** input passes only up to the first Return or Ctrl+C; other held keys are dropped, never replayed. Nothing the user types is sent to the agent. If a finished entry (plain, trimmed or base64) appears in the command's output, the whole output is withheld from the agent, which then sees only a note. At most 3 prompts are handed over per command.

## Lifecycle and cleanup

- **What ends a conversation:** closing the panel, the session ending or reconnecting (a new generation, which also closes the panel), Lock workspace or quit. Each stops the CLI processes (SIGTERM, a 2 s grace, then SIGKILL of the whole process group), revokes their MCP credentials, refuses pending tool calls and withdraws cards. Quit allows 5 s in all.
- **No persistence:** conversations are only in memory, and claude runs with `--no-session-persistence`.
  - Each CLI run gets a private folder `$TMPDIR/ssterm-agent-<16 hex>/` (0700). It holds an empty working folder, a temp folder, `mcp.json` (0600, with that run's MCP credential), `system-prompt.txt` and a `profile` marker. The folder is deleted when the run ends.
  - Also removed: the claude cache entries and `~/.claude/sessions/<pid>` files that name the run, and any transcript or history line naming the run under `~/.claude/projects`, `~/.claude/history.jsonl`, `~/.codex/sessions`, `~/.codex/history.jsonl` and `~/.gemini`.
  - Folders left by a crash are swept at the next launch, but only those of this profile.
- **Isolation at runtime:** each `init` and hook event is checked. Any tool other than the allowed ssterm tools, another MCP server, a plugin or a hook revokes the run's credential and kills its process group at once.

## Privacy notes

Every process and endpoint involved:

| Process / endpoint | Who starts it | What it contacts |
|---|---|---|
| The user's AI CLI (`claude`, or a checked custom CLI) | ssterm main, per conversation (main agent) and per task (sub agent) | Its provider, under the user's own account: Anthropic for `claude`. This is the only AI network traffic, and ssterm does not see or proxy it. |
| `ssterm-mcp` bridge (`/bin/sh` script running `cat` and `nc -U`) | The CLI, through `mcp.json` | Only the local MCP socket |
| MCP server in ssterm main | ssterm | Listens on the Unix socket `<profile>/mcp/ssterm.sock` (0600, 0700 folder). No TCP port; makes no outbound connection |
| SSH session | the user (existing) | The bound server only; the agent's commands run there, in the user's shell |
| Isolation check (custom providers only) | the user, from Settings | A temporary loopback HTTP endpoint on `127.0.0.1` (random port) standing in for the provider, and a temporary check socket under `/tmp/ssterm-check-*`. With the user's explicit consent, a live check sends two synthetic prompts through the CLI to its provider |
| External MCP clients (separate switch) | the user's own apps | The same Unix socket through the bridge; see [external MCP clients](agent-external-clients.md) |

- **ssterm itself makes no AI network contact:** it has no provider SDK, API key or AI HTTP client, and E2E asserts that the renderer makes no external request and main opens no TCP listener; main's outbound connections are not observed by tests.
- **Sent through the CLI:** chat messages and replies; the agent's commands and their output (64 KiB tails, no redaction); the bound target's label, `user@host:port` and environment; the additional instructions; and what the CLI adds itself (for claude: the temporary folder path, OS version, platform, shell, model, date, CLI version and account email).
- **Re-sent (SST-043):** after a main CLI exits, is stopped, or the model changes, the next process of the same provider is given the conversation's messages again (memory only; not the command records), as one-shot providers are on every turn. Nothing goes to another provider.
- **Never sent by ssterm:** earlier scrollback, typed terminal input (including passwords), other sessions, the catalog, snippets, recordings and history, credentials and keys.
- **On disk:** `agent-settings.json`; while a run is live, its run folder; for external clients, `mcp-clients.json` and Keychain `mcp-client/v1/<id>` verifiers. No conversation text is kept.
- **Provider-side retention** follows the CLI account's terms, which ssterm cannot change.

## Limits

- Local terminals, Team-managed hosts, SFTP, tunnels, templates and the catalog are out of reach for the agent.
- The read-only classifier is best effort.
- Wrapper second prompts: a second prompt under a listed wrapper (`sudo sh -c`, `ssh host 'cmd'`, askpass) can still be handed to the user; the warning naming the command is the control.
- Password buffers are zeroed on a best-effort basis only.
- The ready probe is typed into whatever program holds the terminal. A stdin reader (`cat > file`) receives its text, and a nested shell (`ssh host2`, `sudo -i`) answers it, so the command then runs in that shell rather than on the bound host. A waiting password prompt is detected and refused before probing.
- Same-user trust boundary: any process running as the same macOS user can read a live run's `mcp.json` or a paired client's credential file and act within that binding.
- The live multi-turn stream-json conversation with a real `claude` has been capture-tested only. E2E uses a fake CLI, and the isolation spike made the live calls.
- The command timeout is fixed at 10 minutes. There is no cost display or quota beyond the provider's own.
- The stream-json `interrupt` request matches claude 2.1.309's own handling as read from the binary; it has not been exercised against the real CLI (the fake CLI implements it). If a turn ignores it, the 10 s fallback stops the process.
- The context share depends on the CLI's usage reports; providers that report no window show none.
- A CLI update disables the agent until the isolation check is re-run for the new version and that version is added.

## Test seams (validated test profiles only)

Main honours these only with a validated `SSTERM_TEST_USER_DATA`, and only for paths inside it:

- `SSTERM_TEST_AGENT_CLI`: the fake claude (`tests/fixtures/agent/fake-claude.mjs`) wrapper. A test profile without it never runs the host's own `claude` or `codex`.
- `SSTERM_TEST_AGENT_HOME`: the home folder that CLI residue and cleanup use.
- `SSTERM_TEST_AGENT_TIMEOUT_MS`: a shorter command timeout.
- `SSTERM_TEST_MCP=on`: exposes a main-only hook that mints a conversation credential for a Ready SSH session.
- `SSTERM_TEST_PAIRING_MS`: a shorter pairing-token lifetime.
- `SSTERM_TEST_LOCAL_HOME`: the owned home for local terminals.

The fake CLI also answers `markdown`, Thai text (it echoes the language rules it received), `stall` (never ends the turn until an interrupt), `crash`, `deep-quote`/`deep-emphasis`, and a sub-agent goal `crash`. It reports usage the way claude does. The runner's `stallMs` and `interruptMs` options are unit-test seams only.

E2E specs: `agent-mcp`, `agent-panel`, `agent-custom` and `agent-external` in development; `agent-panel` and `agent-external` also run against the packaged app.
