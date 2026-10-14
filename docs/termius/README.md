# Termius → ssterm: investigation และ implementation backlog

**วันที่:** 2026-10-14 · **เป้าหมาย:** Termius desktop 9.43.1, macOS arm64 · **สถานะ:** M0 authorized; SST-001 `DONE`, SST-002 `NOT_STARTED`

จัดทำเอกสารตามคำขอให้ถอดระบบ Termius แล้วสรุป task, ticket และ plan ก่อน implement โครงการนี้ยังไม่มี application code จึงเสนอ baseline เป็น macOS desktop แบบ local-first และ account-free; baseline นี้บันทึกใน [ADR 0001](../adr/0001-mvp-platform-stack.md); อนุมัติลงมือเฉพาะ M0 เมื่อ 2026-10-14

**UI stack ที่ผู้ใช้เลือกแล้ว:** React + TypeScript บน Electron พร้อม shadcn/ui + Tailwind CSS ดู [stack decision](proposed-architecture.md#baseline--stack-decision) การเลือก stack และการอนุมัติ M0 เป็นคนละเหตุการณ์; SST-003–028 ยังรออนุมัติ

**Visual spec สำหรับวางแผน:** [Signal Blue v1.0](design-system.md) — dark-first, Inter + JetBrains Mono, terminal-first layout และแยก blue focus จาก operational status ดู [design implementation plan](design-system-implementation.md); อนุมัติเฉพาะ DS01 ใน SST-001; งาน DS02–DS06 ยังรออนุมัติ

## เอกสาร

| เอกสาร | ใช้ทำอะไร |
|---|---|
| [system-analysis.md](system-analysis.md) | สรุประบบที่พบจริง, architecture, data/IPC/session flows และ investigation checklist |
| [official-features.md](official-features.md) | ฟีเจอร์และ workflow จาก official docs พร้อม sources W01–W12 |
| [native-boundary.md](native-boundary.md) | native wrappers, linkage, symbols, ข้อจำกัด และ input สำหรับ backlog |
| [proposed-architecture.md](proposed-architecture.md) | architecture และ contracts ที่เสนอสำหรับ ssterm; แยกจาก Termius implementation |
| [design-system.md](design-system.md) | Signal Blue brand/UI specification, semantic colors, typography, layout และ release quality checklist |
| [Logo & app icon](../logo/README.md) | supplied SST artwork, brand lockup/icon/presentation usage, ขนาดไฟล์ และ production export/QA handoff |
| [design-system-implementation.md](design-system-implementation.md) | แผน DS01–DS06, token/component contracts, task mapping และเกณฑ์ตรวจรับก่อนพัฒนา |
| [tickets.md](tickets.md) | ticket พร้อม priority, dependency, acceptance criteria และ validation |
| [tasks.md](tasks.md) | checklist งานย่อยที่เชื่อม ticket และสถานะตาม scoped authorization |
| [implementation-plan.md](implementation-plan.md) | phases, gates, ลำดับงาน, effort ranges และ scope confirmation |
| [ADR 0001](../adr/0001-mvp-platform-stack.md) | platform/stack/pins/layout/Keychain/packaging/design decisions และ evidence limits |
| [M0 execution plan](../agent-runs/implementation-plan.md) | authorization, stage ownership, validation และ delivery/commit ledger |
| [implementation-skills.md](implementation-skills.md) | shortlist skills สำหรับ React/Electron/shadcn/Tailwind/testing พร้อม sources, quality notes และคำสั่งติดตั้ง |
| [evidence/README.md](evidence/README.md) | วิธีตรวจสอบ artifact, REA Evidence และ bounded shell observations |

## ผลที่ใช้วางแผนได้

- Artifact มี Electron main/UI/background/preload/service layers; native addon เชื่อม libssh2 และ OS credential APIs [หลักฐาน S01–S05, N01–N07](system-analysis.md)
- Domain ที่พบใน shipped code มี Host, Group, Identity, PrivateKey, KnownHost, Snippet, PortForwardingRule และข้อมูลที่เกี่ยวกับ vault/sync [S04](evidence/static-observations.json)
- Published workflows มี groups inheritance, terminal Focus/Split, SFTP dual pane, snippet Paste/Run และ forwarding สามชนิด [official features](official-features.md)
- เสนอ MVP: local storage + secrets, hosts/groups/tags/identities, SSH/password/key/keyboard-interactive, known-host decisions, terminal tabs/basic split, SFTP และ local forwarding
- Cloud sync, teams, native crypto internals, Mosh/FIDO, AI และ mobile แยกเป็น later scope; ยังไม่มีหลักฐานเพียงพอสำหรับการทำให้เข้ากันกับ Termius cloud

## ขอบเขตความเชื่อมั่น

REA วิเคราะห์ source ที่เลือก 10 รายการสำเร็จ และเก็บ complete Evidence ไว้ แต่ application/semantic coverage ยังเป็น **partial**; large main/UI/background bundles ตรวจเพิ่มเติมด้วย bounded static shell inspection ไม่ได้ถือว่าเป็น REA semantic analysis ที่สำเร็จ ไม่ได้เปิดแอป จับ network หรือทดสอบ UI/SSH จริง [REA metadata](evidence/rea-analysis-metadata.json)

พบ ASAR declared integrity แตกต่างจาก companion native bytes 17 รายการ จึงใช้ `record-and-continue` และคง `observed-untrusted` ในหลักฐาน การลงนาม/strip หลัง packaging เป็นสาเหตุที่เป็นไปได้ตาม REA diagnostic แต่ครั้งนี้ไม่ได้ยืนยันสาเหตุหรือ publisher authenticity รายงานจึงอ้างได้เฉพาะ installed bytes นี้

## Scoped confirmation

ผู้ใช้อนุมัติ **M0 / SST-001–002 เท่านั้น** เมื่อ 2026-10-14: pipeline ANALYZE → DESIGN → PLAN → IMPLEMENT → TEST → REVIEW → DELIVER และ commit SST-001 ก่อนเริ่ม SST-002 แล้ว delivery + commit SST-002 ดู [execution plan](../agent-runs/implementation-plan.md) ขณะนี้ SST-001 เป็น ADR/docs `DONE`; SST-002 `NOT_STARTED` ไม่มี application scaffold

SST-003–028/DS02–DS06 ยังรออนุมัติ; SST-029–038 คง later scope ไม่รวม push/external PR/publish/deploy Ticket ในเอกสารเป็น backlog ภายใน repo ยังไม่ได้เปิด external issue ความเชื่อมั่นของ Termius investigation ข้างบนไม่เปลี่ยนจากการเริ่ม M0
