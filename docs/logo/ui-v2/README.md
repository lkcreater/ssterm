# ssterm UI v2 — Charcoal / Signal Blue

ชุดภาพ UI ใหม่ตามคำขอวันที่ 2026-10-22: ใช้ [brand visual direction Charcoal v2](../brand-visual-direction-charcoal-v2.png) และโลโก้ SST เดิม โดยเปลี่ยนฟอร์ม overlay เป็น drawer เลื่อนเข้าจากด้านขวา

ไฟล์แบรนด์แยก: [logo v2](../brand-logo-v2.png), [icon v2](../icon-logo-v2.png), [asset notes / prompts](../brand-assets-v2.md)

ภาพในชุดนี้เป็น **design concepts** ที่สร้างด้วย built-in `image_gen` สำหรับ review และ handoff ไม่ใช่ screenshot ของโปรแกรมที่เปลี่ยนแล้ว ไม่ได้เพิ่มพฤติกรรม backend หรือเปลี่ยน application source ในงานนี้ ข้อความ ตัวเลข ระยะ และรูปทรงที่โมเดลวาดเป็นตัวอย่าง; ให้อ้างข้อกำหนดด้านล่างเมื่อ implement

## เปิดดูภาพ

เปิด [gallery.html](gallery.html) ใน browser เพื่อดูทั้งชุด กรองตามหมวดหรือเฉพาะ drawer และคลิกภาพเพื่อดูไฟล์เต็มได้ ภาพแต่ละไฟล์มีขนาดจริงบันทึกใน [manifest.json](manifest.json) หลังตรวจไฟล์ครบ

| # | หน้าจอ / flow | รูปแบบ | ภาพ |
|---|---|---|---|
| 01 | Servers · library | Full page | [PNG](01-servers.png) |
| 02 | Server · create/edit | Right drawer | [PNG](02-server-editor-drawer.png) |
| 03 | Server · jump hosts and proxy | Right drawer | [PNG](03-connection-route-drawer.png) |
| 04 | Group · inheritance and tags | Right drawer | [PNG](04-group-tags-drawer.png) |
| 05 | Identities · keys | Full page | [PNG](05-identities.png) |
| 06 | Identity · authentication form | Right drawer | [PNG](06-identity-editor-drawer.png) |
| 07 | SSH key · import/rename | Right drawer | [PNG](07-ssh-key-import-drawer.png) |
| 08 | Known hosts · trust inventory | Full page | [PNG](08-known-hosts.png) |
| 09 | Connection · unknown host | Right drawer | [PNG](09-host-trust-drawer.png) |
| 10 | Connection · changed key blocked | Right drawer | [PNG](10-changed-host-key-drawer.png) |
| 11 | Terminals · SSH tabs and splits | Full page | [PNG](11-terminals-ssh-splits.png) |
| 12 | Terminals · local shell | Full page | [PNG](12-local-terminal.png) |
| 13 | Terminal · captured Paste/Run target | Right drawer | [PNG](13-snippet-composer-drawer.png) |
| 14 | Connection · transient auth | Right drawer | [PNG](14-ssh-auth-drawer.png) |
| 15 | Files · SFTP and transfer queue | Full page | [PNG](15-files-transfers.png) |
| 16 | Transfers · overwrite/skip/rename | Right drawer | [PNG](16-transfer-conflict-drawer.png) |
| 17 | Files · external edit lifecycle | Right drawer | [PNG](17-remote-edit-drawer.png) |
| 18 | Snippets · encrypted library | Full page | [PNG](18-snippets.png) |
| 19 | Snippet · create/edit | Right drawer | [PNG](19-snippet-editor-drawer.png) |
| 20 | Port forwarding · all types | Full page | [PNG](20-port-forwarding.png) |
| 21 | Forwarding · local rule | Right drawer | [PNG](21-local-forward-drawer.png) |
| 22 | Forwarding · remote rule | Right drawer | [PNG](22-remote-forward-drawer.png) |
| 23 | Forwarding · dynamic SOCKS5 rule | Right drawer | [PNG](23-dynamic-forward-drawer.png) |
| 24 | Recordings · output and history | Full page | [PNG](24-recordings-history.png) |
| 25 | Settings · recording privacy | Right drawer | [PNG](25-recording-settings-drawer.png) |
| 26 | Workspace · templates | Right drawer | [PNG](26-workspace-templates-drawer.png) |
| 27 | Workspace · explicit multi-target input | Right drawer | [PNG](27-broadcast-composer-drawer.png) |
| 28 | Settings · terminal appearance | Right drawer | [PNG](28-terminal-settings-drawer.png) |
| 29 | Settings · app lock and sign in | Right drawer | [PNG](29-security-settings-drawer.png) |
| 30 | Personal sync · explicit setup | Right drawer | [PNG](30-sync-setup-drawer.png) |
| 31 | Personal sync · manual actions | Right drawer | [PNG](31-personal-sync-drawer.png) |
| 32 | Personal sync · conflict resolution | Right drawer | [PNG](32-sync-review-drawer.png) |
| 33 | Personal sync · enrollment/recovery | Right drawer | [PNG](33-sync-enrollment-recovery-drawer.png) |
| 34 | Team vault · shared hosts | Full page | [PNG](34-team-vault.png) |
| 35 | Team vault · managed host/password | Right drawer | [PNG](35-team-host-drawer.png) |
| 36 | Team vault · roles and enrollment | Right drawer | [PNG](36-team-members-drawer.png) |
| 37 | Team vault · setup and separate recovery | Right drawer | [PNG](37-team-setup-recovery-drawer.png) |
| 38 | App lock · local sign in | Full page | [PNG](38-app-unlock.png) |
| 39 | App lock · first setup and recovery | Right drawer | [PNG](39-app-setup-recovery.png) |
| 40 | Help · keyboard shortcuts | Right drawer | [PNG](40-keyboard-shortcuts-drawer.png) |
| 41 | States · empty/loading/failure | Full page | [PNG](41-empty-error-states.png) |
| 42 | Confirmations · delete/reassign/unsaved | Right drawer | [PNG](42-destructive-confirmation-drawer.png) |

