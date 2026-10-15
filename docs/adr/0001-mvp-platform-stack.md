# ADR 0001 — MVP platform, stack และ design integration

**วันที่:** 2026-10-14 · **Scope:** SST-001 / T001 / DS01–T047 · **สถานะ:** design recorded; SST-001 `DONE` ผ่าน TEST/REVIEW/DELIVER

## Context และ authorization

ณ วันที่บันทึก ADR (2026-10-14) ผู้ใช้เลือก Electron + React + TypeScript + shadcn/ui + Tailwind CSS แล้ว และอนุมัติ **M0 เท่านั้น**: SST-001 ผ่าน pipeline ถึง delivery และ commit ก่อนเริ่ม SST-002 แล้ว delivery และ commit อีกครั้ง ไม่อนุมัติ SST-003–028, push, external PR, publish หรือ deploy ดู [execution plan](../agent-runs/implementation-plan.md) และ [product scope](../termius/implementation-plan.md)

**Later scope note (2026-10-15):** คำสั่งถัดไปอนุมัติเฉพาะ SST-003/T004–T005 documentation-only [domain/storage specification](../termius/domain-storage-spec.md); supersedes M0 stop condition เฉพาะ ticket นี้ SST-004–028 ยังรออนุมัติ ไม่มี production scaffold/SQLite/Keychain หรือ authorization ใหม่สำหรับ commit/push การตัดสินใจ ADR เดิมคงเดิม

SST-001 เป็นเอกสาร ไม่มี application manifest/scaffold, installed repo dependencies, UI/assets หรือ fixture code การเลือกด้านล่างเป็นข้อกำหนดของ ssterm ไม่ใช่ข้อค้นพบภายใน Termius และไม่พิสูจน์ runtime compatibility

## Product / platform decision

MVP baseline เป็น **macOS arm64, local-first, account-free, local vault เดียว**: hosts/nested groups/tags/inheritance, reusable identities/password/imported encrypted keys/keyboard-interactive, explicit known-host policy, SSH terminals/tabs/basic splits/Unicode/resize/manual reconnect, local↔remote SFTP, active-session snippets และ local port forwarding ตาม [tickets SST-001–028](../termius/tickets.md) การบันทึก MVP ไม่อนุมัติ implementation ทั้ง MVP

Later scope: cloud/team sync และ crypto protocol ใหม่, additional OS/mobile/local PTY, Mosh/FIDO, agent/hardware auth, multi-hop/proxy, remote/dynamic forwarding, advanced transfers/editing, broadcast/templates/history/AI; light theme แยก later เช่นกัน

ใช้ original ssterm UX และ supplied SST-style monogram/branding; workflow reference จาก published Termius ไม่ใช่ pixel/database/cloud API compatibility target ไม่ใช้ Termius code/native libraries/profiles/secrets ความต่างที่ตั้งใจ: explicit save, snippet Paste composer, explicit trust/change-key flow และ manual reconnect โดยไม่ replay input ไม่รับประกัน remote process continuity

Observed development host: macOS **15.7.4 arm64**, Node **24.11.1**, npm **11.6.2** เป็น baseline สำหรับ M0 ไม่ใช่ minimum supported macOS/version matrix; SST-028 ต้องกำหนดและตรวจ deployment target จริง

## Exact dependency / build decisions

ใช้ npm workspaces ใน future application scaffold; pin direct versions โดยไม่มี `^`/`~` และสร้าง lockfile เมื่อได้รับอนุมัติ scaffold; SST-001 เก็บเพียง [dependency baseline](dependency-baseline.json) ที่ระบุ primary registry URLs, engine/peer ranges และ resolution evidence ไม่มี root `package.json` หรือ lockfile

