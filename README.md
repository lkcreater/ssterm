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

ใช้ [Makefile](Makefile) เรียก workflow เดียวกันได้:

```sh
make help          # ดูคำสั่งทั้งหมด
make install       # ติดตั้ง workspace dependencies และเตรียม Electron
make dev           # เปิดแอปสำหรับพัฒนา
make check         # typecheck → unit tests → build
make fixtures      # เตรียม SSH test dependencies และ image; ต้องเปิด Docker
make verify        # check → Electron E2E → package → packaged tests
```

`make test-e2e` และ `make test-packaged` build ใหม่ก่อนทดสอบ ใช้ `make fixtures` เตรียม prerequisites ครั้งแรกและเมื่อ fixture/dependencies เปลี่ยน; คำสั่งทดสอบไม่ติดตั้ง dependencies หรือ build Docker image ให้อัตโนมัติ

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

AI agent (SST-041) ปิดไว้เป็นค่าเริ่มต้น และทำงานผ่าน CLI ของผู้ใช้เอง (`claude`); ssterm ไม่ติดต่อ AI provider เอง ดูข้อมูลที่ส่งออกและ privacy notes ที่ [AI agent](docs/ai-agent.md) และ [AI scope](docs/ai-scope.md)

[Desktop shell / evidence](docs/desktop-shell.md) · [เอกสารโครงการ](docs/README.md) · [SSH backend spike](spikes/ssh-compat/README.md)

[Local storage / migration evidence](docs/local-storage.md) · [Storage driver ADR](docs/adr/0002-local-metadata-storage.md)

[Catalog / inheritance / impact previews](docs/catalog.md) — main-side workflows; catalog editing UI remains SST-016.

SST-008 session lifecycle/ownership and runtime evidence: [sessions](docs/sessions.md). The main-only registry is composed with window/power/quit hooks; production saved-host SSH/trust/auth and terminal UI remain later tickets.

SST-008 Electron/packaged tests also require the Docker fixture image and isolated spike dependencies; see [runtime prerequisites](docs/sessions.md#verification). These test helpers are excluded from the app package.
