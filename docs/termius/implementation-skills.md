# Skills ที่แนะนำสำหรับ implementation

ค้นด้วย skill `find-skills` วันที่ 2026-10-14 เพื่อรองรับ **React + TypeScript + Electron + shadcn/ui + Tailwind CSS** ของ ssterm ตรวจ leaderboard ก่อน แล้วใช้ `skills find` ด้วย queries `electron`, `electron react`, `shadcn`, `tailwind`, `playwright electron` และตรวจ repository/source ของ candidates ก่อนคัดเลือก

**สถานะ: ผู้ใช้สั่งติดตั้งชุดหลักทั้ง 5 skills แล้ว และติดตั้งสำเร็จแบบ project-local สำหรับ Codex/Claude Code; ยังไม่เริ่ม implementation.** `find-skills` และ `reverse-engineer-anything` ที่มีอยู่เดิมคงไว้ครบ รวมโครงการมี 7 skills

ไฟล์จริงอยู่ใต้ `.agents/skills/`, Claude Code เชื่อมผ่าน `.claude/skills/` และ provenance/source paths/hashes อยู่ใน [skills-lock.json](../../skills-lock.json) ติดตั้งด้วย Skills CLI โดยเลือก `--agent codex claude-code --yes --json`; ไม่ติดตั้ง global skills หรือ application dependencies

## ชุดหลักที่แนะนำ

จำนวน installs/stars เป็น snapshot ณ วันที่ตรวจ ไม่ใช่ผล security audit และอาจต่างระหว่าง CLI กับหน้า directory

