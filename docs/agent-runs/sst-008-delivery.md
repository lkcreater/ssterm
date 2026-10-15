# SST-008 delivery — 2026-10-15

**สถานะ:** T013–T014 `DONE` ผ่าน implementation, TEST, independent REVIEW และ DELIVER; root ปิด ledger/ticket และตรวจเอกสารรวมแล้ว
**Scope:** engine-independent `SessionRegistry`, main-only composition, lifecycle prompts/errors, owner/generation fencing, cancellation, transient answers และ bounded resource cleanup
**เอกสารหลัก:** [session contract](../sessions.md) · [execution plan](implementation-plan.md#sst-008-execution-plan--2026-10-15)

Acceptance ผ่าน: config ถูก capture/freeze ตอน connect; explicit reconnect ใช้ config/generation ใหม่และไม่ replay input
Strict transitions และ finite public errors/prompts; trust rejection ปิด attempt และ credentials ไม่ออกสู่ public metadata
Owner isolation, generation fencing และ synchronous revocation ป้องกัน callback/capability เก่าฟื้น session
Ready ต้องรับ interactive channel; close/cancel/dispose idempotent และ resources มี owner เดียว
Prompt answers มีอายุจำกัดและ dispose เมื่อ consume, reject, timeout, cancel หรือ lock
Lock/suspend ปิดการทำงานจน explicit unlock; navigation/window destroy/quit ปิด owner และทรัพยากร
Production default adapter fail-closed; saved-host SSH/trust/auth และ terminal UI คงเป็น SST-009/010 และงานถัดไป

**การตรวจจริง:** `npm run typecheck` ผ่าน; `npm test` ผ่าน 106/106 รวม registry 21, composition 4 และ boundary regression ใหม่
`npm run build` ผ่าน; Electron 44.7.2, package เป็น unsigned macOS arm64
`npm run test:e2e` ผ่าน 15/15; ใช้ shipped main entry, SQLite fixture, power events และ loopback SSH fixture
`npm run package:mac` ผ่าน; `npm run test:packaged` ผ่าน 12/12 จาก packaged app
Real SSH smoke ใช้ test-only adapter ครอบ isolated spike, owned Docker fixture, explicit fixture trust/channel และตรวจ close/cancel/reconnect/cleanup
Prerequisites สำหรับ runtime SSH smoke: Docker daemon, image `ssterm-ssh-fixture:m0` และ locked dependencies ใน `spikes/ssh-compat`
Independent TEST ตรวจ typecheck และ focused checks 33/33 พร้อม decode reports; receipts ยืนยันผลครบทั้ง development/package
ASAR มี production `sessions.js` และไม่มี test helpers; ไม่มี skipped/flaky/unexpected results
SQLite/profile/temp fixtures และ owned container/listener ถูกปิด/ลบ; inherited Keychain receipts ยืนยัน leftover items = 0 ทั้งสองชุด
Independent REVIEW ผ่านโดยไม่มี actionable finding; ไม่มีการแก้ source หลัง review
ไม่เพิ่ม IPC/renderer/schema/dependency; ไม่ใช้ user, production หรือ Termius credentials/hosts

**ข้อจำกัด:** ไม่มี production SSH adapter, persistent host-trust policy หรือ saved-host auth ใน scope นี้
Lock มี event-driven test coverage แต่ยังไม่มี physical OS lock walkthrough หรือ unlock UI
Secret zeroization ใน managed JavaScript เป็น best effort; cleanup timeout/failure ต้องอ่านสถานะ cleanup ไม่อนุมานจากการรอที่จบ
การยกเลิก reconciliation ของ SecretService และ full app-lock/provider reconciliation ยังเป็นงานต่อไป

**Rollback:** ไม่มี migration, schema หรือ dependency ที่ต้องย้อนกลับ
หากพบ regression ให้ปิด app/session แล้ว revert เฉพาะไฟล์ที่ SST-008 เป็นเจ้าของตาม review; เก็บ diagnostics และ user/unrelated changes ไว้
อย่า reset/clean working tree; การ rollback source ทำเมื่อมีคำสั่ง และยังไม่มี SST-008 commit ให้ revert

**ชื่อ PR ที่เสนอ:** `feat(sessions): add fenced main-process session lifecycle`
**เนื้อหา PR ที่เสนอ:**
เพิ่ม SessionRegistry สำหรับ capture config, lifecycle/prompt/error ที่ผ่าน allowlist, owner/generation fencing และ bounded cleanup
ผูก registry กับ window, lock/suspend และ quit lifecycle โดยไม่เพิ่ม renderer/IPC capability
ตรวจด้วย typecheck, unit 106/106, E2E 15/15, packaged E2E 12/12 และ owned loopback SSH smoke
ยังไม่รวม production SSH trust/auth adapter หรือ terminal UI; ต้องเตรียม Docker fixture และ isolated spike dependencies เพื่อรัน runtime suite

ไม่มีการสร้าง PR, commit, push หรือ deploy; คำสั่ง “commit และเริ่มงานถัดไป” เปิด SST-008 implementation แต่ไม่ได้อนุมัติ SST-008 commit/push
