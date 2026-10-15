# เอกสารเตรียมพัฒนา ssterm

**SST-008 / T013–T014: `DONE`** — [session lifecycle/ownership](sessions.md) ผ่าน pipeline; unit 106/106, E2E 15/15, packaged 12/12 และ independent TEST/REVIEW ผ่าน ยังไม่ commit SST-008; SST-007 committed `c124b1b`. SST-009 เป็นต้นไปยังไม่เริ่ม

วิเคราะห์ Termius ที่ติดตั้งในเครื่องด้วย skill `reverse-engineer-anything` และเอกสารทางการ เพื่อเตรียม implementation อิสระของ ssterm

**สถานะ: M0 เสร็จแล้ว (2026-10-15)** — SST-001 ADR และ SST-002 isolated SSH/backend spike ผ่าน pipeline; ดู [ผลทดสอบ](spikes/ssh-compatibility.md) SST-003/T004–T005 ได้รับอนุมัติเฉพาะงานเอกสารและอยู่ `DONE`; ดู [domain/storage specification](termius/domain-storage-spec.md) storage/secrets/catalog services ส่งมอบแล้ว; SST-009–028 ยังรออนุมัติ

UI stack ที่ผู้ใช้เลือก: **React + Electron + shadcn/ui + Tailwind CSS** โดยใช้ TypeScript ตาม baseline

เริ่มอ่านที่ [Termius investigation](termius/README.md) แล้วตรวจ [tickets](termius/tickets.md), [tasks](termius/tasks.md) และ [implementation plan](termius/implementation-plan.md)

Visual specification ใช้ [Signal Blue design system](termius/design-system.md) พร้อม [แผน implement design system](termius/design-system-implementation.md) โดยอนุมัติเฉพาะ DS01/T047 ใน SST-001; DS02–DS03 อยู่ใน SST-004 ที่อนุมัติแล้ว; DS04–DS06 ยังรออนุมัติ

การตัดสินใจและ exact pins อยู่ [ADR 0001](adr/0001-mvp-platform-stack.md); pipeline/validation อยู่ [execution plan](agent-runs/implementation-plan.md)

ดู [Logo & app icon](logo/README.md) สำหรับ supplied artwork และแนวทางนำไปใช้กับแบรนด์และ macOS package

งาน SST-008: [session lifecycle/ownership](sessions.md) — main-only registry, prompts/generations, lock/owner/quit cleanup และ owned SSH fixture validation.
