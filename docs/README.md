# เอกสารเตรียมพัฒนา ssterm

วิเคราะห์ Termius ที่ติดตั้งในเครื่องด้วย skill `reverse-engineer-anything` และเอกสารทางการ เพื่อเตรียม implementation อิสระของ ssterm

**สถานะ: อนุมัติ M0 เท่านั้น (2026-10-14)** — SST-001 `DONE` เป็น ADR/เอกสาร; SST-002 `NOT_STARTED` รอ SST-001 delivery + commit ก่อน ยังไม่มี application code; SST-003–028 ยังรออนุมัติ

UI stack ที่ผู้ใช้เลือก: **React + Electron + shadcn/ui + Tailwind CSS** โดยใช้ TypeScript ตาม baseline

เริ่มอ่านที่ [Termius investigation](termius/README.md) แล้วตรวจ [tickets](termius/tickets.md), [tasks](termius/tasks.md) และ [implementation plan](termius/implementation-plan.md)

Visual specification ใช้ [Signal Blue design system](termius/design-system.md) พร้อม [แผน implement design system](termius/design-system-implementation.md) โดยอนุมัติเฉพาะ DS01/T047 ใน SST-001; DS02–DS06 ยังรออนุมัติ

การตัดสินใจและ exact pins อยู่ [ADR 0001](adr/0001-mvp-platform-stack.md); pipeline/validation อยู่ [execution plan](agent-runs/implementation-plan.md)

ดู [Logo & app icon](logo/README.md) สำหรับ supplied artwork และแนวทางนำไปใช้กับแบรนด์และ macOS package
