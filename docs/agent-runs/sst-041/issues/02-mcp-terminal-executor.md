# 02: MCP server and terminal executor (Read only)

**What to build:** An MCP client authenticated to ssterm and bound to a Ready SSH session can call `run_command` in Read only mode. The command is typed into the visible pane, its completion and exit code come from the nonce marker, and only that command's output (64 KiB tail) is returned. Non-read-only commands are refused.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent (implementation not yet authorized: A13)

- [ ] The MCP server runs in main with a per-conversation ephemeral credential; unauthenticated or stale calls are refused.
- [ ] `run_command` types one line plus the nonce marker into the bound pane; completion and exit code come from the marker; a spoofed marker without the nonce is ignored.
- [ ] Only the command's output span is returned, capped at 64 KiB (tail) with a truncation marker. Prior scrollback and user input are never included.
- [ ] User keystrokes to that pane are held while the command runs. Ctrl+C and Stop interrupt it, and a banner shows the running command.
- [ ] Alternate-screen programs are refused. The timeout sends Ctrl+C.
- [ ] The Read only allowlist classifier refuses chaining, redirects, subshells and heredocs (adversarial unit fixtures).
- [ ] Generation fencing works: after a reconnect, a call for the old generation is refused.
- [ ] E2E on the Docker OpenSSH fixture uses a test MCP client: bytes received, exit codes, refusals, input hold and timeout.
