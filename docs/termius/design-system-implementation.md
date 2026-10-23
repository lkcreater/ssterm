# Design system implementation plan

**สถานะ: DS01/T047 `DONE`; DS02–DS03/T048–T049 `DONE` ใน SST-004 ที่อนุมัติแล้ว.** [Desktop shell/evidence](../desktop-shell.md) มี semantic CSS, 33 shared primitives, offline fonts/licenses และ development showcase; unit/development/packaged checks ผ่าน ผ่าน independent TEST/REVIEW/DELIVERY; DS04–DS06 ยัง `AWAITING_IMPLEMENT_CONFIRMATION`; production icon exports ยังไม่ทำ

> **SST-040 (2026-10-22–23, UI v2 Charcoal):** [ADR 0008](../adr/0008-ui-v2-charcoal.md) แทนที่ navy surfaces, overlay pattern และ shell ของ Signal Blue: tokens Charcoal, terminal theme Charcoal แบบอ่านอย่างเดียว; titlebar มีแค่ traffic lights + drag region; sidebar มี icon v2, เก้าหน้า, group tree และ footer (Settings, Keyboard shortcuts, Lock workspace); ทุกหน้ามี page header; ไม่มี global status bar (ใช้ Servers footer summary และ pane header + pane status bar ต่อ pane แทน); ทุก form/settings/tool/confirmation เป็น right-edge `Drawer` (`components/drawer.tsx`) และลบ `ui/dialog.tsx`/`ui/alert-dialog.tsx` แล้ว สถานะ DS01–DS06 และข้อความ Signal Blue ด้านล่างเป็นบันทึกเดิม ([decisions](../agent-runs/implementation-plan.md#sst-040-authorization--ui-v2-charcoal-2026-10-22))

ใช้ [Design System v1.0 — Signal Blue](design-system.md) เป็น visual specification หลักของ ssterm และใช้ [architecture](proposed-architecture.md), [tickets](tickets.md) และ [tasks](tasks.md) สำหรับพฤติกรรมและขอบเขต MVP ข้อกำหนดนี้เป็น design ของ ssterm ไม่ใช่หลักฐาน UI ภายใน Termius

## Baseline และขอบเขต

| หัวข้อ | ข้อกำหนดสำหรับ implementation |
|---|---|
| Stack | Electron + React + TypeScript + shadcn/ui + Tailwind CSS; Tailwind 4.3.3 และ @tailwindcss/vite 4.3.3 ตาม ADR; SST-004 real build/render และ packaged smoke ผ่าน |
| Direction | Signal Blue: deep navy surfaces, electric blue สำหรับ focus/selection/action; brand line “Connected with clarity.” |
| Theme | dark-first สำหรับ MVP; light palette เป็น proposed later work ไม่เพิ่ม light-mode toggle ก่อน validated theme พร้อม |
| Typography | Inter สำหรับ UI, JetBrains Mono สำหรับ terminal/code; offline font assets/license และ Thai/system fallback ต้องตรวจ |
| Density | ADR default: controls/rows 32 px, spacing grid 4 px, radius controls 8 px/dialogs 12 px, focus ring 2 px; comfortable variants ภายหลังตาม spec |
| Terminal | terminal-first layout; foreground/background/cursor/selection/ANSI 16 แยกจาก application theme |
| State semantics | สีฟ้าแสดง active/focus; connected เขียว, connecting เหลือง, error แดง, disconnected muted; status มี icon + label และ PROD มีข้อความชัดเจน |
| Branding | ใช้ SST-style artwork ที่ส่งมาใน [logo/icon handoff](../logo/README.md); `icon-logo.png` เป็น source icon reference, `brand-logo.png` เป็น brand lockup; production exports/edge QA ยังไม่เสร็จ |

Spec ที่พูดถึง agent auth, remote/dynamic tunnels, favorites, quick connect หรือ workflow อื่นนอก MVP ใช้เป็น future visual vocabulary เท่านั้น ไม่เพิ่ม functional scope จาก [tickets SST-001–028](tickets.md) โดยอัตโนมัติ

## ลำดับงานและผู้รับผิดชอบใน backlog

| Step | Deliverable | Parent ticket / task | Depends on | Acceptance |
|---|---|---|---|---|
| DS01 | Design integration ADR | SST-001 / T047 | M0 confirmed 2026-10-14 | บันทึก spec v1.0, Tailwind/version compatibility, shadcn base/style/icon library, alias/paths, density defaults และ contrast gaps โดยคง Signal Blue |
| DS02 | Semantic tokens / type / spacing foundation | SST-004 / T048 | DS01 และ app shell | Token mapping ครบ, fonts ใช้ offline ได้, Thai fallback ชัดเจน, app/terminal themes แยก, ไม่มี raw brand colors กระจายใน components |
| DS03 | Shared components + internal showcase | SST-004 / T049 | DS02 | Components ตาม inventory มี variants/states/accessible labels; showcase แสดงทุก state ที่ต้องตรวจ รวม selected+error/focus+connected |
| DS04 | Product recipes / terminal-first shell | SST-018 / T050 | DS03 และ session/catalog dependencies เดิม | Target/context ชัดทุก pane; titlebar/drag regions ถูกต้อง; sidebar/panels resize/collapse; terminal theme ไม่ถูก app CSS override |
| DS05 | Visual / accessibility acceptance | SST-027 / T051 | DS04 และ MVP workflows | Contrast, keyboard/focus, reduced motion, Thai/IME, long labels, resizing และ status independence ผ่านบน rendered Electron app |
| DS06 | Font/icon packaging | SST-028 / T052 | DS05 และ supplied artwork reference | Fonts/license/fallback รวมใน package; derived icon sizes/formats จาก `icon-logo.png` ผ่าน edge/padding/legibility QA และ packaged smoke; reference PNG ไม่ถือว่า production exports พร้อม |

ใช้หมายเลข ticket เดิม 38 รายการ และเพิ่มงานย่อย T047–T052 การเปลี่ยนชื่อ parent ticket ไม่ใช่การสร้าง ticket ซ้ำหรือเปลี่ยน dependencies ของ SSH backend

## Token integration contract

1. เก็บ hex values ใน design spec เป็นแหล่งอ้างอิง; map ให้ shadcn semantic variables ใน stylesheet ที่ `components.json` ระบุจริง ไม่เปลี่ยนเป็น palette จาก preset โดยเงียบ
2. สำหรับ Tailwind v4 เชื่อม shadcn variables ผ่าน `@theme inline` ไปยัง `--color-*`, `--font-*` และ radius/type tokens เพื่อให้ application ใช้ semantic utility classes ได้; หลีกเลี่ยงการผสม HSL channel syntax ของ v3 กับ direct hex ของ v4
3. เติม semantic slots ที่ generated components ต้องใช้แต่ตัวอย่างใน spec ยังไม่ครบ เช่น sidebar foreground/accent/ring, on-destructive foreground, hover/pressed/disabled และ interactive boundary โดยอ้าง existing roles ก่อนเพิ่มสีใหม่
4. เพิ่ม mappings ของ `--connection-*` และ `--environment-production` แยกจาก `--primary`/`--ring`; store state→variant mapping กลาง เพื่อให้ tab/row/badge/context bar แปล state แบบเดียวกัน
5. Pin geometry ผ่าน shared component variants/type utilities: font/line-height/control heights/spacing/radius รวมกัน; ใช้ `className` สำหรับ layout และ semantic variants สำหรับ appearance
6. terminal-themes เป็น renderer theme object/style scope แยก ไม่ย้อม ANSI output ตาม app foreground; ค่าเริ่มต้นยึด brand canvas แต่ ANSI palette และ terminal adjustments ต้องผ่าน readability fixture

ชื่อ path เช่น `src/styles/globals.css` ใน spec เป็นตัวอย่าง relative ต่อ renderer ของ `apps/desktop`; resolved paths จริงให้บันทึกหลัง ADR และ `shadcn info` ไม่สร้าง root `src/` แข่งกับ monorepo layout ใน architecture

## Component และ recipe inventory

| Layer | สิ่งที่ต้องเตรียม | Required states / scenarios |
|---|---|---|
| Controls / forms | Button, fields/input/search, select/combobox, checkbox/switch, textarea และ tooltip | default/hover/pressed/focus/disabled/loading/error; labels, validation และ sensitive input masking |
| Navigation / layout | Sidebar, tree-row composition, tabs, resizable/collapsible regions, menus, separator, scroll area | long labels, overflow tabs, active row, selected row ต่างจาก focus; traffic-light safe area และ no-drag controls |
| Feedback / overlays | Badge, Alert, Empty, Skeleton, Progress, Spinner, right-edge Drawer (แทน Dialog/AlertDialog ตั้งแต่ SST-040; confirmation เป็น alert drawer หรือ step ใน drawer) และ toast ตาม selected base | loading/cancel/empty/failed; title/focus trap/return focus; specific actionable copy ไม่มี secrets |
| Connection identity | ConnectionStatus + HostIdentity + environment label | active/disconnected และ inactive/connected ถูกต้อง; each split pane shows user@host:port; copy full target |
| Terminal workspace | SessionTab, TerminalPane, pane header + pane status bar (แทน global context bar ตั้งแต่ SST-040), snippet composer | pane focus, resize/full-screen output, preserved history after disconnect, independent terminal typography/ANSI |
| Files / tunnels / credentials | dual-pane SFTP + transfer row, local tunnel rule/status, credential row | explicit roots/direction/overwrite/skip/rename/cancel/errors; bind failure; labels/types/shared references ไม่ reveal secrets |

ชื่อ primitives เป็น inventory สำหรับค้น/ตรวจ API ตาม version จริง ไม่ใช่ imports ที่ยืนยันแล้ว ตรวจ installed components, base/icon library และ `shadcn docs` ก่อนใช้จริง ใช้ composition และ built-in variants; สร้าง domain-specific wrappers เมื่อ primitives ไม่ครอบคลุม behavior ไม่ติดตั้งทุก component โดยไม่มี use case ใน MVP

Internal showcase ใช้ fixtures และเป็น development/review surface ไม่เป็น primary product navigation ต้องมี colors/type/geometry specimens, required state matrix, long/Thai labels, empty/error examples และ integrated terminal/SFTP/dialog recipes พร้อมระบุ fixture state ให้ deterministic

## Validation และช่องว่างก่อนเขียน code

- **Contrast:** เป้าหมายตาม spec คือ 4.5:1 สำหรับ normal text และ 3:1 สำหรับ large text/essential UI graphics ตรวจ rendered foreground/background รวม opacity/focus/disabled context; palette อย่างเดียวไม่ใช่ผลผ่าน
- Static opaque-color calculation วันที่ 2026-10-14 พบ `--border #2B3D59` บน surface `#172235` ประมาณ **1.45:1**; ดังนั้น structural divider ใช้บทบาทเดิมได้ แต่หากเป็น sole essential control boundary ต้องมี indicator/token ที่ผ่านเป้าหมายก่อน signoff ไม่เปลี่ยน brand palette หรืออ้าง compliance โดยอัตโนมัติ
- **Status/focus matrix:** active+connected, active+disconnected, inactive+connected, connecting, error และ PROD ต้องอ่านจาก icon/text/focus geometry ได้โดยไม่อาศัยสีอย่างเดียว ปรับ live-region frequency ตามบริบท
- **Layout/input:** ตรวจหน้าต่าง 1280×800 และ minimum supported size ที่ ADR กำหนด; resize/collapse/splits, overflow labels, font scaling, keyboard shortcuts, Thai/IME และ focus-return จาก dialogs ไม่ส่ง input ไปผิด target
- **Typography/assets:** ตรวจ font loading ใน packaged/offline app, fallback glyphs, monospace alignment และ license; เตรียม icon sizes 16/32/64/128/256/512/1024 จาก supplied `icon-logo.png` ตาม [asset handoff](../logo/README.md) โดยตรวจ alpha/edges/padding และ packaging format; wordmark font ยังไม่ยืนยัน
- **Behavior:** host-key changed, auth fail, transfer conflict/cancel และ tunnel bind failure ใช้ real service outcomes ตาม tickets; showcase mock ไม่ถือว่า backend acceptance ผ่าน
- **Checks:** typecheck/build, no console errors, visual screenshots/state coverage, accessibility checks และ manual Electron walkthrough; บันทึก fixtures/OS/window dimensions/known limitations สำหรับ review

## Recorded decisions / remaining implementation gates

ADR 0001 เลือก Base UI/nova (`base-nova`), official @shadcn registry/Lucide, exact versions, renderer alias/paths, 32 px controls/rows, 4 px grid, 8/12 px radii และ 2 px focus ring แยก selection fill; generated APIs/config ต้องตรวจใน SST-004

Rendered essential-boundary contrast treatment/status/focus matrix, minimum window-size decision, production exports/small-size adaptation ของ supplied logo/icon, font licensing/offline Thai fallback และ terminal ANSI palette ยังรอ gates DS02–DS06 Light theme คงเป็น later ไม่เป็น gate ของ dark MVP

SST-004 outcome (2026-10-15) supersedes foundation gaps ข้างบน: controls/rows 32px, minimum 960×640; input boundary ใช้ muted ink เดิมแทน structural border; browser-resolved text pairs ≥4.5:1 / essential boundary ≥3:1 ใน showcase; Inter/JetBrains Mono/Noto Sans Thai และ OFL bundled; terminal ANSI16 specimen แยกจาก app theme Full workflow readability/native IME/OS accessibility และ exports ยังต้องผ่าน DS04–DS06

M0 confirmation อนุญาต DS01/T047 เป็น ADR/docs เท่านั้น; ไม่รัน scaffold, `shadcn init/add/apply`, ติดตั้ง fonts/repo dependencies หรือสร้าง assets ใน SST-001 DS02–DS06 ต้องอนุมัติเพิ่ม
