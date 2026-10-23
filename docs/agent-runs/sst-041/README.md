# SST-041 tickets

Tickets from the [spec](../sst-041-spec.md) and [ADR 0009](../../adr/0009-ai-terminal-agent-and-mcp.md). **Implementation has not been authorized** (decision A13). Once it is, take any ticket whose blockers are done. Ticket 01 gates every provider.

| # | Ticket | Blocked by |
|---|---|---|
| 01 | [CLI isolation spike](issues/01-cli-isolation-spike.md) | None |
| 02 | [MCP server and terminal executor (Read only)](issues/02-mcp-terminal-executor.md) | None |
| 03 | [Agent panel with main agent and delegated tasks](issues/03-agent-panel-delegation.md) | 01, 02 |
| 04 | [Modes, plan approval and PROD gates](issues/04-modes-plans-prod.md) | 03 |
| 05 | [Password prompt handoff](issues/05-password-handoff.md) | 03 |
| 06 | [Codex and custom CLI providers](issues/06-codex-and-custom-providers.md) | 01, 03 |
| 07 | [External MCP clients: pairing, binding, bridge](issues/07-external-mcp-clients.md) | 02, 04 |
| 08 | [Docs, privacy notes and release gates](issues/08-docs-gates-delivery.md) | 02, 03, 04, 05, 06, 07 |
