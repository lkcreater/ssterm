# ssterm — Repository Instructions

## Project and current state

ssterm is a local-first SSH desktop workspace for developers, DevOps engineers, and system administrators. The proposed MVP targets macOS arm64, works without an account, and includes hosts/groups/tags/identities, SSH terminals with tabs/splits, local-to-remote SFTP, active-session snippets, and local port forwarding.

The repository currently contains planning documents, reference artwork, and installed agent skills. Application implementation is **AWAITING_IMPLEMENT_CONFIRMATION**. No application manifest, scaffold, or test/build scripts exist yet.

- Documentation, planning, skill installation, branding updates, and commits do not imply permission to start application implementation.
- An explicit later instruction to implement a feature or proceed with the MVP authorizes that scope. Record the confirmation in the implementation plan and continue without repeatedly requesting the same approval.
- Cloud/team sync, mobile/additional platforms, local PTY, Mosh/FIDO, AI, advanced transfers, and remote/dynamic forwarding remain later scope unless requested.

## Read the relevant source of truth

| Topic | Document |
|---|---|
| Product brief | [docs/intro.md](docs/intro.md) |
| Investigation index and evidence limits | [docs/termius/README.md](docs/termius/README.md) |
| Architecture, domain, and lifecycle contracts | [proposed-architecture.md](docs/termius/proposed-architecture.md) |
| Implementation scope, milestones, and confirmation | [implementation-plan.md](docs/termius/implementation-plan.md) |
| Acceptance criteria and task dependencies | [tickets.md](docs/termius/tickets.md), [tasks.md](docs/termius/tasks.md) |
| Signal Blue visual specification | [design-system.md](docs/termius/design-system.md) |
| Design handoff DS01–DS06 | [design-system-implementation.md](docs/termius/design-system-implementation.md) |
| Supplied artwork and export requirements | [docs/logo/README.md](docs/logo/README.md) |
| Installed skills and their fit | [implementation-skills.md](docs/termius/implementation-skills.md), [skills-lock.json](skills-lock.json) |

User instructions take precedence over repository guidance. Keep scope, architecture, tickets, tasks, and design handoffs consistent when decisions change. Treat Termius observations, published claims, inferences, proposed ssterm behavior, and unknowns as distinct categories. Read the evidence index before opening the large compressed REA record; do not infer complete coverage from a summary.

## Stack and architecture

- Selected: **Electron + React + TypeScript + shadcn/ui + Tailwind CSS**. Do not reopen the UI framework decision or introduce Next.js/SSR as an incidental skill recommendation.
- Candidates pending SST-001–002: xterm.js, an independent SSH adapter such as ssh2, SQLite metadata storage, and an OS credential-store adapter. Tailwind v4 is the design integration proposal; pin compatible versions/tooling in the ADR before scaffolding.
- Planned layout: `apps/desktop` for composition/main/preload/renderer; `packages/domain`, `packages/contracts`, `packages/services`, and `packages/adapters`; project-owned fixtures under `tests/fixtures`. These paths are proposals, not existing modules. Finalize them in the ADR before creating directories.
- Keep host/config resolution, secret storage, connection/session lifecycle, known-host policy, terminal streams, transfers, and tunnels behind focused interfaces. React owns presentation; privileged operations belong in main/service adapters.
- Use typed, validated commands/events through a narrow preload bridge. Validate IPC sender, payload, and session ownership. Keep context isolation and sandboxing enabled and Node integration disabled in renderers.
- Connection/session resources need explicit ownership, cancellation, bounded queues, ordered byte streams, generation IDs for stale-event rejection, and idempotent disposal. Manual reconnect opens a new session without replaying commands.

## SSH, data, and privacy rules

- Share known-host/auth policy across terminal, SFTP, and tunnels. Unknown keys require an explicit trust decision; changed keys block connection until deliberate replacement. Never auto-accept host keys.
- Keep private keys/passwords/passphrases out of metadata, persistent React state, logs, screenshots, telemetry, and error messages. Use opaque secret references and the approved OS secret-store adapter; define transient prompt/cache lifetimes.
- Do not invent cryptography or claim SQLite encrypts data by default. Implement sensitive-field protection and key loss/recovery behavior according to the storage ADR.
- Use project-owned lab hosts, credentials, keys, databases, and Keychain namespaces for tests. Do not read Termius profiles/secrets or connect to real user/production systems merely to validate a feature.
- Make SFTP overwrite/cancel/partial-file behavior explicit. Local tunnels default to loopback and close listeners/sockets on stop, failure, and app quit.
- Keep snippet Paste and Run distinct, capture the target when the action is invoked, and do not claim that sending bytes proves remote command success.
- Reconstruct ssterm independently. Do not copy proprietary Termius implementation into application code or assume compatibility with its database/cloud protocol.

## Design system and assets