## Visual contract

- พื้นหลัก `#1E1E1E`, sidebar `#202020`, surface/drawer `#252525`, field `#292929`, เส้นแบ่ง `#383838`
- ข้อความหลัก `#F3F3F3`, ข้อความรอง `#A3A3A3`; action/focus/selection `#2563EB`; cyan `#00C8E8` เป็น accent ของโลโก้
- ไม่เติม navy tint หรือแสง neon บน surface; ใช้สัดส่วนและ cyan→blue gradient ของโลโก้เดิม เก็บ source artwork เดิม
- Inter สำหรับ UI, JetBrains Mono สำหรับ terminal/code; wordmark ยังอ้างจาก artwork เดิม ไม่อ้างว่าใช้ Inter
- Connected/Connecting/Error/Disconnected มี icon และข้อความ แยกจาก active tab/selection สีฟ้า; execution target และ PROD ต้องอ่านชัดเจน
- Terminal/ANSI palette แยกจาก application tokens; ภาพไม่ใช่หลักฐาน contrast หรือ native font/IME acceptance
- หน้าต่างในภาพเป็น landscape review composition; implementation ต้องรองรับขั้นต่ำ 960×640, 1280×800 และการขยายตัวอักษรตามข้อกำหนดเดิม ไม่ใช้ภาพเป็น pixel spec ที่ผ่านแล้ว

## Drawer contract

- ฟอร์ม create/edit/configure/auth และหน้าต่าง Settings/Workspace tools/Shortcuts เปิดจากขวา ติดขอบหน้าต่าง เต็มความสูงใต้ title bar; ไม่มีฟอร์ม modal ลอยตรงกลาง
- ความกว้างที่เสนอ 480–560 logical px; complex review/settings ใช้ได้ถึง 640 px โดยต้องเหลือบริบทหน้าต้นทาง กรณีหน้าต่างเล็กใช้เต็มพื้นที่เนื้อหาที่จำเป็น ไม่ทำ field overflow
- Header (title, target, close) และ footer (Cancel/primary action) คงที่; body เลื่อนได้ แสดง validation ใต้ field พร้อม error summary เมื่อเหมาะสม
- เปิด/ปิดประมาณ 180–220 ms ด้วย transform/opacity; `prefers-reduced-motion` ใช้การแสดง/ซ่อนทันที ภาพ PNG แสดงตำแหน่งเปิดสุด ไม่ใช่หลักฐาน animation
- Focus เข้า field แรกหรือหัวข้อที่เหมาะสม, trap ภายใน overlay, ปิดแล้วคืน focus ให้ opener ที่ยังอยู่; Esc/Cancel ต้องผ่าน dirty/busy policy และไม่ส่ง input ต่อเข้าตัว terminal
- Scrim บัง interaction กับหน้าต้นทาง แต่ยังเห็น target/context; ห้ามให้ overlay ทำให้ target เปลี่ยนตาม tab/pane ที่เปลี่ยนภายหลัง
- Confirmation/impact review ใช้ step ใน drawer เดิม ไม่ซ้อน drawer หรือเปิด modal ตรงกลาง รวม trust replacement, PROD Run, overwrite, delete/reassign, discard และ revoke
- ปุ่มทำลายข้อมูลเป็นสีแดงและต้องยืนยันเจาะจง; ตั้งค่า trust/auth/secret ไม่มี auto-accept หรือ secret ในภาพ
- หน้า app lock/first setup เป็น full-window gate ที่มี form panel ชิดขวา ไม่มี workspace data ปรากฏด้านหลัง ไม่ใช่ drawer ที่เปิดทับ catalog ที่ปลดล็อกแล้ว
- หาก gate มี X ให้เป็นการปิดหน้าต่าง ไม่เปิดเผย workspace หรือ bypass การปลดล็อก; key combinations ในภาพ Shortcuts เป็นตัวอย่าง layout ต้องเทียบ source shortcuts จริงก่อน implement
- Native macOS Open/Save และระบบยืนยัน Keychain/Google เป็น OS/external flows เดิม ไม่อ้างว่าย้ายเข้า app drawer ได้

## Coverage และแหล่งอ้างอิงจาก source

