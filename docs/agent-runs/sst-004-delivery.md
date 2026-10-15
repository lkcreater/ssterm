# SST-004 — บันทึกส่งมอบ

**2026-10-15 · SST-004/T006–T007/DS02–DS03/T048–T049 · TEST และ REVIEW ผ่าน** ขอบเขตตาม [แผน](implementation-plan.md#sst-004-execution-plan--2026-10-15) หลัง SST-003 (`603e600`); ไม่มี commit/push ในงานนี้

ส่งมอบ desktop shell สำหรับ macOS arm64 ด้วย Electron, React และ TypeScript, typed IPC ที่ตรวจ sender/payload/owner/generation, Signal Blue UI และ component showcase สำหรับ development พร้อม fixture recipes ไม่มีบริการ SSH หรือ storage จริง

- Renderer ใช้ Base UI/nova, Lucide และ shadcn components 33 รายการ; bundled Inter, JetBrains Mono และ Noto Sans Thai รวม 16 WOFF2 พร้อม OFL source 3 ชุด อ้างอิงวิธีเริ่มงานใน [README](../../README.md)
- Showcase เป็น development-only ที่ `http://127.0.0.1:5173/#showcase`; production เปิด empty workspace และไม่ bundle fixture catalog
- หน้าต่างเริ่ม 1280×800 ขั้นต่ำ 960×640; package อยู่ที่ `artifacts/package/SSTerm-darwin-arm64/SSTerm.app`, app ID `dev.ssterm.desktop`

**หลักฐานตรวจ:** `npm ci --ignore-scripts`, `npm run runtime:prepare`, `npm run typecheck`, `npm test` (13/13), `npm run build`, `npm run test:e2e` (7/7) และ `npm run package:mac` ผ่าน; `npm run test:packaged` ผ่าน 4/4. E2E ทั้งสองชุดไม่มี failure, flaky หรือ skipped. รายงานจริงอยู่ใน `artifacts/test-results/development.json` และ `artifacts/test-results/packaged.json`; screenshots ครอบคลุม 1280×800 และ 960×640. Showcase ตรวจ UI inventory 33/33 และคู่สีตัวอย่าง 12 คู่ตามเกณฑ์ที่ระบุใน [หลักฐาน desktop](../desktop-shell.md)

**REVIEW:** ไม่มีข้อแก้ไขที่ยังค้าง. ขอบเขตที่ยังไม่พิสูจน์/ไม่รวม ได้แก่ SSH, SQL, Keychain, session/SFTP/snippets/tunnels; native Thai IME, VoiceOver, full workflow contrast/scaling/performance และ production icon exports/signing/notarization ยังเป็นงานภายหลัง. Package เป็น unsigned local build; ผล contrast เป็นตัวอย่าง ไม่ใช่การรับรอง accessibility ทั้งแอป

Rollback ทำได้โดย revert เฉพาะไฟล์ของ SST-004 และคง artifacts/evidence ที่ต้องใช้ตรวจสอบไว้; ไม่มีการย้ายข้อมูลผู้ใช้หรือเปลี่ยนข้อมูลถาวร. SST-005 เป็นต้นไปยังไม่เริ่ม และไม่มีการเผยแพร่หรือ deploy.
