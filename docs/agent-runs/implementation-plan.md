# M0 execution plan — SST-001 ก่อน SST-002

**วันที่:** 2026-10-14 · **Current ticket:** SST-002 / T002–T003 (completed M0) · **PLAN:** DONE

## Authorization / acceptance

ผู้ใช้อนุมัติ pipeline ANALYZE → DESIGN → PLAN → IMPLEMENT → TEST → REVIEW → DELIVER และ commit ทีละงาน: **SST-001 delivery + commit ก่อน SST-002 delivery + commit** ขอบเขตเฉพาะ M0 ไม่รวม SST-003–028, push, external PR, publish หรือ deploy; บันทึก scope นี้ใน product implementation plan และปรับข้อความที่ยังระบุว่ารอทั้ง MVP ให้สอดคล้อง

SST-001 เป็น ADR/เอกสารเท่านั้น ไม่มี repo application manifests, scaffold, dependencies, CSS/components หรือ assets ใหม่ ส่วน SST-002 จึงสร้าง isolated fixture/spike ได้หลัง first commit; อ่าน [analysis](m0-analysis.md), [tickets](../termius/tickets.md), [tasks](../termius/tasks.md), [architecture](../termius/proposed-architecture.md), [DS01](../termius/design-system-implementation.md) และ AGENTS.md ก่อนแก้

Acceptance ของ SST-001: ADR ครอบคลุม MVP/later/macOS arm64, original ssterm UX, selected stack/exact compatible pins/build tooling, app IDs/layout, Keychain/packaging approach, auth/known-host/Paste semantics และ DS01/T047; เอกสารที่เกี่ยวข้องสอดคล้อง, validation ผ่าน, independent review ไม่มี unresolved critical/high, delivery และ commit ก่อนเปิด SST-002

## Approved design / evidence boundaries

| Area | Decision ที่ coder ต้องบันทึกใน ADR |
|---|---|
| Product / IDs | macOS arm64, local-first/account-free/single vault; production `dev.ssterm.desktop`, spike `dev.ssterm.spike`; independent original UX ไม่พึ่ง Termius native/cloud |
| Layout | npm workspaces; future `apps/desktop/src/{main,preload,renderer/src}`, renderer `@/*`; `packages/{domain,contracts,services,adapters}`; isolated `spikes/ssh-compat` และ `tests/fixtures/ssh`; ยังไม่สร้างใน SST-001 |
| Exact UI pins | Electron 44.7.2, React/react-dom 19.3.0, TypeScript 7.0.2, electron-vite 5.0.0, Vite 7.3.7, @vitejs/plugin-react 5.2.0, tailwindcss/@tailwindcss/vite 4.3.3, shadcn 4.21.5, @base-ui/react 1.9.0, lucide-react 1.57.0 |
| Compatibility | electron-vite 5 รองรับ Vite 5–7 จึงเลือก Vite 7 แทน latest Vite 8; Node 24.11.1/npm 11.6.2 ที่ตรวจพบตรง baseline; package resolution ไม่พิสูจน์ build/runtime |
| Candidates | ssh2 1.17.0 รอ SST-002; @xterm/xterm 6.0.0 ยังเป็น candidate; better-sqlite3 13.0.3 รอ storage/native gates; @napi-rs/keyring 2.1.1 เป็น proposed SecretStore/opaque SecretRef รอ SST-003/005/006; M0 ไม่มี real Keychain operation |
| Packaging | @electron/packager 20.3.0, unsigned macOS arm64 `.app` ใน SST-002; signing/notarization/distribution/native storage-secret viability รอ later gates; tested M0 host macOS 15.7.4 arm64 ไม่ใช่ minimum deployment support claim (SST-028) |
| DS01 | Signal Blue v1.0, dark-first/light-later; Base UI / nova / @shadcn registry / Lucide; 32 px controls/rows, 4 px grid, radius 8 px controls/12 px dialogs, focus 2 px; Inter/JetBrains Mono offline + Thai/system fallback |
| Remaining design gates | Rendered contrast/status/focus matrix, ANSI readability, font licenses/offline packaging และ supplied SST artwork production exports ยังไม่ผ่าน; app/terminal themes แยก; branding เดิม |
| Behavior / safety | Shared auth/known-host policy, unknown key explicit trust และ changed key block; transient prompts/secrets ไม่ persist; Paste ไป pending composer, Run explicit/captured target; reconnect ใหม่ไม่ replay; typed validated IPC, sandbox/context isolation, ownership/generation/cancel/idempotent disposal ตาม architecture |

