# SST-002 delivery — SSH/backend feasibility

**วันที่:** 2026-10-15 · **ผล:** ผ่าน M0 acceptance · **Commit:** pending root

SST-002 ปิดคำถาม compatibility ของ backend สำหรับ M0: เลือก `ssh2 1.17.0` เป็น baseline สำหรับงาน adapter ถัดไป จาก fixture SSH/SFTP ที่โครงการเป็นเจ้าของและ probe ร่วมกันบน Node กับ Electron package หลักฐานและข้อจำกัดอยู่ใน [compatibility report](../spikes/ssh-compatibility.md)

## ขอบเขตและ acceptance

- T002: fixture สร้าง user, รหัสผ่าน, encrypted Ed25519 client key, server keys และพอร์ตเฉพาะรัน; SSH bind เฉพาะ loopback
- T003: ผ่าน trust/reject/changed-key, password/key/PAM auth, PTY/resize/UTF-8/exit, SFTP integrity, loopback forwarding, cancellation/deadline, bounded output และ lifecycle cleanup
- Probe matrix ผ่านครบ **19/19 บน Node และ 19/19 บน packaged Electron**; Node มี 4 test cases รวม regression 3 กรณี
- Review รอบสุดท้ายผ่าน ไม่มี High หรือ Medium คงเหลือ; ข้อจำกัด descendant-process ระบุไว้ในรายงานหลัก
- ส่งมอบเฉพาะ isolated fixture/spike; ไม่มี production UI, service, IPC, real Keychain operation หรือข้อมูลผู้ใช้

## การตรวจสอบจริง

รันจาก `spikes/ssh-compat` บน macOS 15.7.4 arm64, Node 24.11.1/npm 11.6.2; fixture ใช้ Debian OpenSSH 9.2/OpenSSL 3.0.22

- `npm run check` — ผ่าน syntax checks
- `npm test` — ผ่าน 4 Node tests; integration 19 probes และ regression 3 กรณี
- `npm run package:mac` — สร้าง local unsigned arm64 `.app` ด้วย Electron 44.7.2, bundle ID `dev.ssterm.spike`
- `npm run test:packaged` — เปิด executable ของ `.app` จริงและผ่าน 19/19 probes หลัง `app.whenReady()`
- ทั้งสอง runtime ยืนยันว่า optional native binding ไม่ได้โหลด; ไม่พบ fixture container หรือ temporary key directory ค้างหลังจบ
- Sanitized reports: [Node](../spikes/evidence/node-report.json), [packaged](../spikes/evidence/packaged-report.json), [environment และ hashes](../spikes/evidence/environment.json)

## ข้อจำกัดและ rollback

ผลยืนยันเฉพาะ Debian OpenSSH/PAM หนึ่ง fixture, macOS arm64 หนึ่งเครื่อง และ key/algorithm ที่ทดสอบ ไม่ครอบคลุม native SSH ABI, production IPC/UI/IME, storage/Keychain, signing/notarization หรือ release acceptance; `.app` เป็น feasibility artifact ไม่ใช่ production app

ทำซ้ำตาม [spike README](../../spikes/ssh-compat/README.md) โดยใช้เฉพาะ container และ temporary paths ที่รันสร้างไว้ ห้าม prune Docker หรือ cleanup ทรัพยากรอื่นแบบกว้าง หากต้อง rollback ให้ revert เฉพาะ commit ของ SST-002 โดยคง SST-001 (`ad9ed51`) ไว้

**PR:** ไม่ได้สร้างตามขอบเขตที่อนุมัติ · **ชื่อ commit ที่แนะนำ:** `feat: verify SSH backend with isolated and packaged probes`
