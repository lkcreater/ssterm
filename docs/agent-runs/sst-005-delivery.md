# ส่งมอบ SST-005 / T008 — SQLite metadata repository

**ผล:** implementation, TEST, REVIEW และ DELIVER ผ่านสำหรับ SST-005/T008; ไม่มีการ commit หรือ push ในงานนี้

เริ่มจาก SST-004 commit `d6e1822` ตามคำสั่งผู้ใช้ และเพิ่ม repository SQLite แบบ local-first โดยใช้ `node:sqlite` ที่มากับ Node 24 ผ่าน `packages/domain`, `packages/adapters` และ main process ของ Electron. ฐานข้อมูล v1 มี schema/constraints, finite atomic CRUD, catalog/row revisions, graph validation, normalization และ settings allowlist; แอปเปิด storage หลังได้ single-instance ownership และก่อนสร้างหน้าต่าง โดยส่งให้ UI เฉพาะ startup health แบบ sanitized.

มี WAL-aware online backup พร้อม checksum/manifest และการจองปลายทางแบบ exclusive, การตรวจไฟล์/ไดเรกทอรีด้วย POSIX mode gate, fail-closed เมื่อพบฐานข้อมูลเสียหาย/ไม่รู้จัก/ใหม่กว่า/ไม่รองรับ หรือมี journal ค้าง และ migration runner ที่ preflight ทั้งสาย เก็บ original backup และ commit ทีละขั้นพร้อม version. ไม่ reset หรือ replace ไฟล์ต้นฉบับเมื่อปฏิเสธการเปิด. Protected record mutations ยังปิดไว้จนกว่า SST-006 จะจัดหา provider ที่ตรวจสอบแล้ว.

**ผลตรวจจริง:** `npm ci --ignore-scripts`, `npm run runtime:prepare`, `npm run typecheck`, `npm test` (33/33 รวม storage 18), `npm run build`, `npm run test:e2e` (10), `npm run package:mac` และ `npm run test:packaged` (7) ผ่านทั้งหมด. E2E ใช้ main-only `storage.js` ที่ bundle เข้า ASAR; packaged app เป็น macOS arm64 unsigned. การทดสอบใช้ฐานข้อมูลและโปรไฟล์ชั่วคราวของโครงการเท่านั้น.

Independent tester ยืนยันผล unit/E2E/package และตรวจว่า `privatePermissions: true` ใช้กับการแนบรายงาน development/packaged. Reviewer พบ Medium เรื่อง source mode `0644` กับ parent mode `0755` ภายใต้ privacy gate; แก้ให้ gate ปฏิเสธก่อนเขียนโดยไม่ chmod อัตโนมัติ เพิ่ม regression unit cases 2 กรณี และทดสอบ runtime จริง จากนั้น focused re-review ผ่านโดยไม่พบประเด็นค้าง. หลัง gates เหล่านี้ source ไม่เปลี่ยน; มีเพียงบันทึกส่งมอบนี้เป็น bookkeeping.

ผล packaged artifact ยืนยันว่ามี stable main entry `storage.js` และ bundled chunk ใช้ built-in SQLite ได้; ไม่ได้พิสูจน์ความล้มเหลวของ `better-sqlite3` ซึ่งไม่ได้ติดตั้งหรือทดสอบ. Host Node 24.11.1 แสดง experimental SQLite warning ตาม ADR; packaged Electron 44.7.2 ใช้ Node 24.21.0 / SQLite 3.53.4.

**ขอบเขตและข้อจำกัด:** รองรับ schema v1 เท่านั้น; synthetic migration steps ทดสอบ runner แต่ไม่ใช่การอ้างว่ามี legacy upgrade ที่ปล่อยใช้งานแล้ว. Permission gate ตรวจ POSIX mode bits ไม่ได้ audit ACL เพิ่มเติม. ประสิทธิภาพ catalog ขนาดใหญ่, resolver/inheritance, catalog editing UI, secrets/Keychain/protected values, SSH/session services และ release acceptance อยู่ในงานถัดไป; งานนี้ไม่ได้ส่งมอบ MVP ทั้งหมด.

**Rollback:** ปิด app/DB handles และลบได้เฉพาะ fixture หรือ artifact ชั่วคราวที่งานนี้เป็นเจ้าของ. หากต้องย้อน source ให้ revert เฉพาะ diff ของ SST-005; เก็บฐานข้อมูล/WAL เดิมและ original pre-migration backup ไว้ ห้าม reset/ลบ user data หรือ replay secret journal. ยังไม่มี deployment หรือ external PR.

อ้างอิง: [รายละเอียด storage](../local-storage.md) · [ADR 0002](../adr/0002-local-metadata-storage.md) · [execution record](implementation-plan.md#sst-005-execution-plan--2026-10-15)

**ชื่อ PR ที่เสนอ:** SST-005: add versioned local SQLite metadata repository
