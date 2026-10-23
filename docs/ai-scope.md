# AI scope: privacy specification (SST-034, updated by SST-041)

This document was written in SST-034 as the privacy specification any AI feature must satisfy before it is built. SST-041 delivered one such feature, the opt-in [AI agent](ai-agent.md) with its MCP endpoint ([ADR 0009](adr/0009-ai-terminal-agent-and-mcp.md), Accepted 2026-10-23). This file now records what that feature sends and how it meets each precondition. Any further AI feature still needs its own authorization against the same preconditions.

## Current state

- **No provider SDK, API key or AI network client in ssterm.** ssterm holds no provider account or credential, and its own processes make no AI network request. The agent runs through the user's own installed CLI: `claude` 2.1.309, or a custom CLI provider that passed ssterm's isolation check. That CLI contacts its provider (Anthropic for `claude`) under the user's own account, retention and training terms. `codex` has an adapter, but it stays disabled because no version passed the isolation check.
- **Off by default.** Settings › AI Agent turns the agent on only after the user acknowledges a versioned disclosure that names the provider and lists exactly what is sent. External MCP clients have their own separate switch, also off by default.
- **What the CLI sends to its provider, per conversation:**
  - the user's chat messages and the agent's replies;
  - each command the agent runs and that command's output only: the span between ssterm's start and done markers, as the last 64 KiB with truncation marked. Nothing is redacted;
  - the bound session's label, `user@host:port` and environment, and the user's additional instructions (both in the system prompt);
  - what the CLI adds itself. For `claude` this is the temporary working-folder path, macOS version, platform, shell, model, date, CLI version and the signed-in account email. ssterm cannot see what a custom CLI adds.
- **What ssterm never makes available to the agent:** earlier scrollback, what the user types in the terminal (including password entries, see below), other sessions, the catalog, snippet bodies, recordings and history, credentials, keys and vault material. The MCP tools have no way to reach these: they act on one bound session only.
- **Local endpoints:**
  - the MCP Unix socket `<profile>/mcp/ssterm.sock` (0600, 0700 folder), with no TCP port;
  - for a custom provider's isolation check only, a temporary loopback HTTP endpoint (`127.0.0.1`, random port) that stands in for the provider, and a temporary check socket.
  - E2E suites assert that the renderer makes no external request and that main opens no TCP listener. The claim that main has no AI client rests on the code: there is no provider SDK, API key or provider endpoint in it.
- **Persistence:** conversations are kept in memory only. CLI transcripts are disabled, and the run folders and CLI residue that name a run are removed. [Session logs and command history](recording.md) are still local, opt-in, encrypted and never transmitted; the agent cannot read them.
- **Other app-managed network connections** are unchanged: SSH, Google only when the user signs in with Google ([ADR 0004](adr/0004-local-app-lock.md)), and the self-hosted sync endpoint only through opt-in sync actions.

## Data classes

| Class | Sensitivity | AI agent (SST-041) |
|---|---|---|
| Terminal output | can contain displayed secrets, customer data, internal hostnames | **sent:** only the output of commands the agent runs (64 KiB tail each); never earlier scrollback |
| Command history | can contain paths, hostnames, partial credentials | ssterm's encrypted history is never sent. On the server, shell history files can be read by allowlisted read-only commands such as `cat`, even in Read only mode, and that output is sent |
| Snippet bodies | encrypted at rest; user-authored scripts | never sent |
| Catalog metadata (labels, addresses, usernames, environments) | sensitive infrastructure inventory | **sent:** only the bound session's label, `user@host:port` and environment |
| Credentials, keys, passphrases, vault keys | secret | ssterm's own secrets are not reachable by any AI component. Key or secret files **on the server** can be read by allowlisted read-only commands (e.g. `cat`), and that output is sent |
| Typed input | can be a password at a no-echo prompt | never sent; a password entry that shows up in output causes that whole output to be withheld |

## Preconditions and how SST-041 meets them

1. **Separate explicit authorization** of the feature, its provider and its data flow.
   *Met:* decisions A1–A14 and the authorizations for tickets 01–08 are recorded in the [implementation plan](agent-runs/implementation-plan.md#ai-terminal-agent--grilling-decisions-2026-10-23-proposed-sst-041).
2. **Provider decision and review:** named provider, data residency, retention and training terms, sub-processors, and whether a local/offline model can serve the need.
   *Met in part:* the provider is the user's own CLI account (A3, A5). ssterm discloses that the account's retention and training terms apply, and that it cannot change them. ssterm did not review those terms itself, and it offers no local model.
3. **Consent per use:** off by default; the user sees exactly which text leaves the Mac, to whom; PROD targets require an extra confirmation.
   *Met as a narrowly scoped standing consent (A3):* a versioned disclosure must be acknowledged before enabling, a provider banner is shown in every agent panel, and every command runs visibly in the pane. PROD needs an extra step to approve plans and commands, and Full allow on PROD is off unless enabled in Settings (A2).
4. **Minimization and redaction:** smallest selection; redaction is best effort and must be described as such; credentials and vault material structurally unreachable.
   *Met by minimization, without redaction:* only the agent's own commands and their 64 KiB tails are sent, and the disclosure says plainly that nothing is redacted. Credentials are unreachable by construction. Password entries are excluded from the agent's input path, and output containing one is withheld (A4, ticket 05).
5. **Cost and quota:** visible cost model, user-controlled limits, no background requests.
   *Met in part:* the provider bills the user's own CLI account, and ssterm shows no cost figure. Requests happen only when the user sends a message, or when sub agents work on a task the main agent delegated in that conversation. Hard limits: one sub agent per session, at most 8 open tasks and 64 steps per task, and 8 conversations. Closing the panel or pressing Stop ends the work. A custom provider's live check sends two synthetic prompts, only after explicit consent.
6. **No execution:** model output is never run automatically.
   *Replaced (ADR 0009):* commands run under the session mode. Read only runs allowlisted commands only. Auto runs a plan the user approved, or a command the user approved. Full allow is an explicit per-conversation opt-in behind a warning. Every command is visible in the pane, the user can Stop it or press Ctrl+C, and success is judged only from the exit code.
7. **Verification:** tests prove nothing is sent without consent, redaction fixtures, lock/disable purge, and a reviewable list of every endpoint contacted.
   *Met:* the [CLI isolation spike](spikes/ai-cli-isolation.md) proves local tools, user configuration and transcripts are off. Unit tests cover the policy, markers, password withholding, MCP auth and IPC. E2E with a fake CLI asserts consent gating, lock and session-end cleanup, and that the renderer makes no external request and main opens no TCP listener; main's outbound connections are not observed by tests. Endpoints are listed above and in [AI agent › Privacy notes](ai-agent.md#privacy-notes).
8. **Documentation:** this file, the README and the privacy notes updated with the exact data flow before release.
   *Met:* this file, [AI agent](ai-agent.md) (which carries the privacy notes), [external MCP clients](agent-external-clients.md) and ADR 0009. The README links to them.

## Out of scope

- Provider API keys or SDKs inside ssterm.
- Automatic redaction.
- Cloud processing of logs or history.
- Agents for local terminals, Team-managed hosts, SFTP, tunnels, templates or the catalog.
- Conversation history.
