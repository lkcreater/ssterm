# ssterm

Local-first SSH desktop workspace ใช้ Electron + React + TypeScript + shadcn/ui + Tailwind CSS ตาม Signal Blue design system

ปัจจุบันมี desktop shell, typed IPC, development component showcase, SQLite repository, Keychain/protected content, catalog domain และ session lifecycle; catalog/credential UI และ production saved-host SSH ยังเป็นงานถัดไป ดู [สถานะและแผน](docs/termius/implementation-plan.md)

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

`package:mac` สร้าง unsigned app ที่ `artifacts/package/SSTerm-darwin-arm64/SSTerm.app`; test reports/screenshots อยู่ `artifacts/test-results/` Tests ใช้ temporary app profiles, Keychain เฉพาะ namespace `dev.ssterm.test.*` และ SSH fixture จริงของโปรเจกต์บน loopback; ไม่อ่าน Termius หรือใช้ production/user credentials/hosts

[Desktop shell / evidence](docs/desktop-shell.md) · [เอกสารโครงการ](docs/README.md) · [SSH backend spike](spikes/ssh-compat/README.md)

[Local storage / migration evidence](docs/local-storage.md) · [Storage driver ADR](docs/adr/0002-local-metadata-storage.md)

[Catalog / inheritance / impact previews](docs/catalog.md) — main-side workflows; catalog editing UI remains SST-016.

SST-008 session lifecycle/ownership and runtime evidence: [sessions](docs/sessions.md). The main-only registry is composed with window/power/quit hooks; production saved-host SSH/trust/auth and terminal UI remain later tickets.

SST-008 Electron/packaged tests also require the Docker fixture image and isolated spike dependencies; see [runtime prerequisites](docs/sessions.md#verification). These test helpers are excluded from the app package.
