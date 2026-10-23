# 08: Docs, privacy notes and release gates

**What to build:** Docs describe the shipped behaviour and data flow. ADR 0009 is Accepted, AI scope is updated, and the full development and packaged gates pass.

**Blocked by:** 02, 03, 04, 05, 06, 07

**Status:** done (2026-10-23; [delivery](../../sst-041-delivery.md))

- [x] ADR 0009 is marked Accepted. `docs/ai-scope.md` describes the actual data flow and endpoints. AGENTS.md network and AI rules are updated, and a new behaviour doc is written.
- [x] Privacy notes list every process and endpoint involved (the user's CLI provider; no ssterm network contact).
- [x] typecheck, unit, build, full E2E, package and packaged suites pass. The CLI isolation check is re-run on the installed versions.
- [x] A delivery record with limitations, the manual checks still pending and rollback.
