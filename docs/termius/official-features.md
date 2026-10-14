# Termius: feature และ workflow จากเอกสารทางการ

สถานะ: เอกสารเตรียม implement เท่านั้น — ยังไม่ได้เริ่ม implement และต้องรอผู้ใช้ยืนยันตามคำขอเดิม

ตรวจแหล่งข้อมูลวันที่ **2026-10-14 (Asia/Bangkok)** ผ่านเว็บสาธารณะของ Termius ไม่ได้เข้าสู่บัญชี ทดลองเชื่อมต่อ SSH ซื้อ subscription หรือเปลี่ยน configuration เอกสารนี้เป็นหลักฐาน **Published**: สิ่งที่ผู้ผลิตเผยแพร่ ไม่ใช่ผลยืนยัน runtime ของเครื่องผู้ใช้ ไม่พบ `AGENTS.md` ใน repo และ ancestor directories ที่ตรวจ

## ความหมายของระดับข้อมูล

- **Published**: ผู้ผลิตอธิบาย feature/workflow ไว้ในหน้าอ้างอิง
- **Recommendation**: ขอบเขตที่เสนอสำหรับ ssterm ต้องผ่านการยืนยันก่อน implement
- **Unknown**: ยังไม่มีหลักฐานเพียงพอ ห้ามแปลงเป็นข้อเท็จจริงของ Termius

เว็บหลักเชื่อมไปยัง `docs.termius.com` โดยตรง จึงใช้เว็บไซต์นี้เป็น primary documentation; หน้า GitHub ชื่อคล้าย Termius ที่ผลค้นหาพบไม่ได้ใช้เป็นหลักฐาน เอกสารออนไลน์อาจใหม่กว่าเวอร์ชันแอปที่ติดตั้ง จึงต้องเทียบกับ artifact report แยกต่างหาก

## Feature / workflow inventory

คำว่า MVP และ Later ในตารางเป็น **Recommendation ของโครงการ** ไม่ใช่ชื่อแพ็กเกจหรือการแบ่งราคา Termius