Architect metadata อยู่ `/private/tmp/ssterm-m0/package-metadata.json`; root ตรวจ UI 13 exact pins ด้วย `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --cache /private/tmp/ssterm-m0/npm-cache --prefix /private/tmp/ssterm-m0/ui-resolution` ผ่าน exit 0 (14s), ไม่มี force/legacy-peer-deps หรือ repo scaffold หลักฐานอยู่ `/private/tmp/ssterm-m0/ui-resolution-evidence.json` นี่เป็น temporary peer/engine evidence ของ root ไม่ใช่ SST-001 document checks หรือ package acceptance; coder บันทึก pins/reasons/primary-source links ใน ADR ไม่พึ่ง temporary file เพียงอย่างเดียว

## Ordered tasks / ownership

ทุก stage เขียนไฟล์ร่วมกันแบบ sequential; tester/reviewer อ่านอิสระและให้ coder แก้ findings เก็บ user changes/skills/.codex ไว้ ไม่ให้สอง workers แก้ไฟล์ทับกัน ไม่มี DB/API/frontend implementation: storage spec รอ SST-003, frontend/IPC scaffold SST-004, native storage/secret integration SST-005/006

| ID / stage | Depends | Owner / files / output |
|---|---|---|
| M0-001-A ANALYZE | Confirmation | analyst; `docs/agent-runs/m0-analysis.md`; existing behavior/acceptance/unknowns DONE; ประวัติเดิมที่ยังรอ scope อ่านคู่ authorization ล่าสุด |
| M0-001-D DESIGN | A | architect; decisions ข้างบน DONE; ยังไม่สร้าง app |
| M0-001-P PLAN | D | planner; only `docs/agent-runs/implementation-plan.md`; DONE |
| M0-001-I1 IMPLEMENT | P | coder; new `docs/adr/0001-mvp-platform-stack.md`; ADR ครบ acceptance/pins/rationale/risks/primary sources |
| M0-001-I2 IMPLEMENT | I1 | coder; `AGENTS.md`, `docs/termius/{proposed-architecture,implementation-plan,tickets,tasks,design-system-implementation,implementation-skills}.md`; link ADR, confirmation/status/decisions สอดคล้อง; SST-001 IN_PROGRESS; SST-002 ยังไม่เริ่ม |
| M0-001-T TEST | I2 | tester; read-only checks ด้านล่าง + actual results ในแผนนี้หลัง coder หยุดแก้; ไม่แต่ง application scripts/results |
| M0-001-R REVIEW | T | independent reviewer; coverage SST-001/DS01, scope/privacy/security/regression; coder แก้ findings, critical/high block delivery |
| M0-001-L DELIVER + commit | R passed | root/delivery; acceptance/status lines และแผนนี้; ติ๊ก T001/T047 เมื่อผ่านจริง, record checks/limitations/commit hash; ไม่มี push |
| M0-002-P next ticket | L + first commit | planner/root; update แผนนี้ก่อน spike code เปิด SST-002/T002–T003; pending outline ด้านล่างไม่ใช่ runtime plan สำเร็จรูป |

## Actual document validation commands

รันจาก repo root: `git status --short`, `git diff --check`, `python3 -m json.tool skills-lock.json > /dev/null`, `python3 -m json.tool docs/termius/evidence/artifact-identity.json > /dev/null`, `git diff --stat`; อ่าน diff และ new ADR ตรงเพราะ untracked file ไม่อยู่ใน `git diff` ใช้ `rg -n 'AWAITING_IMPLEMENT_CONFIRMATION|AWAITING_CONFIRMATION|SST-001|SST-002|T001|T047|DS01' AGENTS.md docs/adr docs/termius docs/agent-runs` ตรวจ status consistency ก่อน staging; หลัง staging รัน `git diff --cached --check` และ `git diff --cached --stat`

Local Markdown links/assets ของ changed files (checker ตรวจ target existence ไม่ตรวจ anchors/prose/external sources ซึ่ง reviewer ตรวจเพิ่ม):

```sh
python3 - <<'CHECK'
import pathlib, re, subprocess, urllib.parse
names = subprocess.check_output(['git','diff','--name-only','--diff-filter=ACMR'], text=True).splitlines()
names += subprocess.check_output(['git','ls-files','--others','--exclude-standard'], text=True).splitlines()
errors = []
for name in sorted(set(names)):
    if not name.endswith('.md'): continue
    path = pathlib.Path(name)
    body = re.sub(r'```.*?```', '', path.read_text(), flags=re.S)
    for raw in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', body):
        url = urllib.parse.urlsplit(raw.strip().strip('<>').split()[0])
        if not url.scheme and not url.netloc and url.path and not (path.parent / urllib.parse.unquote(url.path)).exists():
            errors.append(f'{path}: {raw}')
print('Missing local targets:', errors)
raise SystemExit(bool(errors))
CHECK
```