| Skill / source | Installs โดยประมาณ | GitHub repo stars | ใช้กับ ssterm | Tickets |
|---|---|---|---|---|
| [electron-best-practices — jwynia/agent-skills](https://www.skills.sh/jwynia/agent-skills/electron-best-practices) | 799 จาก CLI / 798 จากหน้าเว็บ | [172](https://github.com/jwynia/agent-skills) | Electron + React process separation, typed IPC, preload/contextBridge, effect cleanup, packaging และ Electron testing | 001,004,008,012,015,028 |
| [vercel-react-best-practices — vercel-labs/agent-skills](https://www.skills.sh/vercel-labs/agent-skills/vercel-react-best-practices) | 799K+ | [32.4K](https://github.com/vercel-labs/agent-skills) | React renderer performance, re-renders, client data flow และ bundle optimization | 013,014,016–018,020 |
| [shadcn — shadcn-ui/ui](https://www.skills.sh/shadcn-ui/ui/shadcn) | 100K+; CLI 377.2K แต่หน้าเว็บ 105.6K | [125K+](https://github.com/shadcn-ui/ui) | official component discovery/composition/customization, project-aware setup และ theme integration | 004,009,011,016–018,020,026 |
| [tailwind-design-system — wshobson/agents](https://www.skills.sh/wshobson/agents/tailwind-design-system) | 68K+ | [40K+](https://github.com/wshobson/agents) | Tailwind v4 design tokens, semantic variants, dark mode, responsive/focus patterns | 004,016–018,020,027 |
| [playwright-best-practices — currents-dev/playwright-best-practices-skill](https://www.skills.sh/currents-dev/playwright-best-practices-skill/playwright-best-practices) | 93.3K | [395](https://github.com/currents-dev/playwright-best-practices-skill) | TypeScript fixtures/locators, Electron E2E, file operations, accessibility และ regression tests | 004,018,020–022,027,028 |

## เหตุผลที่คัดเลือกและข้อจำกัด

**Electron:** ตัว `electron-best-practices` ตรง React/Electron/typed IPC มากกว่า skill desktop ทั่วไป แม้ installs ต่ำกว่า 1K จึงจัดเป็น community candidate ใช้ร่วมกับ [official Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security). ตรวจ [SKILL.md ต้นทาง](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/SKILL.md) แล้ว มี script helpers ที่ต้องใช้ Deno; รอบนี้ไม่ได้ติดตั้ง Deno หรือรัน helpers คำแนะนำเรื่อง electron-vite/Forge/Zustand/electron-store ภายใน skill ยังไม่ถือเป็น stack decision ของโครงการ ต้องคง SQLite/SecretStore candidate และ ADR ที่มีอยู่จนตัดสินใจแยก

**React:** เป็น skill จาก Vercel เอง [source](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md); ใช้ client-renderer rules ที่เกี่ยวข้อง ส่วน Next.js/SSR/RSC-specific rules ไม่ใช่ requirement ของ Electron app การใช้ skill ไม่ได้เพิ่ม Next.js เข้ามาใน stack

**shadcn:** ผู้ผลิตมี [official skill documentation](https://ui.shadcn.com/docs/skills) และ [source](https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/SKILL.md). Skill อ่าน project context จาก CLI และ `components.json`; ขณะนี้ยังไม่มี app จึงยังไม่มี component context ให้ตรวจ การติดตั้ง skill ในอนาคตไม่เท่ากับการอนุมัติ scaffold/add components ก่อน confirm implementation

**Tailwind:** ตรวจ [source](https://github.com/wshobson/agents/blob/main/plugins/frontend-mobile-development/skills/tailwind-design-system/SKILL.md) แล้ว เนื้อหาเจาะ Tailwind v4 จึงใช้เมื่อ SST-001 เลือก compatible versions นี้ ให้ semantic tokens สอดคล้อง shadcn/ui และไม่สร้าง component system ที่ซ้ำกัน

**Playwright:** [source](https://github.com/currents-dev/playwright-best-practices-skill/blob/main/playwright-best-practices/SKILL.md) มี reference เฉพาะ [Electron testing](https://github.com/currents-dev/playwright-best-practices-skill/blob/main/playwright-best-practices/testing-patterns/electron.md). เหมาะกับ TypeScript desktop tests มากกว่าเว็บ-only smoke tests แต่ SSH/SFTP/trust/cleanup ยังต้องมี project-owned lab fixtures ตาม tickets

## คำสั่งติดตั้งที่เตรียมไว้

คำสั่งต่อไปนี้ใช้ติดตั้งชุดหลักแบบ **project-local จาก repo root** แล้ว โดยเพิ่ม `--agent codex claude-code --yes --json` ในการติดตั้งจริง ไม่ใช้ `-g` สำหรับ Electron ระบุ exact source directory เพราะ default repository scan หา skill ที่ซ้อนลึกไม่พบ

```sh
npx skills add https://github.com/jwynia/agent-skills/tree/main/skills/tech/development/tooling/electron-best-practices --skill electron-best-practices
npx skills add vercel-labs/agent-skills --skill vercel-react-best-practices
npx skills add shadcn-ui/ui --skill shadcn
npx skills add wshobson/agents --skill tailwind-design-system
npx skills add currents-dev/playwright-best-practices-skill --skill playwright-best-practices
```

การติดตั้ง skills และการเริ่ม implement เป็นคนละการตัดสินใจ รอบติดตั้งนี้อัปเดต `skills-lock.json` และเพิ่ม skill directories/Claude Code links ตามคำสั่งผู้ใช้ ส่วนการเริ่ม implement ยังรอ confirmation ตามแผนเดิม ไม่ได้ติดตั้ง optional candidates ด้านล่าง

## Optional และ alternatives ที่ตรวจเพิ่ม

- [frontend-design — anthropics/skills](https://www.skills.sh/anthropics/skills/frontend-design): 985K+ installs, [repo 180K+ stars](https://github.com/anthropics/skills); ใช้เมื่อต้องกำหนด visual direction ของ original ssterm UI เพิ่ม ไม่จำเป็นต่อ core implementation และต้องปรับให้เหมาะกับ desktop utility ติดตั้งด้วย `npx skills add anthropics/skills --skill frontend-design`
- [electron-development — mindrally/skills](https://www.skills.sh/mindrally/skills/electron-development): 1.3K installs, [276 stars](https://github.com/mindrally/skills); ตรวจ [source](https://github.com/mindrally/skills/blob/main/electron-development/SKILL.md) แล้ว เป็น alternative สำหรับ Electron เบื้องต้น แต่ตัวที่คัดหลักครอบคลุม React/typed IPC/listener cleanup/packaging มากกว่า ไม่จำเป็นต้องติดตั้งทั้งสอง
- [webapp-testing — anthropics/skills](https://www.skills.sh/anthropics/skills/webapp-testing): 177K+ installs; Python/Playwright workflow เหมาะกับ renderer web preview เป็น optional เพิ่ม ไม่ใช้แทน Electron runtime/package tests
- [playwright-interactive — openai/skills](https://github.com/openai/skills/tree/main/skills/.curated/playwright-interactive): พบใน search แต่ยังไม่เลือกสำหรับ session นี้ เพราะ [source prerequisites](https://github.com/openai/skills/blob/main/skills/.curated/playwright-interactive/SKILL.md) ต้องมี `js_repl` ซึ่ง tool inventory ปัจจุบันไม่มี; รอบนี้ไม่เปลี่ยน client configuration
- Search `electron react` พบ skill ชื่อ `electron-react` ด้วยแต่ CLI รายงาน 1 install และยังไม่ได้ตรวจ source/repository quality จึงไม่แนะนำแทน candidates ที่ตรวจแล้ว

## ขอบเขตที่ skills ไม่ได้ทดแทน

ชุดนี้ช่วยเรื่อง desktop/UI/testing แต่ไม่ได้ยืนยัน SSH library capability, known-host policy, encrypted key handling, SFTP integrity/cancellation, local tunnel lifecycle หรือ secret protection ต้องทำ SST-002–015 และ SST-019–026 ตาม acceptance criteria เดิม ทักษะที่ติดตั้งไม่ใช่หลักฐานว่า feature ทำงานหรือ ticket ผ่าน

เมื่อนำมาใช้จริง ให้เลือกเฉพาะ skill ที่ตรงงานในรอบนั้น และใช้ข้อกำหนดโครงการ/ผู้ใช้เหนือ generic recommendations ไม่เปิด optional cloud/deployment/auto-updates scope เพียงเพราะ skill กล่าวถึง