| Feature | Published workflow / behavior | Scope ที่เสนอ | Unknown / สิ่งต้องกำหนดก่อน implement | Source |
|---|---|---|---|---|
| Vault และ host model | Vault ครอบคลุม Hosts, Groups, keys, snippets, forwarding rules และ Known Hosts; Host คือเครื่องที่มี address พร้อม protocol และ credentials แยกกัน | MVP: local vault เดียวและ SSH/SFTP host model; Later: หลาย vault | ID/schema/relationship/delete cascade ของ Termius ไม่ได้เปิดเผย | [W01](https://docs.termius.com/getting-started/what-is-termius) |
| Create / connect host | New Host → address, port, username, password → desktop auto-save → Connect หรือ double-click → terminal | MVP: CRUD, search, connection state, password/key auth | validation timing, draft semantics, retry/timeout policy และ error taxonomy | [W04](https://docs.termius.com/organize-and-connect-to-hosts/connecting-to-a-server), [W12](https://docs.termius.com/getting-started/quickstart) |
| Groups / inheritance | Nested groups; หน้า Hosts รวม hosts ใน group และ subgroups; properties ที่ไม่ override จะ resolve ผ่าน parent ทีละค่า | MVP: nested groups, credential/port defaults และ explicit override; Later: theme/env/startup defaults ครบ | collection merge, empty/null meaning, conflicting parents และ cycle behavior | [W02](https://docs.termius.com/organize-and-connect-to-hosts/groups-and-tags) |
| Tags | tag บน host; search ตรวจ tags; เลือกหลาย tags เพื่อหา hosts ที่มีทุก tag; เอา tag ออกจาก host ไม่ลบ tag | MVP: tags, text search, AND filter | case sensitivity, normalization และ duplicate label policy | [W02](https://docs.termius.com/organize-and-connect-to-hosts/groups-and-tags) |
| Identities / Keychain | เก็บ username/password/key ร่วมกัน อ้างอิงจากหลาย hosts/groups; desktop สร้างผ่าน Keychain → New Identity และ auto-save; เลือก identity ที่ Credentials | MVP: reusable identities และ import SSH key; Later: certificates/FIDO2/biometrics | identity deletion, secret editing, key passphrase caching และข้าม vault | [W03](https://docs.termius.com/keychain/identities) |
| SSH chaining / proxy | Host Chaining เลือก intermediate hosts ได้หลายตัว; Connect ตั้ง tunnel ตาม chain; proxy รองรับ HTTP และ SOCKS5 | Later: เริ่ม jump host หนึ่ง hop แล้วขยาย multi-hop/proxy | hop limit, cycle detection, per-hop auth, failure cleanup | [W04](https://docs.termius.com/organize-and-connect-to-hosts/connecting-to-a-server) |
| Terminal / workspace | workspace ต้องมีอย่างน้อยสอง sessions; desktop Focus/Split switch ได้โดยไม่หยุด sessions; Split รองรับสูงสุด 16 terminals | MVP: tabs และ split/focus ขั้นพื้นฐาน; Later: reusable workspace templates | ANSI/Unicode/IME/performance behavior, reconnect และ process lifetime ต้องทดสอบเอง | [W06](https://docs.termius.com/terminal/workspaces) |
| Workspace restore / broadcast | template เก็บ connections, names, layout, directory, active commands; directory/command restore ต้องเปิด Autocomplete; broadcast ส่ง input ไปทุก active terminal | Later: save layout, broadcast opt-in; command restore หลังนิยาม UX เรื่อง replay ชัดเจน | restore คือการเรียก command ใหม่อย่างไร และจัดการคำสั่งที่มีผลเปลี่ยนระบบอย่างไร | [W06](https://docs.termius.com/terminal/workspaces) |
| SFTP | Desktop เปิด local filesystem โดย default; เลือก host ในสอง panes; browse/path/hidden files; drag/drop หรือ copy to target; terminal ↔ SFTP ของ host เดียวกัน | MVP: local/remote dual pane, browse, upload/download และ progress/error; Later: remote/remote transfer | resume, symlink, permission edits, cancellation, conflict policy และ atomicity | [W05](https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp) |
| Remote file editing | เปิดไฟล์ remote → ดาวน์โหลดเข้า temporary local directory → editor → ตรวจ changes แล้วถาม upload; จำ Open with ตาม file type | Later | stale version detection, concurrent edit, temp cleanup และ external editor exit handling | [W05](https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp) |
| Snippets | labeled shell script; side panel มี Paste กับ Run แยกกัน; Snippets screen multi-execution เปิด connections ใหม่; side panel ทำงานกับ sessions เดิม; startup snippet รันทุกครั้งที่ connect | MVP: local snippet CRUD และ Paste/Run บน active session; Later: packages, startup, multi-host, AI | newline/encoding, run completion, partial failures และ startup order | [W07](https://docs.termius.com/terminal/snippets) |
| Port forwarding | Local/Remote/Dynamic; หน้าเดียวรวม active rules; wizard หรือ form; Local ใช้ local port + SSH host + destination address/port; double-click start/stop | MVP: Local tunnel CRUD/start/stop/status; Later: Remote และ Dynamic | bind address default, conflict handling, reuse SSH session, auto-restart และ persistence | [W08](https://docs.termius.com/organize-and-connect-to-hosts/port-forwarding-and-tunneling) |
| Known Hosts | official overview ระบุ Known Hosts เป็นข้อมูลใน vault | MVP: fingerprint verification, first-use decision และ changed-key handling เป็น requirement ที่เสนอ | หน้าในชุดที่อ่านไม่ได้ระบุ prompt, trust record scope, import/export หรือ changed-key behavior ของ Termius ต้องยืนยันเพิ่ม | [W01](https://docs.termius.com/getting-started/what-is-termius) |
| Local storage / credentials sync | Personal credentials sync ปิดได้เฉพาะ usernames/passwords/keys/identities; host/group/snippet ยัง sync เมื่อแผนอนุญาต; logout ล้าง local data รวม credentials ที่ไม่ sync | MVP: local encrypted storage และ OS secure storage; Later: selective secret sync | file format, recovery, migrations, cloud conflict resolution และ account-free lifecycle | [W10](https://docs.termius.com/keychain/sync-of-keys-and-passwords), [W12](https://docs.termius.com/getting-started/quickstart) |
| Cloud security claims | ผู้ผลิตระบุ E2EE/hybrid encryption; Encryption Password ใช้ decrypt vault รวมเมื่อ login ด้วย SSO; หากลืมไม่สามารถกู้ข้อมูลได้ | Later: ออกแบบ threat model และ review ก่อน cloud sync | ต้องไม่ถือว่าเอกสารคือผล security audit; protocol compatibility, revocation/rekey และ backend API ไม่ได้ยืนยัน | [W09](https://docs.termius.com/security/encryption-overview) |
| Team vault / permissions | Personal vault ไม่แชร์; default Team vault แชร์สมาชิก; custom vault จำกัดสมาชิก; Can view ดู/connect/run snippets; Can edit แก้ข้อมูลและสมาชิก | Later: teams, vault ACL, shared credentials | enforcement location, audit trails, offline revocation และ cached secret lifecycle | [W11](https://docs.termius.com/team-collaboration/team-vaults) |
| Logs / autocomplete / AI | overview กล่าวถึง command/history/path/password suggestions และ session logs ที่ sync/share/search/bookmark; AI command generation ต้องมีบัญชี | Later: opt-in local logs/history ก่อน; cloud logs, AI และ multiplayer เป็น separate scope | privacy/redaction, retention, shell integration installation, supported shells และ backend AI | [W01](https://docs.termius.com/getting-started/what-is-termius) |
| Additional protocols / platforms | published connection docs มี SSH, SFTP, Mosh, Telnet, Serial และ Local Terminal; app ใช้บน desktop/mobile | MVP: macOS desktop SSH/SFTP; Later: local terminal, Windows/Linux, mobile และ protocols อื่น | platform parity และ distro/store sandbox differences | [W04](https://docs.termius.com/organize-and-connect-to-hosts/connecting-to-a-server), [W05](https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp) |

## Flow สำหรับแปลงเป็น acceptance criteria

### F01 — เพิ่ม host แล้วเปิด SSH

เลือก local vault → New Host → กรอก address/port → กรอก credentials หรือเลือก identity → persist → Connect → verification/authentication → terminal พร้อม session state

Published ยืนยัน flow ตั้งค่า/auto-save/connect/terminal ส่วน verification, validation และ state machine ต้องออกแบบและทดสอบเป็น requirement ของ ssterm ไม่มีการอ้างว่า Termius ใช้ state machine แบบใด [W04](https://docs.termius.com/organize-and-connect-to-hosts/connecting-to-a-server), [W12](https://docs.termius.com/getting-started/quickstart)

### F02 — ตั้งค่ากลุ่มแล้ว override host

สร้าง parent/child group → ตั้ง credentials หรือ port ที่ parent → host รับ default ของค่าที่ไม่ override → เปลี่ยน parent แล้ว host ที่ inherit เปลี่ยนตาม → explicit host value ยังคงค่าเดิม; tag filters หลายค่าต้อง match ทุกค่า [W02](https://docs.termius.com/organize-and-connect-to-hosts/groups-and-tags)

### F03 — ใช้ identity ซ้ำ

สร้าง identity ใน Keychain → bind หลาย hosts → เปลี่ยน secret ที่อ้างอิงร่วมกัน → connection ครั้งถัดไป resolve ค่าล่าสุด การเปลี่ยนระหว่าง live session เป็น unknown และต้องกำหนดต่างหาก [W03](https://docs.termius.com/keychain/identities), [W01](https://docs.termius.com/getting-started/what-is-termius)

### F04 — ย้ายไฟล์และแก้ remote file

SFTP → pane local/remote → auth → browse → เลือก target directory → transfer → แจ้งสถานะ สำหรับ phase ถัดไป Open remote file → temp download → external editor → changed detection → upload decision [W05](https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp)

### F05 — Split session และ snippet

เปิดสอง sessions → รวม workspace → Focus/Split → active pane → snippet Paste ต้องไม่ส่ง execute; Run ส่งไป active terminal Multi-run และ Broadcast ต้องมี target visibility ชัดเจนเป็น requirement ที่เสนอ [W06](https://docs.termius.com/terminal/workspaces), [W07](https://docs.termius.com/terminal/snippets)

### F06 — Local tunnel

New forwarding → Local → local port → SSH host → destination address/port จากมุมมอง SSH host → save → start → active → stop; duplicate port/SSH failure ต้องเป็น acceptance scenarios [W08](https://docs.termius.com/organize-and-connect-to-hosts/port-forwarding-and-tunneling)

## ข้อค้นพบที่มีผลต่อแผน

1. **Groups เป็น configuration hierarchy**: ทำเป็น folder tree อย่างเดียวจะไม่ครอบคลุม published workflow ต้องมี per-field inherit/override และหน้า group เห็น hosts ของ descendants [W02](https://docs.termius.com/organize-and-connect-to-hosts/groups-and-tags)
2. **Paste, Run, Broadcast และ startup มีผลต่างกัน**: ควรแยก acceptance criteria และ state ของ targets โดยเฉพาะ Snippets screen ที่เปิด connections ใหม่ [W07](https://docs.termius.com/terminal/snippets)
3. **Restore ไม่เท่ากับ SSH session persistence**: เอกสาร workspace พูดถึงการ restore saved configuration/directory/command ไม่ได้พิสูจน์ว่า remote process รอดเมื่อ client ปิด [W06](https://docs.termius.com/terminal/workspaces)
4. **Selective credential sync ไม่ใช่ปิด sync ทั้งหมด**: personal credentials ปิดได้ แต่ data อื่นยัง sync ตามแผน; logout มีผลล้างข้อมูล จึงต้องกำหนด lifecycle ของ ssterm เอง [W10](https://docs.termius.com/keychain/sync-of-keys-and-passwords)
5. **Account-free usage มีเงื่อนไขใน quickstart**: docs บอกเริ่มต้น sign in/create account และ local use โดย logout หลัง trial; อย่าอ้างว่า installed build ข้าม onboarding ได้ก่อนตรวจ runtime [W12](https://docs.termius.com/getting-started/quickstart)

## Source register

ทุกแหล่งเป็น official Termius และเข้าถึง **2026-10-14**; ไม่พบ publication/update date ที่แน่นอนในหน้าที่อ่าน จึงไม่ใส่วันที่เผยแพร่โดยคาดเดา

| ID | URL / title | ใช้อ้างอิง |
|---|---|---|
| W01 | [What is Termius](https://docs.termius.com/) | Concept model, Known Hosts presence, logs/autocomplete overview; อ่านเนื้อหาผ่าน root URL นี้ ซึ่งระบุ canonical Markdown เป็น `/getting-started/what-is-termius.md` |
| W02 | [Groups and tags](https://docs.termius.com/organize-and-connect-to-hosts/groups-and-tags) | Nested group, inherited defaults, descendants visibility, tag AND |
| W03 | [Identities](https://docs.termius.com/keychain/identities) | Reusable credentials, create/link, vault scope |
| W04 | [Connecting to a server](https://docs.termius.com/organize-and-connect-to-hosts/connecting-to-a-server) | SSH auth, protocol list, chaining, HTTP/SOCKS5 |
| W05 | [Managing files with SFTP](https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp) | Two panes, browse/transfer, temp edit, platform sandbox |
| W06 | [Workspaces](https://docs.termius.com/terminal/workspaces) | Focus/Split, 16 terminal limit, templates, broadcast |
| W07 | [Snippets](https://docs.termius.com/terminal/snippets) | Paste/Run, startup, multi-execution, packages |
| W08 | [Port forwarding and tunneling](https://docs.termius.com/organize-and-connect-to-hosts/port-forwarding-and-tunneling) | Local/Remote/Dynamic, setup, start/stop |
| W09 | [Encryption overview](https://docs.termius.com/security/encryption-overview) | Vendor E2EE/password/recovery claims |
| W10 | [Sync of keys and passwords](https://docs.termius.com/keychain/sync-of-keys-and-passwords) | Selective credentials sync, logout clearing |
| W11 | [Team vaults](https://docs.termius.com/team-collaboration/team-vaults) | Vault membership, Can view/Can edit |
| W12 | [Quick start](https://docs.termius.com/getting-started/quickstart) | Onboarding/account/local mode, first connection |

## สิ่งที่ยังพิสูจน์ไม่ได้

- ฟังก์ชันของ installed build ที่ตรงกับ documentation รุ่นปัจจุบันทุกข้อ
- database schema, IPC/native bridge, SSH/SFTP engine behavior และ server-side implementation จากเอกสารนี้
- API contracts, sync conflict algorithm, team revocation/rekey, encryption envelope และ licensing internals
- Known Hosts trust prompts และ changed-key policy จริงของ Termius ในเวอร์ชันเป้าหมาย
- reconnect/session continuity, stream backpressure, Unicode/IME, throughput, cancellation และ memory limits

ก่อน implement ให้ใช้รายการนี้ร่วมกับ artifact evidence ของแอปที่ติดตั้ง สร้าง implementation ของ ssterm ตาม behavior ที่ยืนยันหรือ requirement ที่ผู้ใช้อนุมัติ และบันทึกสิ่งที่ต่างจาก Termius อย่างชัดเจน
