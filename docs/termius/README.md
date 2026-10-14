# Termius → ssterm: investigation และ implementation backlog

**วันที่:** 2026-10-14 · **เป้าหมาย:** Termius desktop 9.43.1, macOS arm64 · **สถานะ:** `AWAITING_IMPLEMENT_CONFIRMATION`

จัดทำเอกสารตามคำขอให้ถอดระบบ Termius แล้วสรุป task, ticket และ plan ก่อน implement โครงการนี้ยังไม่มี application code จึงเสนอ baseline เป็น macOS desktop แบบ local-first และ account-free; ขอบเขตนี้เป็นข้อเสนอที่ยังต้องยืนยัน

**UI stack ที่ผู้ใช้เลือกแล้ว:** React + TypeScript บน Electron พร้อม shadcn/ui + Tailwind CSS ดู [stack decision](proposed-architecture.md#baseline--stack-decision) การเลือก stack ยังไม่ใช่ confirmation ให้เริ่ม implement

**Visual spec สำหรับวางแผน:** [Signal Blue v1.0](design-system.md) — dark-first, Inter + JetBrains Mono, terminal-first layout และแยก blue focus จาก operational status ดู [design implementation plan](design-system-implementation.md); งานยังรอ confirm

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
| [tasks.md](tasks.md) | checklist งานย่อยที่เชื่อม ticket; ยังไม่เริ่มงานพัฒนา |
| [implementation-plan.md](implementation-plan.md) | phases, gates, ลำดับงาน, effort ranges และ scope ที่รอยืนยัน |
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

## การยืนยันก่อนพัฒนา

ขอบเขตที่เสนอให้ยืนยัน: **M0–M5 / SST-001–SST-028**, macOS arm64 ก่อน, local-first, account-free; UI ใช้ React + Electron + shadcn/ui + Tailwind CSS ที่ผู้ใช้เลือกแล้ว ส่วน backend/versions/tooling ผ่าน spike/ADR ใน SST-001–002 การยืนยัน MVP ไม่รวม later tickets SST-029–038

เมื่อผู้ใช้ confirm แล้วจึงเริ่ม SST-001 ไม่ bootstrap แอป ติดตั้ง application dependencies หรือสร้าง PR/issue ภายนอกในรอบนี้ Ticket ในเอกสารเป็น backlog ภายใน repo; ยังไม่ได้เปิด ticket บน external tracker
