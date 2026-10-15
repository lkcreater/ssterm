# SST-003 delivery — 2026-10-15

**ขอบเขต:** SST-003 / T004–T005 เป็นงานเอกสาร domain, privacy และ storage ตาม authorization วันที่ 2026-10-15; ไม่มี application scaffold, runtime/database/Keychain implementation หรือการเข้าถึงข้อมูลจริง

## ผลส่งมอบ

[Domain/storage specification](../termius/domain-storage-spec.md) กำหนด data dictionary และ ER, IDs/relations/constraints, inheritance และ delete-impact rules, field protection, การ lock/key loss/recovery/backup, versioned migration และ SecretRef journal ที่ไม่อ้าง cross-store atomicity

เอกสารมี deterministic paper walkthroughs 15 กรณี ครอบคลุม create/edit/inherit/move/delete, known-host, protected snippet, secret replacement/deletion/retry, lock, recovery และ migration failure; เป็น acceptance oracle บนกระดาษ ไม่ใช่ผล runtime

อัปเดตลิงก์และสถานะ SST-003 ให้สอดคล้องใน [architecture](../termius/proposed-architecture.md), [implementation plan](../termius/implementation-plan.md), [tickets](../termius/tickets.md), [tasks](../termius/tasks.md), [README](../termius/README.md), [repository guide](../../AGENTS.md) และ index ที่เกี่ยวข้อง

## TEST และ REVIEW

Independent TEST ตรวจ `git diff --check`, whitespace ของไฟล์ใหม่, local Markdown targets ในไฟล์ที่เปลี่ยน 11 ไฟล์ (missing 0), JSON ของ `skills-lock.json` และ `artifact-identity.json`, รวมทั้ง ticket/task IDs ที่ไม่ซ้ำ 38/52 รายการ: ผ่าน

แก้ raw table pipe และ heading เก่าตามผล TEST แล้ว; tester ตรวจซ้ำผ่าน Root ตรวจรวมชุดสุดท้ายผ่าน: Markdown ที่เปลี่ยน/เพิ่ม 12 ไฟล์, local links 137 รายการ ไม่มี target หาย, JSON 2 ไฟล์, 38 tickets/52 tasks ไม่ซ้ำ และ `git diff --check` ผ่าน Spec มี 63 table rows คอลัมน์สอดคล้อง, 19 ER edges ผ่าน static syntax check และ 15 paper walkthroughs; ไม่ได้ render diagram หรือทดสอบ runtime

Independent REVIEW พบ Medium เรื่องผลลัพธ์และ retry ที่กระจัดกระจาย; แก้เป็น vocabulary เดียวพร้อม mapping กรณี retry/ambiguous mutation และลิงก์ architecture จากนั้น re-review ผ่านโดยไม่มี actionable finding ค้าง

Root ปรับ ER ให้ private key/passphrase/password มีเจ้าของ logical record เดียว (Identity หรือ KeyMetadata) ส่วน snippet key อยู่ vault ร่วมกัน และแก้ cardinality ซ้ายเป็น `|o` ตามไวยากรณ์ Mermaid ทางการ โดยไม่เปลี่ยนความหมายของสัญญา

## ขอบเขตหลักฐานและสถานะ

ไม่มี application test/build, SQLite schema, OS Keychain operation, crypto provider หรือ migration runtime check ที่ต้องทำในงานเอกสารนี้; acceptance เหล่านั้นอยู่ SST-005/006 และงานต่อเนื่องที่ยังไม่อนุมัติ ผล M0 ใน [backend report](../spikes/ssh-compatibility.md) เป็นหลักฐานย้อนหลังของ spike เท่านั้น

SST-003/T004–T005 `DONE` หลัง final documentation validation ผ่าน; ปิด task checkboxes แล้ว ส่วน SST-004–028 ยังคงรอ implement confirmation

**Rollback:** หากจำเป็น ให้ revert เฉพาะเอกสารที่ scope ของ SST-003 และเก็บการเปลี่ยนแปลงของผู้ใช้อื่นไว้ ไม่มี runtime data หรือ secret ที่ต้อง rollback

ไม่มี commit, push, external PR หรือ deployment ในงานนี้
