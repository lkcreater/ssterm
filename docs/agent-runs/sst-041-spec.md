# SST-041 spec: AI terminal agent and MCP endpoint

**Status:** specified 2026-10-23. Implementation is not authorized (decision A13).
**Decisions:** A1–A13 in the [implementation plan](implementation-plan.md#ai-terminal-agent--grilling-decisions-2026-10-23-proposed-sst-041). **ADR:** [ADR 0009](../adr/0009-ai-terminal-agent-and-mcp.md) (Proposed). **Tickets:** [SST-041 breakdown](sst-041/README.md).

## Problem Statement

Operating a server through a terminal means turning a goal ("install Docker on this server") into many correct commands, watching their output, and judging whether each step worked. Developers already use AI CLIs (`claude`, `codex`) for this kind of work. In ssterm those tools can't see or act in the SSH session the user is looking at. The alternative is copying commands and output by hand between windows, which is slow and loses track of which server a command is for. Other AI clients the user runs (desktop assistants, IDEs) have no safe, controlled way to act in an ssterm session either.

## Solution

A connected SSH session gets an **AI Agent** button on the Terminals page. It opens a chat panel beside the terminal, bound to that session. The user talks to a main "DevOps Engineer" agent, which runs on the locally installed `claude` (or, once proven, `codex`) CLI. The main agent cannot run commands. It delegates tasks to sub agents, which act on the terminal only through ssterm's MCP tools. Every command appears live in the real terminal. Under the session's mode (Read only, Auto with plan approval, or Full allow) ssterm decides what may run, and PROD targets get extra gates. Password prompts are handed to the user. The main agent audits each task from ssterm's own record and reports back. The same MCP endpoint can be paired with other AI clients, which act under the same rules after the user binds them to a session.

## User Stories

1. As a DevOps engineer, I want an AI Agent button on a connected SSH session, so that I can ask for help with exactly that server.
2. As a user, I want the button to appear only once the session is Ready, so that the agent never acts on a half-open connection.
3. As a user, I want the agent chat beside the terminal, not over it, so that I can watch every command run.
4. As a user, I want the panel header to show the bound target and PROD badge, so that I always know which server the agent controls.
5. As a user, I want the panel to stay bound to its session when I switch tabs, so that the agent never moves to another server.
6. As a user, I want to enable the AI agent in Settings first, so that nothing is sent anywhere until I opt in.
7. As a user, I want the enable step to name the provider and list exactly what is sent, so that my consent is informed.
8. As a user, I want a persistent banner saying messages and output go to the provider, so that I don't forget data is leaving the Mac.
9. As a user, I want to pick `claude` or `codex` as the agent provider, so that I can use the CLI and account I already have.
10. As a user, I want a provider to be available only after ssterm has proven it can't touch my Mac, so that the agent works only on the server.
11. As a user, I want to tell the agent a goal in plain language, so that I don't have to write every command.
12. As a user, I want the main agent to ask when my request is ambiguous, so that it doesn't guess on a server.
13. As a user, I want the main agent to delegate the work to a sub agent and show it as a task card, so that I can follow what is happening.
14. As a user, I want the main agent to be unable to run commands itself, so that delegation and audit are real.
15. As a user, I want the main agent to summarize what was done from ssterm's record, so that its report matches what actually ran.
16. As a user, I want the agent never to claim success without an exit code, so that I can trust "done".
17. As a user, I want to expand a task card to see each command, exit code and output, so that I can audit it myself.
18. As a user, I want a session mode of Read only, Auto or Full allow, so that I choose how much the agent may do.
19. As a user, I want Read only to run only read-only commands and refuse the rest, so that I can let the agent investigate safely.
20. As a user, I want Auto to show me a plan (goal and commands) to approve once, so that I don't approve every line but stay in control.
21. As a user, I want any command outside the approved plan to ask me first, so that the agent can't drift.
22. As a user, I want Full allow to be an explicit per-session opt-in with a warning that resets for new sessions, so that full autonomy is never sticky.
23. As a user, I want plan approval on PROD to need an extra confirmation, so that production changes are deliberate.
24. As a user, I want Full allow on PROD unavailable unless I first enable it in Settings, so that production autonomy is a considered choice.
25. As a user, I want the UI to say the read-only classification is best effort, so that I don't over-trust it.
26. As a user, I want commands with redirects, chaining or subshells treated as not read-only, so that the classification fails safe.
27. As a user, I want each agent command typed into my real shell, so that `cd` and environment carry over and I see it live.
28. As a user, I want my keystrokes held while an agent command runs, so that my typing doesn't corrupt it.
29. As a user, I want Ctrl+C and a Stop button to interrupt the agent's command, so that I can stop anything at once.
30. As a user, I want full-screen programs refused for the agent, so that it can't get stuck in vim or top.
31. As a user, I want a per-command timeout that sends Ctrl+C, so that a hung command doesn't block the session forever.
32. As a user, when a command asks for a password, I want the agent to pause and ask me to type it in the terminal, so that my password never reaches the AI.
33. As a user, I want what I typed at a password prompt kept out of the agent's output, so that secrets never leave.
34. As a user, I want only the agent's own commands and their output sent, so that earlier scrollback and other sessions stay private.
35. As a user, I want output capped and marked when truncated, so that huge logs don't flood the provider.
36. As a user, I want the agent to be unable to reach my catalog, snippets or credentials at all, so that a misbehaving model can't leak them.
37. As a user, I want conversations kept only in memory and the CLI told not to save transcripts, so that no copy of server output is left on disk.
38. As a user, I want the conversation and agent to stop on lock, session end or quit, so that nothing keeps running unattended.
39. As a user, I want only one sub agent task to run per session at a time, with the rest queued, so that commands never interleave in one shell.
40. As a user, I want to cancel a task, so that I can stop work I no longer want.
41. As a user, I want to add my own extra instructions in Settings, so that the agent follows my conventions.
42. As a user, I want safety rules enforced by ssterm whatever the instructions say, so that a prompt can't bypass them.
43. As a user, I want to pair an external AI client (Claude Desktop, an IDE) with ssterm, so that I can use it on my sessions.
44. As a user, I want pairing to use a one-time token I approve by client name, so that unknown programs can't connect.
45. As a user, I want an external client to be unable to list my sessions, and to pick a session for it myself in ssterm, so that clients only see what I grant.
46. As a user, I want a banner naming the external client controlling a session, with Stop, so that I always know who is acting.
47. As a user, I want to see paired clients with last use and revoke any of them, so that I can withdraw access.
48. As a user, I want Lock workspace to drop every MCP connection and binding, so that a locked app can't be driven.
49. As a user, I want stdio-only clients to connect through a bundled bridge, so that common clients work without a network port.
50. As a user, I want external clients bound by the same mode, plan, PROD and password rules, so that every agent is held to the same standard.
51. As a user, I want the agent unavailable for local terminals and Team-managed hosts at first, so that the first release stays inside verified boundaries.
52. As a maintainer, I want each CLI version's isolation proven by an automated test, so that a CLI update that weakens isolation is caught.

## Implementation Decisions

- **Main process modules:**
  - **MCP server:** one server hosted in main. It owns the tool contract, authentication (ephemeral per-conversation credentials and paired client credentials), session binding and policy enforcement.
  - **Agent runner:** spawns and supervises CLI processes (main agent and sub agents). It applies isolation flags, an empty temporary working directory, an allowlisted environment and no session persistence, and maps CLI streaming output to chat events.
  - **Terminal executor:** given a bound SSH session, types a single-line command plus the nonce marker. It holds user input, detects completion and exit code from the marker, captures that command's output span (64 KiB tail), refuses alternate-screen programs, applies the timeout with Ctrl+C, and runs password-prompt detection and handoff.
  - **Policy:** mode per session (Read only / Auto / Full allow), plan store and approval, out-of-plan approval, PROD gates, the "Allow Full allow on PROD" setting and the read-only allowlist classifier.
  - **Task record:** ssterm's own record of every command attempted, run or refused, with exit code and truncated output. `get_task_status` and the task cards read from it.
- **Tool contract:**
  - Main agents get `delegate_task`, `get_task_status` and `cancel_task`.
  - Sub agents and external clients get `propose_plan`, `run_command`, `read_output` and `cancel`.
  - No tool exposes the catalog, other sessions, snippets or credentials.
- **IPC to renderer:** new validated, owner-checked channels to open, close and query agent panels and to stream chat/task/approval events. It also carries approval decisions (plan, out-of-plan command, PROD, Full allow), password-handoff state and external-client binding requests. The renderer never talks to the CLI or the MCP socket directly.
- **Settings additions:**
  - AI Agent enable with consent, and a provider choice limited to verified providers.
  - Allow Full allow on PROD, the command timeout and additional instructions.
  - External MCP: off by default; pair, list, revoke.
  - Settings are stored in a versioned allowlist extension of app settings. The paired-client credentials are stored in Keychain.
- **UI:**
  - AI Agent button on Ready SSH panes.
  - A non-modal resizable right panel on Terminals (ADR 0009 exception to the ADR 0008 drawer contract), holding the chat, plan/approval/PROD/Full-allow/password cards and task cards with an expandable record.
  - Pane banners for "Agent running" and the controlling external client, with Stop.
  - A drawer for binding an external client to a session.
- **Lifecycle:** lock, session end, panel close and quit terminate CLI processes, drop MCP connections and bindings, clear conversations and refuse pending tool calls. Generation fencing rejects stale tool calls after a reconnect.
- **Bundled artifacts:** versioned main-agent and sub-agent instructions; the `ssterm-mcp` stdio bridge, packaged and signed with the app.
- **No schema migration** for catalog data. Agent settings use the settings allowlist extension, and nothing conversation-related is persisted.

## Testing Decisions

- **Good tests** assert observable behaviour at the highest seam. That means bytes the SSH fixture received, commands that did or did not run, what was returned to the client, what the user sees, and which processes and sockets exist. Implementation internals are not asserted.
- **CLI isolation (first ticket, gating):** run the real installed `claude` and `codex` headless with the production flags against a test MCP server. Ask them to read a local file, run a local shell, use web tools and call a non-ssterm MCP server, and prove every attempt is refused. Prove no transcript is written to disk. The results are recorded per CLI version; providers that fail stay disabled.
- **Main-side unit tests:** policy (modes, plan matching, out-of-plan, PROD gates, Full-allow-on-PROD setting, read-only classifier fixtures including adversarial chaining/redirect/subshell cases); marker parsing with nonce spoofing; output capping; password-prompt detection; MCP auth (per-conversation and paired credentials, revocation, lock); tool contract scoping (main vs sub vs external); IPC validation as in the app-lock tests.
- **E2E (Playwright Electron, development and packaged) on the owned Docker OpenSSH fixture:**
  - Use a **fake MCP-speaking agent CLI** standing in for the provider, so tests are deterministic and send nothing externally. Real-CLI runs are limited to the isolation spike.
  - Cover:
    - the panel and button visibility rules;
    - consent gating;
    - delegate → plan approval → commands visible in the pane → audit summary;
    - Read only refusal;
    - out-of-plan approval;
    - PROD gates and the Full allow setting;
    - the password handoff with no password in agent output;
    - input hold and Ctrl+C/Stop;
    - timeout;
    - lock and session end cleanup;
    - external client pairing, binding, revoke and banner through the stdio bridge;
    - no external network requests made by ssterm itself.
- **Prior art:** `app-lock.spec.ts` (IPC/owner validation, lock races, live work), `snippet-run.spec.ts` (captured target, main-recorded writes, PROD confirm), `workspace-tools.spec.ts` (explicit multi-target sends), `recording.spec.ts` (plaintext scans), `terminal-input.spec.ts` (input routing), and unit tests for app-lock and bridge guards.

## Out of Scope

- Local terminals and Team-managed hosts.
- Conversation history or persistence.
- Provider API keys or SDKs inside ssterm (the user's own CLI holds the account).
- Automatic redaction.
- TCP or network-reachable MCP.
- Remote or multi-user MCP clients.
- Agents acting on SFTP, tunnels, templates or the catalog.
- Running more than one sub agent per session at the same time.
- Model selection beyond what the CLI provides.
- Mobile.

## Further Notes

- Implementation needs a separate explicit authorization (A13), and the isolation spike must pass before any provider is enabled.
- CLI flags were observed on `claude` 2.1.309 and `codex-cli` 0.163.0 on 2026-10-23. They are inputs to the spike, not verified guarantees.
- Delivery must update [AI scope](../ai-scope.md), AGENTS.md (network and AI rules), privacy notes and ADR 0009's status.
