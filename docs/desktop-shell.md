# SST-004 — Desktop shell / design system / typed IPC

**2026-10-15 · DONE: independent TEST/REVIEW/DELIVERY passed.** ผู้ใช้อนุมัติ “commit และทำงานถัดไปต่อ”; SST-003 committed `603e600` แล้ว งานนี้ครอบคลุม T006/T007/DS02–DS03/T048–T049

## สิ่งที่ implement

- [Desktop workspace](../apps/desktop/package.json): Electron 44.7.2 + React 19.3.0 + TypeScript 7.0.2; native macOS titlebar, initial 1280×800/minimum 960×640 และ empty workspace ที่ระบุว่าการเชื่อมต่อยังไม่พร้อม
- [Main](../apps/desktop/src/main/index.ts), [preload](../apps/desktop/src/preload/index.ts) และ [contracts](../packages/contracts/src/index.ts): `window.ssterm.bootstrap/ping/onWindowState` ผ่าน named channels เท่านั้น; strict payload/result validation, registered sender/main-frame/exact-document/window-generation checks และ ordered events/idempotent unsubscribe
- Sandbox/context isolation/web security เปิด; Node/webview ปิด; permissions/popups/unapproved navigation ถูกปฏิเสธ External allowlist ว่าง Production ใช้ exact local file URL และไม่อ่าน dev-server configuration; CSP ไม่อนุญาต network connections หรือ inline scripts ส่วน development อนุญาต inline React Refresh และ HMR เฉพาะ loopback port ที่กำหนด [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Signal Blue tokens](../apps/desktop/src/renderer/src/styles/globals.css), Base UI/nova/Lucide และ generated shadcn components 33 รายการ; 32px controls/rows, 4px grid, 8/12px radii และ 2px focus แยก selection จาก operational states
- [Development showcase](../apps/desktop/src/renderer/src/showcase/index.tsx): foundations/state matrices, long/Thai labels, forms/navigation/dialog/toast และ terminal/SFTP/tunnel/credential fixture recipes; `import.meta.env.DEV` guard ตัด fixture catalog ออกจาก production bundle ไม่มี simulated SSH backend
- Inter/JetBrains Mono/Noto Sans Thai Variable 5.3.0 พร้อม OFL licenses ใน renderer public assets; `assetsInlineLimit: 0` รักษา font subsets เป็น local files ให้ทำงานกับ `font-src 'self'`; terminal ANSI16/typography แยกจาก app tokens ใช้ supplied monogram เดิมโดยไม่แก้ artwork

## Verification

Actual root checks: clean `npm ci --ignore-scripts` และ explicit `npm run runtime:prepare`; `npm run typecheck`, `npm test` (13/13 unit), `npm run build`, `npm run test:e2e` (7/7) และ `npm run package:mac` ผ่าน `npm run test:packaged` ผ่าน 4/4 พร้อม independent TEST/REVIEW/DELIVERY

E2E ใช้ Playwright 1.64.1 กับ actual Electron โดยเปิด Chromium sandbox และ temporary profiles; ตรวจ real IPC malformed/cross-window/stale generation, unauthorized second window, denied permissions/navigation/popups, ordered event cleanup และ offline fonts พร้อม schema/result sanitization ตรวจหน้า shell/showcase ที่ 1280×800 และ 960×640 ไม่มี horizontal page overflow; Thai text entry, 32px input/2px focus, selected+connected+PROD, modal focus trap/return และ reduced motion ผ่าน

Showcase วัด 12 foreground/background pairs จาก browser-resolved colors; text pairs ≥4.5:1 และ essential boundary ≥3:1 Structural `--border` ยังใช้สีเดิมที่ contrast ต่ำ จึงไม่ใช้เป็น sole essential input boundary ผลนี้ไม่รับรองทุก composition หรือ accessibility ทั้งแอป

Generated artifacts (ไม่ commit): `artifacts/test-results/development.json`, `artifacts/test-results/packaged.json`, screenshots ใต้ `artifacts/test-results/{development,packaged}/` และ `artifacts/package/SSTerm-darwin-arm64/SSTerm.app` Build/package ใช้ pinned runtime เดียวกัน พร้อม bundled renderer และ ASAR

## ข้อจำกัดและงานต่อ

ไม่มี production SQL/Keychain/SSH/session/SFTP/snippet execution/tunnel services; fixture labels ไม่ใช่ live connection state Window ownership ที่ทดสอบไม่ใช่ session capability acceptance ซึ่งอยู่ SST-008 Native Thai IME, OS accessibility/VoiceOver, full contrast/scaling/performance, signing/notarization และ production macOS icon exports อยู่ gates ถัดไป DS04–DS06/SST-027–028; packaged font smoke ไม่ปิด DS06 ทั้งหมด

Package เป็น unsigned local build; SST-005 เป็นต้นไปยังไม่ได้เริ่ม รอบนี้ไม่มี commit SST-004, push หรือ deployment [Scope/ownership](agent-runs/implementation-plan.md#sst-004-execution-plan--2026-10-15) · [Tasks](termius/tasks.md) · [Design handoff](termius/design-system-implementation.md)

ส่งมอบครบ pipeline: [SST-004 delivery](agent-runs/sst-004-delivery.md). ไม่มีประเด็น review ค้าง
