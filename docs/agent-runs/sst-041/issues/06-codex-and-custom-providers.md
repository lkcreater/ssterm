# 06: Codex and custom CLI providers

**What to build:** `codex`, and any user-defined CLI provider (command, args template, MCP config shape, local-tool disable flags), can be selected once it passes the isolation check from 01. The same agent flow then works through it.

**Blocked by:** 01, 03

**Status:** done

- [ ] `codex` is selectable only if its version passed 01. Otherwise Settings explains why it is unavailable.
- [ ] Settings has a Custom CLI provider definition. The isolation check runs before first use and is re-run when the CLI version changes; a failing provider stays disabled.
- [ ] The agent flow from 03 passes with the fake CLI, configured as a custom provider.

**Decision note (review L6, 2026-10-23):** Claude Code configured as a custom provider keeps claude's controls: the managed-policy refusal, claude's mandatory environment and the spike's isolation flags. It is checked against ssterm's local test endpoint only, never live-only. Its model, however, is the definition's own token. A custom definition can therefore run a model (for example `claude-opus-5-5`) that the built-in claude path refuses as unverified under A14. The custom isolation check verifies the CLI's local isolation with that exact definition. It does not run the model-specific live attack set. This is accepted as the user's explicit choice of a custom definition.
