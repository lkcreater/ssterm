# ssterm — Repository Instructions

## Project and current state

ssterm is a local-first SSH desktop workspace for developers, DevOps engineers, and system administrators. The proposed MVP targets macOS arm64, works without an account, and includes hosts/groups/tags/identities, SSH terminals with tabs/splits, local-to-remote SFTP, active-session snippets, and local port forwarding.

SST-001–014 are delivered and committed. After SST-012 (`dba21d4`) the user instructed “ทำงานนี้เสร็จ commit -> ทำงานถัดไปต่อได้เลย -> loop จนจบ”: finish each ticket through independent TEST/REVIEW/DELIVER, commit locally, and continue with the next ticket through SST-028 (including DS04–DS06) without per-ticket approval; push/PR/publish/deploy are not authorized. Delivered terminal work: [stream/resize/exit](docs/terminal.md) and [input/Unicode/clipboard/links/search](docs/terminal-input.md), [flow control and budget](docs/terminal-flow.md); earlier: [auth prompts](docs/auth-prompts.md), [SSH auth](docs/ssh-auth.md), [known hosts](docs/known-hosts.md), [sessions](docs/sessions.md), [catalog](docs/catalog.md). See [execution record](docs/agent-runs/implementation-plan.md).

- Documentation, planning, skill installation, branding updates, and commits do not imply permission to start application implementation.
- An explicit later instruction to implement a feature or proceed with the MVP authorizes that scope. Record the confirmation in the implementation plan and continue without repeatedly requesting the same approval.
- Cloud/team sync, mobile/additional platforms, local PTY, Mosh/FIDO, AI, advanced transfers, and remote/dynamic forwarding remain later scope unless requested.

## Read the relevant source of truth

| Topic | Document |
|---|---|
| Product brief | [docs/intro.md](docs/intro.md) |
| Investigation index and evidence limits | [docs/termius/README.md](docs/termius/README.md) |
| Architecture, domain, and lifecycle contracts | [proposed-architecture.md](docs/termius/proposed-architecture.md), [domain-storage-spec.md](docs/termius/domain-storage-spec.md) |
| Implementation scope, milestones, and confirmation | [implementation-plan.md](docs/termius/implementation-plan.md) |
| Acceptance criteria and task dependencies | [tickets.md](docs/termius/tickets.md), [tasks.md](docs/termius/tasks.md) |
| Signal Blue visual specification | [design-system.md](docs/termius/design-system.md) |
| Design handoff DS01–DS06 | [design-system-implementation.md](docs/termius/design-system-implementation.md) |
| Supplied artwork and export requirements | [docs/logo/README.md](docs/logo/README.md) |
| Installed skills and their fit | [implementation-skills.md](docs/termius/implementation-skills.md), [skills-lock.json](skills-lock.json) |

User instructions take precedence over repository guidance. Keep scope, architecture, tickets, tasks, and design handoffs consistent when decisions change. Treat Termius observations, published claims, inferences, proposed ssterm behavior, and unknowns as distinct categories. Read the evidence index before opening the large compressed REA record; do not infer complete coverage from a summary.

## Stack and architecture

- Selected: **Electron + React + TypeScript + shadcn/ui + Tailwind CSS**. Do not reopen the UI framework decision or introduce Next.js/SSR as an incidental skill recommendation.
- Exact UI/tooling pins, Signal Blue/Base UI/nova/Lucide integration, candidate gates, app IDs, and packaging approach are recorded in [ADR 0001](docs/adr/0001-mvp-platform-stack.md). Its temporary npm metadata resolution is not runtime/build evidence. ssh2 1.17.0 passed the SST-002 isolated compatibility gate and is selected for the future adapter; SQLite uses the built-in Node 24 driver recorded in [ADR 0002](docs/adr/0002-local-metadata-storage.md), verified in Node, Electron and packaged SST-005 checks; the Keychain adapter and AES-256-GCM protection are verified in Node, Electron and packaged SST-006 checks under `dev.ssterm.test.*` namespaces ([ADR 0003](docs/adr/0003-secret-storage-and-content-protection.md)); xterm.js 6.0.0 + addon-fit 0.11.0 are accepted for SST-012 ordering/resize ([terminal](docs/terminal.md)); Unicode/IME (SST-013) and backpressure budgets (SST-014) remain open gates.
- ADR-selected future layout: `apps/desktop` for composition/main/preload/renderer; `packages/domain`, `packages/contracts`, `packages/services`, and `packages/adapters`; project-owned fixtures under `tests/fixtures`. `apps/desktop` and `packages/contracts` are implemented in SST-004; domain/adapters are added in SST-005; `packages/services` is added in SST-006. SST-001 created documents only; SST-002 added isolated `spikes/ssh-compat` and `tests/fixtures/ssh` after the first commit.
- Keep host/config resolution, secret storage, connection/session lifecycle, known-host policy, terminal streams, transfers, and tunnels behind focused interfaces. React owns presentation; privileged operations belong in main/service adapters.
- Use typed, validated commands/events through a narrow preload bridge. Validate IPC sender, payload, and session ownership. Keep context isolation and sandboxing enabled and Node integration disabled in renderers.
- Connection/session resources need explicit ownership, cancellation, bounded queues, ordered byte streams, generation IDs for stale-event rejection, and idempotent disposal. Manual reconnect opens a new session without replaying commands.

