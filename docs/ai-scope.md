# AI scope: privacy specification only (SST-034)

> **2026-10-23:** a proposed AI terminal agent with an MCP endpoint is specified in [ADR 0009](adr/0009-ai-terminal-agent-and-mcp.md) (SST-041, status Proposed, implementation **not** authorized). Until it is authorized and delivered, everything below remains true of the shipped app.

ssterm contains **no AI feature, no AI provider and no code that sends terminal data anywhere**. This document is the privacy and scope specification any future AI feature must satisfy before implementation is authorized. It is not a plan to build one.

## Current state

- No model, provider SDK, API key field or network client for AI exists in the app. Static unit checks assert that the recording modules import no network module.
- App-managed network connections are limited to SSH and, only when the user signs in with Google, Google ([ADR 0004](adr/0004-local-app-lock.md)). E2E suites assert that the app makes no other external request.
- [Session logs and command history](recording.md) are local, opt-in, encrypted and never transmitted.

## Data classes a future feature could touch

| Class | Sensitivity | Default for any AI feature |
|---|---|---|
| Terminal output (live or session logs) | can contain displayed secrets, customer data, internal hostnames | never sent |
| Command history | can contain paths, hostnames, partial credentials the heuristic missed | never sent |
| Snippet bodies | encrypted at rest; user-authored scripts | never sent |
| Catalog metadata (labels, addresses, usernames, environments) | sensitive infrastructure inventory | never sent |
| Credentials, keys, passphrases, vault keys | secret | never sent, never readable by any AI component |
| Typed input | can be a password at a no-echo prompt | never captured, never sent |

## Preconditions before any AI feature

1. **Separate explicit authorization** of the feature, its provider and its data flow (recorded in the implementation plan); this specification does not authorize it.
2. **Provider decision and review:** named provider, data residency, retention and training terms, sub-processors, and whether a local/offline model can serve the need.
3. **Consent per use:** off by default; the user sees exactly which text leaves the Mac, to whom, before each send (or explicitly opts into a narrowly scoped standing consent); PROD targets require an extra confirmation.
4. **Minimization and redaction:** send the smallest selection the user chose, never whole logs or history by default; redaction is best effort and must be described as such; credentials and vault material are structurally unreachable from the AI component.
5. **Cost and quota:** visible cost model, user-controlled limits, no background requests.
6. **No execution:** model output is never run automatically; inserting a suggestion follows the same rule as ⌘; (insert only, never Enter, controls refused) and states that it is generated, not verified.
7. **Verification:** tests prove nothing is sent without consent (external-request assertions), redaction fixtures, lock/disable purge, and a reviewable list of every endpoint contacted.
8. **Documentation:** this file, the README and the privacy notes updated with the exact data flow before release.

## Out of scope here

Building, prototyping or spiking an AI integration; storing provider credentials; any cloud processing of logs or history.
