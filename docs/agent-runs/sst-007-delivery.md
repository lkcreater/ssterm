# SST-007 — Delivery

**สถานะ:** T011–T012 เสร็จตามขอบเขตที่อนุมัติ; TEST และ REVIEW ผ่าน · 2026-10-15

SST-007 เพิ่ม config resolution และ catalog workflows ที่ main/service boundary โดยไม่เพิ่ม UI, SSH/session behavior, IPC หรือ schema/dependency ใหม่ ดู [catalog](../catalog.md) และ [execution record](implementation-plan.md#sst-007-execution-plan--2026-10-15)

ขอบเขตที่ส่งมอบ:

- Pure resolver/query/tree รองรับ inheritance, clear, defaults, provenance, scope, search และ tag filters; ผลลัพธ์ถูกคัดลอกและ freeze
- Catalog service รองรับ intent แบบจำกัดสำหรับ CRUD และการกำหนด host tag
- Preview token ผูก catalog revision, อายุ 5 นาที และจำกัด 64 รายการ; apply ตรวจ revision และใช้ transaction แบบ atomic
- Preview แสดงผลกระทบจาก connection, provenance และ hierarchy path
- การลบ host/group/identity/tag จัดการ references และผลกระทบตามนโยบายที่ระบุ
- การลบ/ลืม credential บันทึก cleanup ใน journal และคืน pending IDs; catalog ไม่เรียก OS provider
- เพิ่มการเปลี่ยน snippet-tag ที่คง ciphertext เดิม และ main-only entry

Acceptance ครอบคลุม immutable inherited configs/provenance, query scopes, search/tag AND,
stale/expired/replayed previews, revision conflicts, cycle/move, deletion และ identity impacts,
การคง trust/key และ snippet ciphertext, pending cleanup เมื่อถูกปฏิเสธ และ SQLite rollback

การตรวจสอบขั้นสุดท้ายผ่าน:

- `npm run typecheck`
- `npm test` — 80/80 รวม pure catalog 11 และ SQLite/memory-provider 14 รายการ
- `npm run build`
- `npm run test:e2e` — 13/13
- `npm run package:mac` — สำเร็จ; unsigned macOS arm64
- `npm run test:packaged` — 10/10
- ผู้ทดสอบอิสระรัน typecheck และ catalog unit 25 รายการซ้ำ; decoded reports ยืนยัน receipts ครบ
- ผู้ทบทวนอิสระไม่พบข้อแก้ไขที่ดำเนินการได้; ไม่มีการแก้ source หลัง review
- Keychain regression ของ SST-006 ใช้เฉพาะ `dev.ssterm.test.*` และยืนยันว่าเหลือศูนย์รายการ

ข้อจำกัด: ไม่มี catalog UI (SST-016) หรือ SSH/session (SST-008); cleanup รอ `SecretService.reconcile`; batch จำกัด 1,000 changes; ข้อจำกัด SST-006 อยู่ใน [secret storage](../secret-storage.md#known-limitations). ไม่มีการเปลี่ยน renderer/preload

Rollback เฉพาะ diff SST-007 เมื่อได้รับคำสั่ง โดยรักษา user data, production Keychain และ
การเปลี่ยนแปลงอื่น; cleanup ทดสอบเฉพาะ namespace `dev.ssterm.test.*` ที่งานนี้สร้าง
ไม่มี commit, push หรือ deployment

**ชื่อ PR ที่แนะนำ:** `feat(catalog): add revision-fenced catalog workflows`

**เนื้อหา PR ที่แนะนำ:** เพิ่ม pure config resolution/provenance, queries และ revision-fenced
impact previews พร้อม atomic CRUD/deletion และ queued cleanup ที่ main-only boundary. ผ่าน
typecheck, unit 80/80, build, development E2E 13/13, unsigned macOS arm64 package และ
packaged E2E 10/10. UI และ SSH/session อยู่นอก scope.

**Commit follow-up:** ผู้ใช้สั่ง commit และเริ่มงานถัดไป; SST-007 committed `c124b1b` ก่อนเปิด SST-008 ไม่มี push.