| กลุ่ม | Existing source | ภาพใหม่ |
|---|---|---|
| Shell/catalog + host/group forms | `components/app-shell.tsx`, `catalog/hosts-page.tsx`, `catalog/editors.tsx`, `catalog/delete-dialogs.tsx` | 01–04, 41; delete/dirty ใช้ pattern 42 |
| Identity/key forms + deletion | `identities/identities-page.tsx`, `identity-dialogs.tsx`, `key-dialogs.tsx` | 05–07, 42; rename ใช้ field Name ใน drawer เดิม |
| Trust inventory + unknown/changed/revoke | `trust/known-hosts.tsx` | 08–10; revoke ใช้ confirmation step เดียวกับ 42 |
| SSH/local terminals, snippets, auth | `workspace/*`, `auth/credential-prompts.tsx` | 11–14; password/passphrase/keyboard-interactive ใช้ form variant ใน 14 |
| SFTP/transfer conflicts/remote edits | `sftp/files-workspace.tsx`, `transfer-queue.tsx`, `remote-edits.tsx` | 15–17 |
| Encrypted snippets | `snippets/snippets-page.tsx` | 18–19 |
| Local/remote/dynamic forwarding | `tunnels/tunnels-page.tsx` | 20–23 |
| Recordings/history/policy | `recordings/recordings-page.tsx`, `settings/settings-dialog.tsx` | 24–25 |
| Templates/multi-target | `workspace/workspace-tools.tsx` | 26–27 |
| Terminal/security/sync settings | `settings/settings-dialog.tsx`, `app-lock/sign-in-settings.tsx`, `sync/sync-settings.tsx` | 28–33 |
| Team vault/shared credential/membership/setup/recovery | `team/team-workspace.tsx` | 34–37 |
| Local app lock, setup/recovery | `app-lock/app-lock-gate.tsx` | 38–39 |
| Shortcuts/empty/error/confirmations | `workspace/shortcuts-dialog.tsx`, shell and existing confirmation components | 40–42 |

เส้นทาง source ในตารางอ้างจาก `apps/desktop/src/renderer/src/` ภาพแบ่งตาม screen/flow ที่มีความต่างสำคัญ; create/edit, field validation, loading, rename และ confirmation ที่ใช้โครงเดียวกันอ้าง pattern เดิม ไม่ได้แยก PNG ทุก permutation ของ state

## Behavior ที่ต้องคงไว้

- โฮสต์และค่าที่ปรากฏเป็น demo data; password/passphrase/token/private key/recovery secret ไม่ปรากฏจริงในภาพ
- Trust unknown/changed ต้องตัดสินใจเอง; เปลี่ยน host key ต้อง block ก่อน deliberate replacement
- Paste/Run และ captured target แยกกัน; multi-target เป็น composer แบบชัดเจน การพิมพ์ปกติยัง pane-local และการส่ง bytes ไม่ยืนยัน command success
- Local terminals เป็น transient processes; templates/multi-target และ SFTP ไม่รับ local pane
- Files ใช้ local↔remote; Retry เริ่ม byte zero ไม่มี Resume/remote↔remote
- Remote edit ใช้ external TextEdit consent และ snapshot upload ไม่ใช่ embedded editor หรือ SFTP compare-and-swap
- Recording/sync ปิดเป็นค่าเริ่มต้น; history ใช้ opt-in shell integration ไม่ใช่ AI
- Personal sync เป็น manual Publish/Fetch/Review/Apply ผ่าน self-hosted endpoint; credential/trust/SSH keys ถูกยกเว้น
- Team vault แยกจาก personal sync, Owner/Editor/Connector/Viewer ตามสิทธิ์เดิม, shared password ผูก endpoint/login; direct terminal เท่านั้น
- App lock recovery, personal sync recovery และ Team recovery เป็นคนละชุด; ไม่มีการสร้าง/บันทึก secret จริงในงานภาพนี้

## Generation และ verification

ใช้ built-in `image_gen` แยกหนึ่ง call ต่อภาพ อ้าง brand board, โลโก้ต้นฉบับ และภาพ Servers master เพื่อคุม consistency บันทึก prompt ส่วนกลางและ screen-specific prompt ใน [generation-plan.json](generation-plan.json)

บันทึก prompt/spec ของรอบปรับรายละเอียดใน [refinements.json](refinements.json) โดยเฉพาะ pending trust/auth, captured target, unsupported fields, Team roles และ first-launch gate

การตรวจในงานนี้: เปิดดูภาพ, ตรวจ PNG/dimensions/count/links และ `git diff --check` เท่านั้น ไม่ได้รันหรืออ้างผล UI runtime, accessibility, IME, build หรือ E2E จากภาพ concept

ผลตรวจไฟล์สุดท้าย: PNG 42/42 ภาพไม่ซ้ำกัน ขนาด 1536×1024 ทุกภาพ รวมประมาณ 58.9 MiB; ตรวจ signature/IHDR/IEND, JSON, syntax ของ gallery script และ local links 197 รายการผ่าน เปิดดูภาพ final ครบทั้งชุด และ `git diff --check` ผ่าน