| Layer | Exact selected versions / primary metadata |
|---|---|
| Desktop | [electron 44.7.2](https://registry.npmjs.org/electron/44.7.2) |
| UI / language | [react 19.3.0](https://registry.npmjs.org/react/19.3.0), [react-dom 19.3.0](https://registry.npmjs.org/react-dom/19.3.0), [typescript 7.0.2](https://registry.npmjs.org/typescript/7.0.2) |
| Build | [electron-vite 5.0.0](https://registry.npmjs.org/electron-vite/5.0.0), [vite 7.3.7](https://registry.npmjs.org/vite/7.3.7), [@vitejs/plugin-react 5.2.0](https://registry.npmjs.org/@vitejs/plugin-react/5.2.0) |
| Styling | [tailwindcss 4.3.3](https://registry.npmjs.org/tailwindcss/4.3.3), [@tailwindcss/vite 4.3.3](https://registry.npmjs.org/@tailwindcss/vite/4.3.3) |
| Components / icons | [shadcn 4.21.5](https://registry.npmjs.org/shadcn/4.21.5), [@base-ui/react 1.9.0](https://registry.npmjs.org/@base-ui/react/1.9.0), [lucide-react 1.57.0](https://registry.npmjs.org/lucide-react/1.57.0) |
| Local packaging | [@electron/packager 20.3.0](https://registry.npmjs.org/@electron/packager/20.3.0) |

electron-vite unifies main/preload/renderer builds without changing process boundaries ([upstream](https://electron-vite.org/guide/)). Its 5.0.0 metadata declares Vite `^5 || ^6 || ^7`; choose Vite 7.3.7 rather than Vite 8. plugin-react 5.2.0 and Tailwind Vite plugin 4.3.3 admit Vite 7; React DOM 19.3.0, Base UI 1.9.0 and Lucide 1.57.0 admit React 19.3.0. Host Node 24.11.1 satisfies the selected tools' declared Node engines. These are metadata constraints, not a build result

**Observed compatibility proof:** on 2026-10-14 root ran the 13 selected direct pins in a temporary directory with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --cache /private/tmp/ssterm-m0/npm-cache --prefix /private/tmp/ssterm-m0/ui-resolution`; exit **0**, 514 resolved packages, no force/legacy-peer-deps or install scripts. Temporary lock SHA-256: `2ea90e94e0fa629a0b1fa86c24d6d1b97771560c39d8a8d5303d753abd8ac538`. Durable parameters/results are in the baseline JSON; the temporary lock is not shipped. No renderer build, Electron launch, native load, Keychain operation or packaging was performed by this check. Bootstrap must verify generated shadcn imports/transitive dependencies and run real typecheck/build/render checks

| Remaining candidate | Decision gate |
|---|---|
| [ssh2 1.17.0](https://registry.npmjs.org/ssh2/1.17.0) | SST-002 real SSH/SFTP/forwarding/lifecycle + packaged arm64 spike; revise backend/ADR if it fails, preserve approved UI stack |
| [@xterm/xterm 6.0.0](https://registry.npmjs.org/@xterm/xterm/6.0.0) | SST-012–014 renderer integration, byte ordering/backpressure/resize/Unicode; backend PTY evidence alone does not accept xterm |
| [better-sqlite3 13.0.3](https://registry.npmjs.org/better-sqlite3/13.0.3) | SST-003/005 storage model/migrations + native Electron ABI/packaged viability; SQLite does not encrypt by default |
| [@napi-rs/keyring 2.1.1](https://registry.npmjs.org/@napi-rs/keyring/2.1.1) | Proposed macOS Keychain adapter behind SecretStore; SST-003/005/006 contract, denied/missing/locked outcomes, namespace and native package checks |

## App identity / layout / privileged boundaries

Production bundle ID **`dev.ssterm.desktop`**; throwaway spike **`dev.ssterm.spike`**. Keep spike storage/credential namespaces separate; reserve the production namespace for the approved SecretStore design. M0 performs **no real Keychain operation**

Future layout (decided paths; directories not created in SST-001):

| Path | Responsibility |
|---|---|
| `apps/desktop/src/main` | composition, windows, validated commands, privileged adapters |
| `apps/desktop/src/preload` | narrow typed contextBridge API; no arbitrary IPC/Node passthrough |
| `apps/desktop/src/renderer/src` | React presentation, `@/*` alias, `components/ui`, `styles/globals.css` |
| `packages/domain`, `packages/contracts` | pure catalog/config rules; validated command/event schemas |
| `packages/services`, `packages/adapters` | lifecycle/ownership policy; SSH/storage/secrets implementations |
| `tests/fixtures/ssh`, `spikes/ssh-compat` | project-owned lab fixture; isolated SST-002 capability harness, not production services |

Keep renderer Node integration disabled, context isolation and sandbox enabled, local navigation/CSP and external URL allowlists; validate sender, payload and session ownership at IPC entry. Secrets stay in main/service adapters, never persistent React state or metadata/logs. Use opaque SecretRefs; prompt responses remain transient for the matching request/session/generation and are released on completion, cancellation, timeout or disconnect. Initial default has no cross-connection passphrase cache; any later cache needs explicit lifetime/lock policy. JavaScript cleanup does not imply guaranteed memory zeroization. Sensitive-field encryption, keys/recovery and provider namespace details remain SST-003/006; do not invent crypto ([Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [keyring upstream](https://github.com/Brooooooklyn/keyring-node))

SST-002 uses @electron/packager to create and run an **unsigned macOS arm64 `.app`** with the independent backend and isolated identity. This checks feasibility, not distribution readiness. Signing/notarization, entitlements, upgrade/recovery, font/icon production exports, native storage/secret bindings and clean supported-host acceptance remain SST-028 and dependent tickets ([Packager](https://github.com/electron/packager), [Electron distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution)); do not add Forge, auto-updates or online services incidentally

## Default auth / trust / execution semantics

- Resolve the chosen host's explicit/inherited auth bundle at connect into a fixed snapshot. Use its selected password or imported key; prompt for missing secret/encrypted-key passphrase and server-requested keyboard-interactive input. No agent scanning, fallback credential discovery or automatic credential persistence. Cancellation returns no usable authenticated capability
- Share known-host/auth policy across terminal, SFTP and tunnels. Unknown endpoint: show host:port, algorithm and fingerprint, then explicit accept once / remember / reject. Default is no acceptance; changed key blocks until deliberate replacement. Normalize endpoint independently of catalog labels; write remembered trust only after explicit decision. SST-002 validates against project-owned server keys
- Snippet **Paste** inserts text into a local pending-input composer and sends **zero bytes** before user submission. **Run** is an explicit action that sends the body plus execution line ending to the target captured at invocation; pane switching cannot retarget the request. Show target/PROD context, and distinguish sent from remote success. Clipboard multiline paste must not imply automatic execution; validate bracketed paste/IME in SST-013/024
- Connection/session generation rejects stale events; resources have one owner, cancellation, bounded ordered queues and idempotent disposal. Manual reconnect creates a new transport/channel and never replays commands. Local tunnels default to loopback and close listener/sockets on stop/failure/quit. SFTP requires explicit conflict/cancel/partial-file rules before transfer implementation

Details remain in [architecture contracts](../termius/proposed-architecture.md); those requirements do not claim SST-002 or MVP features already work

## DS01 / T047 — Signal Blue integration decision

Adopt [Signal Blue v1.0](../termius/design-system.md), dark-first/light-later. **Base UI**, **nova** style (`base-nova` config family), official **`@shadcn` registry**, **Lucide** icons. Prefer generated primitives/composition/shared semantic variants, and inspect actual pinned CLI output/APIs at SST-004; no init/add/apply in this task. Proposed `components.json` belongs to `apps/desktop`, with `rsc:false`, TSX, renderer alias `@/*`, CSS variables and `src/renderer/src/styles/globals.css`; resolve aliases in both TypeScript and Vite ([shadcn config](https://ui.shadcn.com/docs/components-json), [theming](https://ui.shadcn.com/docs/theming))

Tailwind v4 uses semantic CSS variables mapped with `@theme inline`; preserve Signal Blue roles rather than accepting preset colors. Add sidebar/input/destructive/interaction slots where required. App theme and terminal foreground/background/cursor/selection/ANSI/font object remain independent

Default density: **32 px controls and rows**, **4 px spacing grid**, **8 px control radius / 12 px dialog radius**, **2 px visible focus ring**. Selection uses blue fill/indicator while focus has a distinct ring; connected/connecting/error/disconnected use green/amber/red/muted plus icon/text independently of selected/active state. Target and explicit PROD labels remain visible per terminal pane. Shared variants carry geometry/type/state; no raw per-component brand colors

UI font **Inter**, terminal/code **JetBrains Mono**, packaged offline with licenses. Proposed Thai fallback: Noto Sans Thai when licensed/bundled, then `Thonburi`, system sans-serif; terminal fallback to platform monospace for missing glyphs. This is a fallback policy, not verified glyph/IME or font packaging evidence. Use supplied [SST artwork](../logo/README.md), preserve originals; wordmark font is unverified

Open gates remain explicit in [design handoff](../termius/design-system-implementation.md): rendered contrast/focus/status/PROD matrix (including essential border contrast), terminal ANSI readability, Thai/IME/focus return/reduced motion/scaling/overflow and minimum window-size decision, offline fonts/licenses, alpha edges/padding/small icons/macOS exports. DS02–DS06/SST-004/018/027/028 remain unapproved; static palette math or fixture showcase does not close them

## Consequences / verification / rollback

The selected stack and paths stop framework/tooling churn; Vite 7 bounds compatibility to electron-vite's declared peers. Native backend/storage/Keychain viability and real UI output remain risks with named gates. Update this ADR and related tickets/tasks if a gate changes a decision; do not silently replace the UI stack

SST-001 acceptance is document coverage + local links/assets/JSON/whitespace consistency + independent review, then delivery/commit. T001/T047 are complete after document checks, independent review and delivery passed; see the execution ledger. No application lint/typecheck/unit/E2E/build scripts exist in this ticket; package metadata resolution is not a substitute. Actual validation/stage results belong in the [execution ledger](../agent-runs/implementation-plan.md). Rollback changes only this task's documents; preserve unrelated changes, and revert a committed change only when authorized

## SST-002 outcome — 2026-10-15

หลัง commit SST-001 `ad9ed51` งาน SST-002 ผ่าน real fixture probes 19/19 ทั้ง host Node และ packaged Electron รวม 3 regression tests จึงเลือก ssh2 1.17.0 เป็น backend baseline สำหรับ production adapter ถัดไป ดู [result](../spikes/ssh-compatibility.md) และ [delivery](../agent-runs/sst-002-delivery.md) Dependency baseline JSON ด้านบนเป็น snapshot การตัดสินใจ ณ SST-001; outcome นี้ supersede เฉพาะ candidate gate ของ ssh2 ไม่ยืนยัน xterm/SQLite/Keychain/native ABI/UI หรือ release readiness

## SST-004 bootstrap outcome — 2026-10-15

Latest authorization “commit และทำงานถัดไปต่อ” supersedes the earlier SST-004 stop: SST-003 committed `603e600`, then SST-004/T006/T007/DS02–DS03/T048–T049 implemented at the selected paths/pins. [Desktop evidence](../desktop-shell.md): typecheck, 13 unit tests, 7 development E2E and 4 unsigned packaged Electron E2E pass; independent TEST/REVIEW/DELIVERY passed. shadcn info confirms Base UI/nova/Lucide. TypeScript 7 removed baseUrl, so paths use explicit relative targets; electron-vite 5 bundles contracts via externalizeDeps exclusion for sandbox preload. Local fonts/license assets and 960×640 minimum are verified for this shell; release/native-storage/session gates remain separate. Commit SST-004/push/SST-005+ are not authorized by this instruction.

## SST-005 storage decision — 2026-10-15

User subsequently authorized commit SST-004 (`d6e1822`) and SST-005/T008. [ADR 0002](0002-local-metadata-storage.md) selects `node:sqlite` from the pinned runtime, superseding the untested better-sqlite3 candidate above. Domain/adapters now exist; [storage evidence](../local-storage.md) records the actual validation and remaining gates. No better-sqlite3 failure is claimed; secret providers/SSH and commit SST-005 remain separate scope.