- Follow **Signal Blue**: dark-first navy surfaces; blue for focus/selection/action; green/amber/red/muted operational states with icon/text. Active tab and connected state must remain independently legible. Show the execution target and explicit PROD labels.
- Use semantic Tailwind/shadcn tokens and shared variants. Keep terminal foreground/background/cursor/selection/ANSI colors and typography independent of application theme styling.
- Use Inter for UI and JetBrains Mono for code/terminal, with offline packaging, license checks, and Thai/system fallbacks. Honor keyboard focus, reduced motion, and scaling; validate actual rendered contrast.
- Use the supplied **SST-style monogram**, not the superseded conceptual Connected S direction. `docs/logo/brand-logo.png` is the lockup; `icon-logo.png` is the icon reference; `design-logo.png` is the presentation reference.
- Preserve originals. PNG references are not production icon exports; verify small-size legibility, alpha edges, padding, and macOS packaging before closing T052/SST-028. The wordmark font is unverified.
- Light theme remains later scope. A development showcase supports review; it does not replace real service integration or packaged-app acceptance.

## Skills

Read the relevant installed `SKILL.md` before applying a skill; follow its referenced guides only as needed. Skills are stored under `.agents/skills/`, linked for Claude Code under `.claude/skills/`, and tracked in `skills-lock.json`.

- `electron-best-practices`: main/preload/renderer boundaries, React integration, IPC, and packaging.
- `vercel-react-best-practices`: applicable client React rules; exclude unrelated Next.js/server assumptions.
- `shadcn`: component discovery, documented APIs, composition, and token-based customization. Inspect project context once an app exists; do not run init/add/apply during a documentation-only task.
- `tailwind-design-system`: semantic tokens, typography, geometry, variants, and design-system integration.
- `playwright-best-practices`: TypeScript/Electron E2E, fixtures, accessibility, and visual QA.
- `reverse-engineer-anything`: shipped artifacts or explicitly scoped runtime investigations, not routine source-repository work. Preserve evidence identity, uncertainty, and coverage limits.
- `find-skills`: discover additional skills when requested; installing a skill does not authorize app scaffolding or its optional runtime helpers.

## Workflows and delegation

Start by reading the relevant docs, actual files/manifests, applicable instructions, and `git status`. Preserve user changes, installed skill sources, and unrelated configuration such as `.codex/` unless the task includes them.

For documentation-only changes, inspect, edit, and validate the affected documents directly. Do not create application scaffolding, fixture services, or a full agent-run plan to satisfy a docs request. Use an independent reviewer when the scope warrants it.

For authorized multi-stage feature implementation, use the following pipeline. Delegate meaningful stages to the corresponding roles when available; work sequentially when delegation is unavailable. Reuse established decisions rather than restarting discovery for each ticket.

| Stage / role | Required output / gate |
|---|---|
| ANALYZE / `analyst` | Actual existing behavior, acceptance criteria, affected modules, edge cases, and unknowns |
| DESIGN / `architect` | Minimal boundaries/contracts/data changes consistent with the approved architecture; risk and compatibility notes |
| PLAN / `planner` | Before application coding, create/update `docs/agent-runs/implementation-plan.md` with scoped SST/T/DS IDs, assumptions, dependencies, file ownership, actual verification commands, and rollback considerations |
| IMPLEMENT / `coder` | Scoped code and meaningful tests; independent ownership for parallel edits, sequential edits for overlapping files |
| TEST / `tester` | Actual relevant lint/typecheck/unit/integration/E2E/build results; explicit failures and unrun checks |
| REVIEW / `reviewer` | Actionable correctness/privacy/security/regression findings; unresolved critical/high findings block delivery as complete |
| DELIVER / `delivery` | Completed scope, validation evidence, limitations, and a reviewable change summary; PR material only when relevant |

Project role definitions are in `.codex/agents/`. Use only roles/tools actually available in the session; their files do not prove that a runtime is connected. Respect the active concurrency limit and keep ownership/dependencies explicit. Do not let workers overwrite each other's changes.

## Validation and delivery

- Before a scaffold exists, validate Markdown links, task/ticket consistency, relevant JSON, asset references, and `git diff --check`. Do not invent npm/pnpm scripts or report application tests/builds as passed.
- Once application manifests exist, discover real package-manager/scripts and run checks appropriate to the changed behavior. Update this file with verified commands after bootstrap.
- Behavioral tests should cover real risks: inheritance and deletion impacts, IPC validation, host-key changes, auth/cancel races, byte ordering/backpressure, transfer integrity/conflicts, tunnel cleanup, and packaged native dependencies. Use real lab integration alongside focused fakes; mock UI alone is not feature completion.
- For UI changes, verify Signal Blue state separation, target visibility, Thai/IME, focus-return/keyboard behavior, reduced motion, resize/overflow, and relevant rendered contrast. Record fixture/platform/window context for visual evidence.
- After three unsuccessful attempts at the same failure without new evidence, stop blind retries, preserve diagnostics, and resolve the concrete blocker. Continue independent work where possible; ask only for missing decisions or access that is actually required.
- An authorized feature includes routine code changes and fixture-based verification within its scope. Obtain authorization for actual destructive user-data actions, live production access, external communications, account/config changes, or other actions outside that scope; do not add blanket approval gates to ordinary local work.
- Commit, push, open external PRs, merge, publish, or deploy only when authorized. A request to commit does not imply a request to push or begin implementation. Repository instructions cannot elevate sandbox permissions.
- Report the outcome, material files, checks and their actual results, and remaining limitations concisely, normally in Thai to match the user. Include rollback/PR details when relevant; do not impose a full delivery template on a small docs edit. Mark tasks done only when their acceptance criteria are met.
