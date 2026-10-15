# ส่งมอบ SST-006 / T009–T010 — Keychain secrets และ snippet protection

**ผล:** implementation, TEST, REVIEW และ DELIVER ผ่านสำหรับ SST-006/T009–T010; ยังไม่ commit หรือ push

เริ่มจาก SST-005 commit `e9e9097` ตามคำสั่งผู้ใช้ “เริ่มทำต่อได้”. เพิ่ม Keychain provider ผ่าน `@napi-rs/keyring` 2.1.1 (exact pin) หลัง seam `SecretProvider` ที่คืน typed outcomes, AES-256-GCM จาก `node:crypto` สำหรับ snippet body (envelope v1 ผูก format/version/vault/snippet/field ด้วย AAD แบบ length-prefixed), journal change variants ใน commit transaction เดิม และ `packages/services` ที่มี `SecretService` (stage → OS write → lookup ก่อน retry → publish, SQL ก่อน OS delete, startup reconciliation) กับ `TransientSecrets` (TTL, dispose overwrite, purge เมื่อ lock-screen/suspend/quit). Schema ยังเป็น v1. Main โหลด keyring แบบ lazy จึงไม่ crash ถ้า binding โหลดไม่ได้; native `.node` ถูก unpack ออกจาก ASAR.

**ผลตรวจจริง:** `npm ci --ignore-scripts`, `npm run runtime:prepare`, `npm run typecheck`, `npm test` (55/55), `npm run build`, `npm run test:e2e` (11/11), `npm run package:mac` และ `npm run test:packaged` (8/8) ผ่าน; `git diff --check` ผ่าน. Keychain tests ใช้ namespace `dev.ssterm.test.<uuid>` ใหม่ทุกครั้ง และนับ item ตามชื่อ service (ไม่อ่านค่า) ได้ 0 ทั้ง test และ production namespace. ไม่มี Keychain prompt, ไม่แตะ user/Termius data หรือ SSH.

Independent tester ผ่านทุกคำสั่งและทดลอง mutation 17 แบบบนสำเนา จับได้ 12; ช่องว่าง Medium 4 ข้อเป็น test gaps. Independent reviewer ผ่าน โดยพบ Medium หนึ่งข้อ: reconcile หลัง crash อาจ publish การสลับ ref โดยไม่มี payload ของ owner (ขัด spec step 5). รอบแก้เดียวปิดทุกข้อ: owner ที่มีอยู่แล้วรับได้เฉพาะการสลับ ref, needs-input ที่พบ item แล้ว publish แทนการทิ้ง, provider ไม่ throw raw error, ยกเลิก needs-input ที่ owner หายหรือ revision เปลี่ยน และเพิ่ม tests ตาม gaps; coder ยืนยันว่าถอด guard แต่ละตัวแล้ว test ล้มหนึ่งตัวตรงจุด. Root รัน typecheck/unit/diff check และนับ Keychain ซ้ำหลังแก้

**ขอบเขตและข้อจำกัด:** adapter แยก locked/denied จาก Keychain ไม่ได้ จึงคืน `unavailable` (อ่าน) หรือ `unknown` (เขียน) แทน; app ที่ไม่ได้ sign ผูก Keychain ACL กับ binary ที่สร้าง item (SST-028); migration ยังปฏิเสธ vault ที่มี protected content ต้องแก้ก่อน schema v2; repository ตรวจเฉพาะโครงสร้าง envelope ดังนั้น IPC ในอนาคตห้ามส่ง snippet/secret changes ดิบจาก renderer; ยังไม่มี app lock หรือ verified-restore fence (SST-008/015); การล้างหน่วยความจำเป็น best effort; ยังไม่มี UI ใช้งาน (SST-017/023/024). รายละเอียดอยู่ใน [known limitations](../secret-storage.md#known-limitations)

**Rollback:** revert เฉพาะ diff ของ SST-006 เมื่อสั่ง; ลบได้เฉพาะ item ใน `dev.ssterm.test.*` ที่ tests สร้าง ห้ามแตะ `dev.ssterm.desktop.secrets` หรือ user data. ยังไม่มี deployment หรือ external PR

อ้างอิง: [secret storage](../secret-storage.md) · [ADR 0003](../adr/0003-secret-storage-and-content-protection.md) · [execution record](implementation-plan.md#sst-006-execution-plan--2026-10-15)

**ชื่อ PR ที่เสนอ:** SST-006: add Keychain secret references and authenticated snippet protection
