# 06: Codex and custom CLI providers

**What to build:** `codex`, and any user-defined CLI provider (command, args template, MCP config shape, local-tool disable flags), can be selected once it passes the isolation check from 01. The same agent flow then works through it.

**Blocked by:** 01, 03

**Status:** ready-for-agent (authorized 2026-10-23)

- [ ] `codex` is selectable only if its version passed 01. Otherwise Settings explains why it is unavailable.
- [ ] Settings has a Custom CLI provider definition. The isolation check runs before first use and is re-run when the CLI version changes; a failing provider stays disabled.
- [ ] The agent flow from 03 passes with the fake CLI, configured as a custom provider.
