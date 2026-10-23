# SST-041 — AI terminal agent and MCP endpoint

Status: delivered through per-ticket TEST/independent REVIEW and the final automated gates below. Tickets 01–07 and SST-042 are committed locally; ticket 08 (this record, the docs and the local-pty fix found while investigating the unit hang) is ready for its local commit. No push, PR, publishing or deployment.

Sources: [spec](sst-041-spec.md), [ADR 0009](../adr/0009-ai-terminal-agent-and-mcp.md) (Accepted with this delivery), [decisions A1–A14 and per-ticket records](implementation-plan.md#ai-terminal-agent--grilling-decisions-2026-10-23-proposed-sst-041), [tickets](sst-041/README.md), [CLI isolation spike](../spikes/ai-cli-isolation.md). Behaviour: [AI agent](../ai-agent.md) (with the privacy notes), [external MCP clients](../agent-external-clients.md), [AI scope](../ai-scope.md).

## Scope delivered

`git log --oneline 1d95311..HEAD` (`1d95311` is the spec commit):

| # | Commit | Delivered |
|---|---|---|
| — | `1d95311` | Spec, ADR 0009 (Proposed), 8-ticket breakdown |
| 01 | `ad6918b` | Isolated CLI isolation spike (`spikes/ai-cli-isolation`): claude 2.1.309 passes the tested modes; codex 0.163.0 fails and stays disabled |
| 02 | `17ef4f2` | MCP server in main (hand-written JSON-RPC, 0600 Unix socket, no TCP); terminal executor (ready probe, nonce markers, 64 KiB tail, input hold, alternate-screen refusal, timeout with Ctrl+C); Read-only classifier |
| 03 | `d1ad7af` | Settings › AI Agent (off by default, versioned consent, disclosure, A14 model/effort); AI Agent panel; main agent with delegate tools only; sub agents with terminal tools; production claude spawn (real binary, version gate, managed-policy refusal, allowlisted env, stream-json over stdin, isolation detector, residue cleanup); bundled `ssterm-mcp` bridge |
| 04 | `5b4a5f8` | Read only / Auto / Full allow modes, `propose_plan`, plan and per-command cards, PROD step, "Allow Full allow on PROD" |
| 05 | `69023bd` | Password handoff (simple command + listed program only, `</dev/null` for read-only steps, line-edited entries, output withholding, pre-probe refusal) |
| 06 | `2d08f58` | codex adapter (statically disabled); custom CLI providers with a fingerprint-bound isolation check (loopback stand-in endpoint, or a consented live check); Opus 5.5 verified by user decision |
| SST-042 | `09a7c58` | Google sign-in callback page restyled (Charcoal v2, inline logo, Close button, strict CSP); malformed request line now answers 404 instead of throwing |
| 07 | `22cb70c` | External MCP clients: pairing, Keychain verifiers, bind drawer, banner and Stop, Revoke, lock drop; one owner per session (conversation or binding) |
| 08 | (this change) | ADR 0009 Accepted, AI scope rewritten, new [AI agent](../ai-agent.md) behaviour and privacy doc, AGENTS.md network/AI rules and seams, README line, local-pty dispose fix (unit hang root cause) with a regression test and bounded test timeouts, final gates |

## Decisions (recorded in the plan; not re-decided)

- **A1/A2:** plan-level approval with per-session modes Read only / Auto / Full allow; PROD needs an extra step, and Full allow on PROD needs a Settings opt-in.
- **A3:** consented, minimized data; the 64 KiB tail; no redaction claim.
- **A4:** password prompts are handed to the user.
- **A5:** ssterm owns orchestration (main agent delegates only).
- **A6:** CLI local isolation, proven per version.
- **A7/A8:** one MCP server; external clients pair and are bound by the user over a Unix socket.
- **A9:** commands typed into the visible shell with nonce markers.
- **A10:** non-modal right panel (an ADR 0008 exception); Ready SSH only.
- **A11:** no persistence.
- **A12:** bundled, versioned instructions plus user additions; ssterm's own record is the audit; one sub agent per session.
- **A13:** spec first, then authorization: tickets 01–02, then "เสร็จ 02 ทำต่อให้จบ" for 03–08.
- **A14:** bundled model lists with effort. The claude default is `claude-opus-5-5` at `xhigh`, verified by user decision ("ก").

## Review findings fixed (real security and correctness issues)

- **Read-only classifier verb confusion and writing options (02, H1/H2, review first BLOCKED):** option values could smuggle a verb past the allowlist (`docker`, `systemctl`), and writing options passed as reads (`ss -D`, `journalctl --cursor-file`, `date` operands). Option parsing is now per command, with path checks; `..` and device paths are refused (M1).
- **Lock and approval races (04, M1):** a pending plan or command card could outlive its cancelled MCP call or closed socket and type the command later. Each card is now bound to its request: abort, socket close, lock or session end withdraw it, and nothing is typed. Approval ids carry a per-conversation nonce (L4).
- **Redaction oracle → withholding (05, M1):** masking a typed password inside the output let the agent probe for it. The whole output is now withheld when a finished entry appears, which leaks at most one bit per entry.
- **Password phishing via echo (05, first review BLOCKED; M2):** any command could print a fake `Password:` prompt (`echo`, `printf`, `read`) and receive the user's entry, and the exclusion ended at the newline. A handoff now happens only for a simple command led by a listed prompting program. Read-only steps run with `</dev/null`. Any other prompt is refused, and the card names the command.
- **Claude Code configured as a custom provider (06, M1):** it could bypass the claude controls. It now keeps the install-path detection, the managed-policy refusal and the mandatory flags, refuses bypass flags, and never accepts a live-only check.
- **External client and agent sharing a session (07, M1):** an ssterm conversation and an external binding could act on the same session, and `read_output`/`cancel` answered across credentials. A session now has one owner, and the record is per credential.
- **Malformed callback request (SST-042):** `new URL()` threw on a malformed request line during the Google sign-in window. It now uses `URL.parse` and answers 404.
- **Not an SST-041 change:** the Lock workspace relock bypass was an SST-040 finding, recorded in the [SST-040 delivery](sst-040-delivery.md#review-findings-fixed-real-product-bugs).

The remaining review items (M2/M3 and L1–L9 in tickets 02–07: control characters, the step cap before running, normalized Full allow text, card expiry versus client timeouts, credential delivery, revoke markers, bridge exit codes and others) are listed per ticket in the plan.

## Ticket 08: local-pty unit hang

Symptom: `npm test` hung in `tests/unit/local-pty.test.ts`, "local PTY cancellation waits for actual in-flight native input before releasing the owned descriptor". It was seen in tickets 02 and 04 (one log: the file ran 614 s and ended with "Promise resolution is still pending but the event loop has already resolved"). This file is not touched by SST-041.

**Root cause (found):** a production bug in `packages/adapters/src/local-pty.ts`, not in the test.
- `dispose()` paused the PTY master (`native.pause()`) before stopping the owned processes. Output the shell produced after that point (here, the echo of the in-flight input) stayed unread in the PTY output queue.
- On macOS a process that exits blocks while closing its terminal until that queue drains. `ps` shows it in state `E`, and `SIGKILL` cannot finish it.
- The ownership stop therefore saw the guardian and its child alive (`?Es`/`?E`) through all three 3 s attempts and threw `local-process-cleanup-pending`. By design, the adapter then keeps the native permit and never resolves `drained`, and the test awaited `drained` without a bound.
- The 614 s hang is consistent with the kernel's drain wait eventually expiring.
- Whether it happened depended on a race: whether echoed bytes arrived after reading stopped.
- In production the same race could leave a closed local terminal's cleanup unconfirmed and its native permit (one of 32) held.

**Evidence:**
- Not reproducible in isolation: the test passed 30/30 alone, 8/8 for the whole file under a 14-process CPU load, and 3 concurrent full suites passed.
- Reproduced in full `npm test` runs: once in this ticket's first gate run, and once in 16 traced runs. That trace shows the two owned processes stuck in state `E` for the full stop budget, then `stop attempt 2 failed … local-process-cleanup-pending`.
- A new deterministic regression test pauses reading with an unacknowledged 1-byte window, echoes 4 KiB and then disposes. It stays `pending` for 20 s before the fix and drains in about 0.7 s after it.

**Fix:**
- `dispose()` now resumes reading and discards the output (the data listener is already removed), so exiting processes can finish.
- `tests/unit/local-pty.test.ts` gives every test and the fixture's cleanup hook a 60 s timeout, so any future unconfirmed cleanup fails fast instead of blocking the suite. The forced-failure check took 16 s with the timeouts and hung indefinitely without them.
- After the fix: 12/12 consecutive full `npm test` runs passed (861 passing each), plus the final gate run below.

## Validation

Final ticket-08 gates (macOS arm64, Node 24.11.1, Docker Desktop with `ssterm-ssh-fixture:m0` unchanged, 2026-10-23):

| Gate | Actual result |
|---|---|
| `npm run typecheck` | pass (the first ticket-08 run failed on the new test wrapper's types; fixed before the final runs) |
| `npm test` | 862 total / 861 passed / 1 skipped (Homebrew bash5 unavailable) / 0 failed. The first ticket-08 run, before the local-pty fix, had the local-pty test cancelled after 120 s, as described above |
| `npm run build` | pass |
| `npm run test:e2e` (full, development + showcase) | before the local-pty fix: 99/99 in 9.5 min. Final run after the fix: 98/99 in 9.5 min. The one failure, `app-lock.spec.ts:285`, came from a foreign keystroke: the Password field held an extra `.` the test never typed, so "The passwords do not match" appeared. `app-lock.spec.ts` rerun alone: 4/4 |
| `npm run package:mac` | pass; ad-hoc signed `SSTerm-darwin-arm64` (the existing "no `.icon` format" packager warning is unchanged) |
| `npm run test:packaged` | 97/97 in 8.9 min |
| `git diff --check` | clean; the relative Markdown links in the changed docs resolve |
| `spikes/ai-cli-isolation`: `npm ci --ignore-scripts`, `npm test` | 0 vulnerabilities, no dependencies; 10/10 offline detector tests |
| `spikes/ai-cli-isolation`: `npm run check:capture` (capture mode only, **no provider call**), installed `claude` 2.1.309 and `codex-cli` 0.163.0 | claude capture **pass** (verdict pass); codex capture **fail: user-instructions**, the same finding as ticket 01, so it stays disabled; persistence pass (18 changed paths scanned); claude metadata residue in `~/Library/Caches/claude-cli-nodejs` removed (1). The script exits 1 because codex fails, which is the expected result |

No owned fixture container remained after the runs. During the investigation an unrelated recorder unit test (`retention by size removes the oldest closed logs first`) failed once, under three concurrent full suites; it passed in every single-suite run.

Provider calls and cost:
- Ticket 01 made 29 synthetic calls (17 claude, 12 codex); claude cost about $0.0003 per call.
- The A14 model run made 5 claude calls, costing $0.0792.
- Ticket 08 made none: capture mode only.
- No terminal, catalog or user data was sent in any of them.

## Known limitations and residual risks

- **Same-user trust boundary (A8):**
  - any process running as the same macOS user that obtains a paired credential file, or an unused pairing token, can act within a binding the user grants;
  - such a process can also read a live run's `mcp.json` (0600, in a 0700 folder);
  - the socket admits only the same user.
- **Wrapper second prompts:** `sudo sh -c`, `su -c`, `ssh host 'cmd'`, git aliases and askpass helpers can show a second prompt that is still handed to the user. The warning naming the command is the control.
- **Bridge lingering:** after revoke or lock, macOS `nc` keeps an established external bridge alive until the client's next write or two. The server refuses at once.
- **Best-effort zeroing:** entry buffers are zeroed in main. Decoded JS strings and the PTY/kernel path cannot be.
- **Read-only classifier:** best effort, as the UI says.
- **Ready probe:** a stdin reader (`cat > file`) receives the probe text. A nested shell (`ssh host2`, `sudo -i`) answers it, and the command then runs in that shell.
- **Provider side:** retention, training and what the CLI adds follow the CLI account's terms. ssterm cannot see what a custom CLI sends.
- **Fixed command timeout:** 10 minutes; not a Settings option, which deviates from A9.
- **No cost display.** Model lists are bundled, not discovered.
- **Exclusions:** local terminals, Team-managed hosts, SFTP, tunnels, templates and the catalog are out of the agent's reach.
- **Version gate:** a claude update disables the agent until the isolation check is re-run for the new version and the version is added.

## Manual checks pending

- A live multi-turn stream-json conversation with the real `claude`: production uses stream-json over stdin, which the spike tested in capture mode only. E2E uses the fake CLI.
- codex: stays disabled until a codex version passes the isolation check (user `AGENTS.md`, `apply_patch`, sub-agent tools).
- Real external clients (Claude Desktop, IDEs) through the bundled bridge. E2E uses a test client over the same bridge.
- Earlier manual checks still pending: native Thai IME, VoiceOver, Developer ID signing and notarization (not authorized).

## Rollback

- **Code:** revert `22cb70c`, `2d08f58`, `69023bd`, `5b4a5f8`, `d1ad7af`, `17ef4f2` and `ad6918b` plus this ticket's docs commit, newest first. Keep or revert SST-042 (`09a7c58`) independently; it touches only the OAuth callback page. The ticket-08 local-pty fix is committed separately (`packages/adapters/src/local-pty.ts` plus its tests). It is independent of the agent, so keep it when reverting the rest.
- **Data:** no catalog schema change (schema 4); sync, Team and recording formats are unchanged. To remove the feature's local state:
  - `<profile>/agent-settings.json`;
  - `<profile>/mcp-clients.json` and the `<profile>/mcp/` folder;
  - the Keychain items `mcp-client/v1/<client id>` in the production namespace (one per paired client; Revoke deletes them while the feature exists);
  - stray `$TMPDIR/ssterm-agent-*` run folders and `/tmp/ssterm-check-*` check folders;
  - crash leftovers of the claude CLI tagged with a run: `~/Library/Caches/claude-cli-nodejs/*ssterm-agent-*` entries and `~/.claude/sessions/<pid>.json`/`.key` files naming an ssterm run folder;
  - each external client's own credential files under `~/.config/ssterm-mcp/`, owned by those clients.
- **Docs:** ADR 0009 back to Proposed; restore the previous AI scope and AGENTS.md wording.
