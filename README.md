# ssterm

Local-first SSH desktop workspace ใช้ Electron + React + TypeScript + shadcn/ui + Tailwind CSS ตาม Signal Blue design system

ปัจจุบันมี desktop shell, typed IPC, development component showcase และ local SQLite metadata repository; catalog editing UI, credentials และการเชื่อมต่อ SSH ยังเป็นงานถัดไป ดู [สถานะและแผน](docs/termius/implementation-plan.md)

## เริ่มพัฒนา

Baseline ที่ตรวจ: macOS arm64, Node 24.11.1 และ npm 11.6.2

```sh
npm ci --ignore-scripts
npm run runtime:prepare
npm run dev
```

เปิด showcase โดยใช้ `npm run dev:renderer` แล้วไปที่ `http://127.0.0.1:5173/#showcase` หรือเปิด URL เดียวกันใน Electron development renderer; fixtures ถูกตัดออกจาก production JavaScript

## ตรวจและ package

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run package:mac
npm run test:packaged
```

`package:mac` สร้าง unsigned app ที่ `artifacts/package/SSTerm-darwin-arm64/SSTerm.app`; test reports/screenshots อยู่ `artifacts/test-results/` Tests ใช้ temporary app profiles ของตัวเอง และไม่อ่าน Termius/Keychain/เครื่อง SSH จริง

[Desktop shell / evidence](docs/desktop-shell.md) · [เอกสารโครงการ](docs/README.md) · [SSH backend spike](spikes/ssh-compat/README.md)

[Local storage / migration evidence](docs/local-storage.md) · [Storage driver ADR](docs/adr/0002-local-metadata-storage.md)