ยังไม่มี application lint/typecheck/unit/E2E/build scripts ใน SST-001 จึงไม่รายงานว่าผ่าน; test-fix failure เดิมสูงสุด 3 attempts ถ้าไม่มี evidence ใหม่ให้เก็บ diagnostics และ resolve concrete blocker ไม่ rerun แบบเดา

## Operational note

ผู้ใช้กำหนด: หากชน runtime/tool limit จริง ให้ตรวจเวลาท้องถิ่น Asia/Bangkok บันทึกชนิด limit/เวลาที่พบ และกลับมาทำต่อรอบ 02:05 ถัดไป เงื่อนไขนี้ไม่ใช่คำสั่งให้พักตอนยังทำงานได้ ไม่เปลี่ยน scope หรือลำดับ SST-001 → commit → SST-002 → commit และ elapsed time ไม่ใช่ approval

## Pending SST-002 / rollback / ledger

SST-002 ยังไม่เริ่ม: หลัง SST-001 commit ตรวจ local fixture runtime จริง แล้ว update ownership/actual manifests/scripts/commands ก่อนสร้าง `tests/fixtures/ssh` → `spikes/ssh-compat` → failure/lifecycle tests → unsigned arm64 package/report; acceptance มี password/encrypted key, trust/reject/changed key, PTY/resize/exit, SFTP integrity, local loopback forwarding, denied/timeout/cancel/disconnect/teardown, algorithm/API limits และ packaged runtime; ไม่ใช้ real/Termius/production data หรือ real Keychain และไม่ mark complete จาก dev-only tests

Rollback SST-001: ย้อนเฉพาะ task-owned Markdown diff เมื่อจำเป็นและ preserve user changes ไม่ reset/clean; หลัง commit revert ตามคำสั่งไม่ rewrite history SST-002 ต้องเพิ่ม teardown ของ project-owned processes/ports/throwaway paths/package ก่อน runtime เมื่อจบ M0 หยุดก่อน SST-003/004

### TEST — PASS (2026-10-14)

- รัน `git diff --check`; ผ่าน
- Parse `docs/adr/dependency-baseline.json`, `skills-lock.json`, `docs/termius/evidence/artifact-identity.json`; ผ่านทั้งหมด
- ตรวจ local targets ใน changed/untracked Markdown; missing targets 0
- เทียบ 13 exact direct pins ใน baseline กับ `/private/tmp/ssterm-m0/ui-resolution/package-lock.json` และ `/private/tmp/ssterm-m0/ui-resolution-evidence.json`; ตรงครบ 13/13, resolver exit 0, 514 packages, scripts ไม่ถูกรัน, SHA-256 ตรง `2ea90e94e0fa629a0b1fa86c24d6d1b97771560c39d8a8d5303d753abd8ac538`
- ตรวจ inventory: 38 unique tickets และ 52 unique tasks; T001/T047 ยัง unchecked รอ review/delivery, T002/T003 ยัง unchecked และ SST-002 รอ first commit; SST-001 ยัง `IN_PROGRESS`, SST-002 `NOT_STARTED`, SST-003–028 ยัง approval-gated
- ไม่พบ application manifest จึงไม่มี lint/typecheck/unit/E2E/build ที่รันได้; metadata resolution ไม่ใช่ runtime/build proof. Minimum macOS deployment support ยังคงเป็น gate ของ SST-028 ตาม ADR

**Ledger:** ANALYZE DONE · DESIGN DONE · PLAN DONE · IMPLEMENT DONE · TEST DONE · REVIEW DONE · DELIVER DONE · COMMIT PENDING · SST-002 NOT_STARTED. **SST-001 commit:** pending

**REVIEW / DELIVERY:** independent reviewer PASS, no blocking findings; delivery note [sst-001-delivery.md](sst-001-delivery.md) completed. Root closed SST-001/T001/T047 after those gates and will create the authorized first commit before SST-002. Pending status label standardized to `AWAITING_IMPLEMENT_CONFIRMATION`.

## SST-002 execution plan — 2026-10-14

