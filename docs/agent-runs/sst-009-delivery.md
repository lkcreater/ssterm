# ส่งมอบ SST-009 / T015 — Known-host verification และ trust decisions

**ผล:** implementation, TEST, REVIEW (รวม focused re-review) และ DELIVER ผ่านสำหรับ SST-009/T015; ยังไม่ commit หรือ push

เริ่มจาก SST-008 commit `bcbb693` และ Makefile `b6716fd` ตามคำสั่ง “ทำงานถัดไปต่อได้เลย”. Session เดิมหยุดกลาง IMPLEMENT (unit 124/124, E2E 16/17); session นี้รับช่วงหลังตรวจว่าไม่มี ssterm session อื่นทำงานอยู่ ตามคำสั่ง “ทำ SST-009 ให้เสร็จตรวจสอบยังค้างอะไรอยู่”.

เพิ่ม `KnownHostPolicy` ที่ใช้ร่วมกันใน main: parse public key จาก wire bytes ด้วย `ssh2.utils.parseKey` (จำกัด 16 KiB, public-only, roundtrip ตรง), SHA-256 fingerprint, accept-once (ไม่เขียน row), remember, reject, changed key ที่ block จนกว่าจะ replace อย่างตั้งใจ และ revoke แบบ one-use/TTL/owner-fenced. Prompt ผูกกับ session generation และถูกยกเลิกเมื่อ lock/owner revoke/ปิด session. UI มี prompt สำหรับ host ใหม่, คำเตือน key เปลี่ยนพร้อม fingerprint เก่า/ใหม่, ยืนยันการแทน key, รายการ known hosts และยืนยันการ revoke ผ่าน IPC ที่ตรวจ sender/frame/owner. Production adapter ยัง fail closed จนถึง SST-010.

**ผลตรวจจริง:** `npm run typecheck`, `npm test` (129/129), `npm run build`, `npm run test:e2e` (17/17 กับ Docker fixture `ssterm-ssh-fixture:m0` จริง), `npm run package:mac` และ `npm run test:packaged` (14/14) ผ่าน; `git diff --check` ผ่าน. Fixture ลำดับจริง: reject, reject, accept-once, remember, reject, reject, replace, reject; authentication start 5 ครั้งเท่ากับ channel ที่เปิด 5. Contrast ที่วัดจริง 21 จุด ≥ 4.5:1. Keychain `dev.ssterm` เหลือ 0, ไม่มี container ค้าง, ASAR ไม่มี test helper หรือ private key ตัวอย่างของ ssh2.

E2E ที่เคย fail เป็น race ของ test: dialog รอบก่อนที่ตอบแล้วยังค้างบนจอและรับ Escape ของรอบถัดไป; แก้ให้ test รอ dialog เดิมหายก่อน (เข้มขึ้น ไม่ได้ลดเงื่อนไข). Tester และ reviewer พบ Medium เดียวกันแยกกัน: fence ระดับทั้งฐานข้อมูลทำให้การบันทึกที่ไม่เกี่ยวข้องเปลี่ยนคำตอบของผู้ใช้เป็น `conflict`. แก้ให้ fence เฉพาะ row ของ endpoint นั้น และให้การ verify key ที่ตรงกันเป็นแค่การบันทึกเวลา ไม่เลื่อน revision; focused re-review ผ่าน.

**ขอบเขตและข้อจำกัด:** ส่วนที่ต่อ policy เข้ากับ transport (`hostVerifier`, ไปต่อเฉพาะเมื่อ ok) มีอยู่ใน test fixture เท่านั้น SST-010 ต้องพิสูจน์ซ้ำด้วย production adapter; ยังไม่มี SFTP/tunnel ที่เรียก policy จริง; `ssh2/util/pagent.exe` ยังติดไปใน package (SST-028); Remember/Replace/revoke ยังเลื่อน catalog revision ทำให้ catalog preview ที่เปิดค้างต้องเตรียมใหม่. รายละเอียดใน [known hosts](../known-hosts.md)

**Rollback:** revert เฉพาะ diff ของ SST-009 เมื่อสั่ง; ลบได้เฉพาะ container/profile/DB/Keychain namespace `dev.ssterm.test.*` ที่ tests สร้าง; trust ที่บันทึกไว้ไม่ถูกลบเมื่อเกิดความล้มเหลว. ยังไม่มี deployment หรือ external PR

อ้างอิง: [known hosts](../known-hosts.md) · [execution record](implementation-plan.md#sst-009-execution-plan--2026-10-15)

**ชื่อ PR ที่เสนอ:** SST-009: add shared known-host verification and trust decisions
