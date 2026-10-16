# Termius → ssterm: investigation และ implementation backlog

**SST-011 / T017: `DONE`** — [transient authentication prompts](../auth-prompts.md) ผ่าน independent TEST/REVIEW/DELIVER: unit 157/157, E2E 19/19, packaged 16/16; รวมใน commit SST-011 ตามคำสั่ง “commit”. SST-001–010 committed (`76d473f` latest); SST-012–028 และ DS04–DS06 ยังรออนุมัติ

**วันที่:** 2026-10-14; M0 update 2026-10-15 · **เป้าหมาย investigation:** Termius desktop 9.43.1, macOS arm64 · **สถานะ:** M0 complete; SST-003/T004–T005 documentation-only `DONE`

เริ่มจากการวิเคราะห์ Termius และจัด task/ticket/plan ปัจจุบัน M0 มี isolated SSH/backend spike และ runtime evidence แล้ว ส่วน production macOS desktop แบบ local-first/account-free มี storage/secrets/catalog Modules แล้ว; session services เริ่มใน SST-008 ตามขอบเขตที่ผู้ใช้อนุมัติ ดู [ADR 0001](../adr/0001-mvp-platform-stack.md)

**UI stack ที่ผู้ใช้เลือกแล้ว:** React + TypeScript บน Electron พร้อม shadcn/ui + Tailwind CSS ดู [stack decision](proposed-architecture.md#baseline--stack-decision) การเลือก stack และการอนุมัติ M0 เป็นคนละเหตุการณ์; SST-003 ได้รับอนุมัติเฉพาะ domain/privacy/storage specification; SST-012–028 ยังรออนุมัติ

**Visual spec สำหรับวางแผน:** [Signal Blue v1.0](design-system.md) — dark-first, Inter + JetBrains Mono, terminal-first layout และแยก blue focus จาก operational status ดู [design implementation plan](design-system-implementation.md); DS01 เสร็จใน SST-001; งาน DS02–DS03 อยู่ใน SST-004 ที่อนุมัติแล้ว; DS04–DS06 ยังรออนุมัติ

## เอกสาร

| เอกสาร | ใช้ทำอะไร |
|---|---|
| [system-analysis.md](system-analysis.md) | สรุประบบที่พบจริง, architecture, data/IPC/session flows และ investigation checklist |
| [official-features.md](official-features.md) | ฟีเจอร์และ workflow จาก official docs พร้อม sources W01–W12 |
| [native-boundary.md](native-boundary.md) | native wrappers, linkage, symbols, ข้อจำกัด และ input สำหรับ backlog |
| [proposed-architecture.md](proposed-architecture.md) | architecture และ contracts ที่เสนอสำหรับ ssterm; แยกจาก Termius implementation |
| [Session lifecycle](../sessions.md) | SST-008: engine-independent registry, generations/prompts, resource ownership และ runtime fixtures |
| [Catalog domain](../catalog.md) | SST-007: inheritance/provenance, queries, transactional impact previews และ deletion/queued cleanup |
| [Desktop shell](../desktop-shell.md) | SST-004: code, commands, security/design-system checks และ packaged evidence |
| [domain-storage-spec.md](domain-storage-spec.md) | SST-003: typed dictionary/relations/inheritance/delete/protection/lock/recovery และ journal/migration contracts; ไม่ใช่ runtime implementation |
| [design-system.md](design-system.md) | Signal Blue brand/UI specification, semantic colors, typography, layout และ release quality checklist |
| [Logo & app icon](../logo/README.md) | supplied SST artwork, brand lockup/icon/presentation usage, ขนาดไฟล์ และ production export/QA handoff |
| [design-system-implementation.md](design-system-implementation.md) | แผน DS01–DS06, token/component contracts, task mapping และเกณฑ์ตรวจรับก่อนพัฒนา |
| [tickets.md](tickets.md) | ticket พร้อม priority, dependency, acceptance criteria และ validation |
| [tasks.md](tasks.md) | checklist งานย่อยที่เชื่อม ticket และสถานะตาม scoped authorization |
| [implementation-plan.md](implementation-plan.md) | phases, gates, ลำดับงาน, effort ranges และ scope confirmation |
| [ADR 0001](../adr/0001-mvp-platform-stack.md) | platform/stack/pins/layout/Keychain/packaging/design decisions และ evidence limits |
| [Execution plan](../agent-runs/implementation-plan.md) | authorization, stage ownership, validation และ delivery/commit ledger |
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

ผู้ใช้อนุมัติ M0 และ commit ทีละงาน: SST-001 ส่งมอบ/commit `ad9ed51` ก่อนเริ่ม SST-002; SST-002 ผ่าน Node/packaged checks และ delivery แล้ว ดู [backend result](../spikes/ssh-compatibility.md) และ [execution record](../agent-runs/implementation-plan.md) คำสั่งถัดไป “ทำงาน ถัดไปต่อได้” อนุมัติเฉพาะ SST-003/T004–T005 documentation-only; [spec](domain-storage-spec.md) อยู่ `DONE` ผ่าน independent TEST/REVIEW ส่วน SST-012–028 และ DS04–DS06 ยังรออนุมัติ; DS02–DS03 ส่งมอบแล้วใน SST-004

SST-012–028 และ DS04–DS06 ยังรออนุมัติ; DS02–DS03 ส่งมอบแล้วใน SST-004; SST-029–038 คง later scope ไม่รวม push/external PR/publish/deploy Ticket ในเอกสารเป็น backlog ภายใน repo ยังไม่ได้เปิด external issue ความเชื่อมั่นของ Termius investigation ข้างบนไม่เปลี่ยนจากการเริ่ม M0