**SST-001 commit:** `ad9ed51` (all stages DONE); supersedes pending commit references above. First-ticket gate satisfied; **SST-002 / T002–T003 IN_PROGRESS**, M0 authorization continues; SST-003–028 remain unapproved.
ANALYZE/DESIGN complete; implement now using isolated Node CommonJS spike, ssh2 `1.17.0`, Electron `44.7.2`, @electron/packager `20.3.0`; no production app scaffold or new DS work.

| Order / owner | Files and deliverable / gate |
|---|---|
| 1 coder | `tests/fixtures/ssh/{Dockerfile,sshd_config,entrypoint.sh}`: project-owned image/container, ephemeral fixture keys/password, SSH published on dynamic `127.0.0.1` port; actual host-key rotation preserves endpoint |
| 2 coder | `spikes/ssh-compat/{package.json,package-lock.json,src/{fixture,connection,probes,report}.cjs,test/integration.test.cjs}`: bounded connect/trust/auth/cancel contract; real SSH fixture and capability tests |
| 3 coder | `spikes/ssh-compat/{electron/main.cjs,scripts/{package,run-packaged}.cjs,README.md}`: shared probes run after `app.whenReady`, unsigned macOS arm64 `.app`, documented reproducible commands |
| 4 root | Root ignore/dependency orchestration and `docs/spikes/ssh-compatibility.md` report; update scoped status/docs after evidence; coder owns code only and edits stay sequential |
| 5 tester → reviewer → root | Actual tests/package results, independent correctness/privacy/security review, fix blocking findings, then delivery + authorized SST-002 commit; no push |

Coder creates scripts before validation; from `spikes/ssh-compat` run `npm ci`, `npm test`, `npm run package:mac`, `npm run test:packaged`; root additionally runs `git diff --check` and checks changed Markdown/JSON. Record actual scripts/results/failures; no pass claims before execution.
Acceptance matrix: password/encrypted-key auth; unknown-key reject/explicit trust and changed-key block; real PTY, `stty` resize and exit; SFTP upload/download hashes; internal HTTP through loopback local forwarding; denied/timeout/cancel/connection-loss and idempotent cleanup; packaged shared probes plus API/lifecycle/algorithm limitations and backend decision.
Fixture image/server and ephemeral credentials are project-owned; no user secrets, Termius data, real Keychain or `.codex` edits. Teardown only owned containers/processes/temporary paths/listeners/sockets; preserve evidence and user changes. Retry same failure at most three times without new evidence, then resolve concrete blocker.
Rollback: stop owned fixture/package processes, dispose sockets/listeners, delete only recorded throwaway paths; revert task-owned changes if requested, never blanket reset/clean. Packaging does not close production signing/native-storage/secret gates.
**SST-002 ledger:** ANALYZE DONE · DESIGN DONE · PLAN DONE · IMPLEMENT PENDING · TEST PENDING · REVIEW PENDING · DELIVER+COMMIT PENDING. Do not close SST-002/T002/T003 until real integration and packaged runtime acceptance passes; stop after M0 delivery.

**SST-002 implementation ownership:** root owns `tests/fixtures/ssh/{Dockerfile,sshd_config,entrypoint.sh}`, root `.gitignore`, environment orchestration and final reports/status. Coder owns `spikes/ssh-compat` only. Fixture accepts generated `FIXTURE_PASSWORD` and `FIXTURE_PUBLIC_KEY`; internal HTTP target is `127.0.0.1:8080`. No overlapping edits.

## Final M0 record — 2026-10-15

SST-001 completed all stages and committed `ad9ed51` before SST-002 began. SST-002 ANALYZE/DESIGN/PLAN/IMPLEMENT/TEST/REVIEW/DELIVER completed; root will create the second authorized commit now. Earlier pending/NOT_STARTED lines are historical stage snapshots, superseded by this final record.

Actual checks: clean lockfile `npm ci --omit=optional --ignore-scripts` exit 0, explicit pinned runtime preparation, `npm run check` PASS, `npm test` PASS (4 Node tests: 19 real probes + 3 regressions), `npm run package:mac` PASS, `npm run test:packaged` PASS (19 real probes). Independent tester confirmed the corrected sources/package and no remaining fixture key directories/containers; reviewer re-review found no remaining High/Medium. Evidence and operational limits: [backend report](../spikes/ssh-compatibility.md); [delivery](sst-002-delivery.md). No production UI, real Keychain, external PR, push or deployment.

Coder previously hit a usage limit; work resumed on 2026-10-15 at 08:56 Asia/Bangkok after the requested 02:05 window. No limit prevented final runtime checks. Stop after M0 commit; SST-003 onward needs new scope authorization.
