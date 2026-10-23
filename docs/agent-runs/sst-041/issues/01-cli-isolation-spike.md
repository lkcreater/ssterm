# 01: CLI isolation spike

**What to build:** Prove, with the real installed `claude` and `codex`, that the headless invocation ssterm will use gets only ssterm's MCP tools. It must not be able to read local files, run a local shell, use web tools, reach the user's other MCP servers, hooks, plugins or project instructions, or write transcripts to disk. The result decides which providers can be enabled.

**Blocked by:** None (can start immediately)

**Status:** done (claude enabled; codex disabled)

- [ ] A repeatable automated check runs each installed CLI headless with the proposed production flags against a test MCP server.
- [ ] Asking the agent to read a local file, run a local shell command, fetch a URL, and call a non-ssterm MCP server is refused in every case, and the test fails if any succeeds.
- [ ] No transcript or session file is written (checked in the CLI's usual locations).
- [ ] An empty temporary working directory and an allowlisted environment are used, and the CLI still authenticates with the user's existing login.
- [ ] Results are recorded per CLI version (pass/fail per attack). A provider that fails stays disabled, and the gap is documented.
