# External MCP clients (SST-041/07)

ssterm can let an AI app on the same Mac, such as Claude Desktop or an IDE, use its terminal tools. The decisions are A7 and A8 in the [implementation plan](agent-runs/implementation-plan.md#ai-terminal-agent--grilling-decisions-2026-10-23-proposed-sst-041) and [ADR 0009](adr/0009-ai-terminal-agent-and-mcp.md).

## Behaviour

- **Off by default.** Settings › AI Agent › External MCP clients › "Allow external MCP clients". This is separate from the ssterm AI agent switch.
- **Transport.** The MCP endpoint in main listens on `<profile>/mcp/ssterm.sock`: a 0600 socket in a 0700 folder. No TCP port is opened. While external clients are on, the socket exists from launch. A lock drops every connection and then reopens the socket.
- **Pairing.**
  - "Pair new client" issues a one-time token. It lasts 5 minutes, only one is outstanding at a time, at most 5 can be issued per 10 minutes, and 5 wrong presentations burn it. The token is shown once, together with the client configuration.
  - On first start the client presents the token and its name. Names must be unique among paired clients (case-insensitive); a taken name is refused before anything is shown. An ssterm drawer asks the user to approve the name; Deny, or closing the drawer, burns the token.
  - On approval ssterm returns the client's own credential exactly once, over the socket. The credential is `<client id>_<256-bit secret>`. If it cannot be delivered (the connection closed, or the write failed), the new client is revoked at once.
  - A refused pairing or client credential is answered with one line `{"error":"pairing-refused" | "name-in-use" | "credential-rejected"}` before the connection closes, so the bridge can report it.
  - ssterm keeps only the SHA-256 verifier of the credential, in Keychain (`mcp-client/v1/<client id>`), and compares it in constant time. The client list (name, paired, last used, tool timeout) is `<profile>/mcp-clients.json` (0600).
  - Revoke first deletes the Keychain item, then rewrites the list. If the delete fails, the id stays in the list as `revoked` and the delete is retried at every launch. A listed client whose Keychain item is gone is dropped at launch. Either way a revoked client does not come back after a failed write. It can only come back if both the delete and the list write fail.
- **Binding.**
  - A client cannot list sessions or the catalog. Its tools are `propose_plan`, `run_command`, `read_output` and `cancel`.
  - The first `propose_plan` or `run_command` without a binding opens a drawer in every ssterm window: "<client> wants to control a terminal". The user picks a Ready SSH session of that window, or denies. Local terminals, Team-managed hosts and sessions already bound to another client are not offered.
  - A session has either an ssterm AI Agent conversation or an external binding, never both. The drawer does not offer, and main refuses, a session with an open conversation. AI Agent refuses an externally bound session until its binding is stopped.
  - Within one terminal, `read_output` and `cancel` answer only for commands started through the caller's own credential.
  - A binding lasts until the session generation ends, the user presses Stop, the workspace locks, the client is revoked or external clients are turned off. Then a new binding is needed. The credential survives a lock; it is not affected by anything except Revoke.
- **Rules.** Each binding starts in Auto. Read only, plans, per-command cards, PROD confirmation, Full allow (with "Allow Full allow on PROD" for PROD), password handoff and the 64 KiB output tail all apply exactly as for ssterm's own agents.
  - Cards appear in the agent panel when it is open on that session. Otherwise they appear in a non-modal "External MCP clients" panel, which reopens for each new card or binding.
  - A client's cards expire at the shorter of 5 minutes and its tool timeout minus 5 seconds. The tool timeout is 60 seconds by default and can be set per client from 10 to 3600. Clients that send a `progressToken` get progress notifications every 15 seconds while a call waits.
- **Visibility.** The bound pane shows "Controlled by <client> · <mode>" with Show and Stop. Settings lists clients with when they were paired and last used, and Revoke. Revoke disconnects the client, ends its binding and invalidates its credential.

## Client configuration

Settings shows the exact snippet with the real paths. For Claude Desktop it goes into `claude_desktop_config.json`. Any stdio MCP client takes the same command, arguments and environment:

```json
{
  "mcpServers": {
    "ssterm": {
      "command": "/bin/sh",
      "args": ["/Applications/ssterm.app/Contents/Resources/ssterm-mcp"],
      "env": {
        "SSTERM_MCP_SOCKET": "/Users/<you>/Library/Application Support/ssterm/mcp/ssterm.sock",
        "SSTERM_MCP_CREDENTIAL_FILE": "/Users/<you>/.config/ssterm-mcp/claude-desktop-<6 hex>.credential",
        "SSTERM_MCP_PAIRING_TOKEN": "<one-time token from Settings>",
        "SSTERM_MCP_CLIENT_NAME": "Claude Desktop"
      }
    }
  }
}
```

The bridge is the bundled POSIX `ssterm-mcp` script, which uses only `/bin/sh`, `cat` and `nc -U`. It is started through `/bin/sh` from wherever the app is installed. Secrets travel only in the environment or a file, never in argv.

- **First start.** While the credential file is missing, the bridge pairs with the token. It writes the credential to `SSTERM_MCP_CREDENTIAL_FILE` with mode 0600, in a folder it creates as 0700. Each pairing suggests a new file name (a random 6-hex suffix), so pairing again never picks up an old, revoked credential.
- **Later starts.** The bridge uses the file. The token can stay in the configuration; it cannot be used again.
- **The credential file belongs to the client.** It is the client's secret and its responsibility. ssterm cannot read or delete it; Revoke makes it useless. The socket only admits processes of the same macOS user.
- **Refusals.** A refused pairing (exit 69) or credential (exit 77; revoked, turned off or locked) is reported on stderr, and the bridge exits at once.
- **Disconnects.** When ssterm drops an established connection (revoke, lock, quit), the connection is closed on ssterm's side at once. macOS `nc` does not exit when the server closes the socket, though; measured on the test host, it ends only after the client's next write or two, or when the client closes stdin. Until then the client's requests go unanswered. The bridge's leftover `cat` and `nc` hold none of the client's output streams.
- **Locale.** The bridge checks bytes in the C locale (`LC_ALL=C`), so its name check means ASCII only, whatever the client's locale.

## Limits

- Any process running as the same user that obtains a credential file, or a pairing token before it is used, can act within a binding the user grants. This is the A8 accepted risk.
- Where a client sends commands and output is outside ssterm's control.
- The bridge accepts client names in ASCII only (letters, digits, spaces and `. _ ( ) + @ -`). Clients that talk to the socket directly may use Unicode letters.