## SSH, data, and privacy rules

- Share known-host/auth policy across terminal, SFTP, and tunnels. Unknown keys require an explicit trust decision; changed keys block connection until deliberate replacement. Never auto-accept host keys.
- Keep private keys/passwords/passphrases out of metadata, persistent React state, logs, screenshots, telemetry, and error messages. Use opaque secret references and the approved OS secret-store adapter; define transient prompt/cache lifetimes.
- Do not invent cryptography or claim SQLite encrypts data by default. Follow [domain/storage contracts](docs/termius/domain-storage-spec.md): mandatory encrypted snippet bodies, explicit lock/key-loss/recovery, and non-atomic metadata/OS-secret journal reconciliation. Select and verify the mature authenticated-protection provider in SST-006; no plaintext fallback.
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

## Verified desktop commands

At repository root: `npm ci --ignore-scripts`, `npm run runtime:prepare`, `npm run dev`, `npm run dev:renderer`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`, `npm run package:mac`, `npm run test:packaged`. Typecheck/unit/build and both runtime suites are verified; see [desktop evidence](docs/desktop-shell.md). Packaging is unsigned macOS arm64. Playwright launches sandboxed Electron with temporary profiles; generated reports/screenshots/package stay ignored under `artifacts/`. No lint script exists. E2E uses a dedicated renderer server at `http://127.0.0.1:5174` so an existing development server on 5173 can remain running. Development showcase is `http://127.0.0.1:5173/#showcase`; production bundle excludes its fixture catalog. SST-005 adds metadata storage checks using the shipped main-only Adapter; SST-006 adds real Keychain round trips through the main-only `secrets.js` entry under fresh `dev.ssterm.test.<uuid>` namespaces with a zero-leftover assertion. SST-008 adds the main-only session registry/composition and real owned-SSH lifecycle smoke through a test-only Adapter. Runtime suites now also need Docker, the owned `ssterm-ssh-fixture:m0` image and isolated spike dependencies ([prerequisites](docs/sessions.md#verification)); these helpers are excluded from packaging. SST-010 verifies the production saved-host SSH adapter through real saved catalog/Keychain credentials in development and packaged Electron; unit tests also need owned loopback listen access. See [SSH authentication](docs/ssh-auth.md). SST-011 verifies transient password/passphrase and selected keyboard-interactive prompts through the actual bridge/UI with fixture-only values; credential test traces are disabled and screenshots use empty inputs. SST-012 verifies the terminal stream through the real Docker OpenSSH fixture, shipped controller/bridge and rendered xterm pane in development and packaged runs ([terminal](docs/terminal.md)); its E2E starts sessions from main because there is no renderer connect command until SST-016. SST-013 adds Docker input E2E (Thai/IME/width/paste/links/search) using CDP input and synthetic clipboard events, never the real pasteboard or browser. SST-014 adds a flow/budget E2E (flood, blocked renderer, Ctrl+C, maximum paste) recorded in [terminal flow](docs/terminal-flow.md). Final SST-014 baseline: 197 unit / 22 E2E / 19 packaged tests; no lint script.

## Verified isolated spike commands

From `spikes/ssh-compat`: `npm ci --omit=optional --ignore-scripts`, `npm run runtime:prepare`, `npm run check`, `npm test`, `npm run package:mac`, `npm run test:packaged`. Build `tests/fixtures/ssh` as `ssterm-ssh-fixture:m0` first. Docker-dependent checks and launching the owned unsigned app need actual host access. Generated artifacts are ignored; do not commit runtimes or private fixture keys. These commands validate a backend spike, not production UI or release readiness.
