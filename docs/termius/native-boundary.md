# ขอบเขต native ของ Termius และงานเตรียม implementation

สถานะ: วิเคราะห์ artifact แบบ static แล้วบางส่วน ยังไม่เริ่ม implementation และยังไม่ยืนยันพฤติกรรมจากการรันโปรแกรม

เอกสารนี้ตรวจเฉพาะ package ที่ติดตั้งอยู่ใน `/Applications/Termius.app/Contents/Resources/app.asar.unpacked/node_modules/@termius` สำหรับ `libtermius`, `keytar`, `mosh`, `node-pty` และ `libfido2` ตามขอบเขต Termius 9.43.1 ที่รายงานหลักเลือกไว้ ตรวจ wrapper, manifest, Mach-O identity, dynamic linkage และ symbol บางกลุ่ม ไม่โหลด `.node` เข้า Node/Electron ไม่เรียก executable ของ Termius ไม่อ่าน profile, account หรือ credential ของผู้ใช้

## หลักฐานและวิธีอ่านข้อสรุป

หลักฐาน N01–N08 เป็น **ordinary-shell observations ไม่ใช่ REA Evidence ID** เก็บ exact absolute path, SHA256 และผลคำสั่งที่เกี่ยวข้องไว้ใน [native-shell.json](evidence/native-shell.json) ส่วน REA analysis ของ ASAR ให้ดูรายงานหลัก การอ้างชื่อ symbol ในเอกสารนี้หมายถึงพบชื่อใน binary เท่านั้น ไม่ได้ยืนยันว่าเป็น JavaScript export หรือเส้นทางที่ UI เรียกถึง

| ID | สิ่งที่ตรวจ | แหล่งและ source range |
|---|---|---|
| N01 | ตัวโหลดและ manifest ของ libtermius | `libtermius/index.js:6–17`, `package.json:1–11` |
| N02 | credential wrapper, loader, manifest | `keytar/lib/keytar.js:3–43`, `build/Release/keytar.node/index.js:5–16`, `package.json:1–12` |
| N03 | PTY wrapper และ lifecycle | `node-pty/lib/index.js:8–51`, `utils.js:17–36`, `unixTerminal.js:27–143,155–256,281–342`, `terminal.js:11–19,28–94,122–129`, `package.json:1–15` |
| N04 | ตัวโหลดและ manifest ของ Mosh | `mosh/index.js:6–17`, `package.json:1–11` |
| N05 | ตัวโหลดและ manifest ของ FIDO | `libfido2/index.js:6–17`, `package.json:1–12` |
| N06 | file type และ linkage | `file <absolute path>`, `otool -L <absolute path>` ของ native file 12 รายการ; output เต็มอยู่ใน JSON |
| N07 | export/import symbols ที่เลือก | `nm -gU` / `nm -u`; regex, total line count และรายการที่ตรงทั้งหมดอยู่ใน JSON |
| N08 | inventory ของ unpacked tree ที่เลือก | รายการไฟล์ใต้ root ข้างต้น; ไม่ครอบคลุมเนื้อหาภายใน ASAR |

ทุก relative source path ในตารางนี้ resolve ใต้ root ที่ระบุด้านบน SHA256 แยกแต่ละไฟล์อยู่ใน JSON ไม่มีการคัดลอก source ของ package proprietary มาเป็น implementation

## สิ่งที่ตรวจพบโดยตรง

### libtermius: wrapper เปิด addon ทั้งก้อน

N01 แสดง wrapper แปลง `darwin → mac`, `win32 → win` และโหลด `@termius/libtermius/<platform>-<arch>/termius.node` แล้ว re-export addon โดยตรง Manifest ระบุ `1.10.0-electron-22.3.27`, license `Proprietary` และ type declaration path `./libtermius.d.ts` แต่ N08 ไม่พบ declaration นี้ใน unpacked tree ที่ตรวจ ข้อความ version suffix ไม่ได้พิสูจน์เวอร์ชัน Electron ของตัวโปรแกรมที่รันอยู่

N06 ระบุว่า addon เป็น Mach-O arm64 shared library และ dynamic linkage มี Foundation, CoreFoundation, Security, zlib และ `@loader_path/libssh2.1.dylib` bundled libssh2 มี SHA256 `2db2964befb95f6b906ef17735685c63853849160635371dbe9ff3b87207a9ec` ตัว addon มี SHA256 `9d177d1d474191b59b87f55ded5a497079633a16f62cdb4349049590ed70b2c7`

N07 พบ export symbols กลุ่ม `InitNodeSshClient`, `InitNodeRemoteTerminal`, `InitNodePortForwarding`, `InitNodeFileSystem`, `InitNodeTelnetClient`, `InitNodeSshAgentStorage`, `InitNodeSshCertificate`, `InitNodeKeygen`, `InitNodeCrypto`, `InitNodeCryptoModule`, `InitNodeSRP`, `InitNodeSEP`, `InitNodeWebauthn`, `InitNodeWindowsHello` และ `InitNodeTerminalOutput` พบ Objective-C class symbols ชื่อ `SecureEnclave` และ `SepKey` ด้วย

N07 ยังพบ import symbols ของ libssh2 สำหรับ channel/PTY, authentication, SFTP, keepalive, forwarding, certificate/key operations และ import ของ Security เช่น `SecKeyCreateRandomKey`, `SecKeyCreateSignature`, `SecItemCopyMatching`, `kSecAttrTokenIDSecureEnclave`

**ข้ออนุมาน:** addon น่าจะเป็นขอบเขตหลักของงาน transport, file transfer และ crypto หลายชนิด ชื่อ initializer ที่กว้างบ่งชี้ว่า native module นี้ทำมากกว่าเปิด SSH socket อย่างเดียว

**ยังไม่ทราบ:** export object ที่แท้จริง, argument schema, async/error contract, class lifecycle, callback ordering, algorithm negotiation, certificate validation, host-key policy, native crypto construction, SRP protocol parameters และการเลือกใช้ Secure Enclave/WebAuthn/Windows Hello ในแต่ละ platform การพบชื่อ Windows Hello ใน binary macOS ไม่ยืนยันว่าฟีเจอร์นั้นใช้งานได้บน macOS ชื่อ `libssh2.1.dylib` และ compatibility/current version ของ Mach-O ไม่ยืนยัน upstream release หรือ patch set

### keytar: API ที่เห็นชัดอยู่ใน JavaScript

N02 ยืนยัน wrapper มี `getPassword(service, account)`, `setPassword(service, account, password)`, `deletePassword(service, account)`, `findPassword(service)` และ `findCredentials(service)` wrapper ตรวจค่าที่จำเป็นก่อนส่งต่อ native module; ไม่เห็น namespace ของ service/account ที่ตัวแอปใช้จริงจาก wrapper นี้

Manifest ระบุ `7.4.0-electron-22.3.27`, license `MIT` และคำอธิบายว่าเป็น binding กับ password API ของ Mac/Linux/Windows N07 พบ import symbols ฝั่ง macOS เช่น `SecKeychainFindGenericPassword`, `SecKeychainAddGenericPassword`, `SecKeychainItemModifyAttributesAndData`, `SecKeychainItemDelete`, `SecItemCopyMatching` จึงมีหลักฐาน static เพิ่มเติมว่า native module เชื่อมกับ Keychain API ไม่ได้ตรวจหรือดึงข้อมูล Keychain ใด ๆ

**ข้ออนุมาน:** ควรแยก secret storage ออกจาก host metadata storage ในระบบที่จะพัฒนา

**ยังไม่ทราบ:** credential naming, encryption ของ synced secret, access policy, prompt behavior, migrations และ return value/error behavior ของ native functions ใน target ที่รันจริง การพบ N-API promise symbols ไม่เพียงพอให้สรุป async contract รายเมธอด

### node-pty: local terminal lifecycle ที่ติดตามได้ใน wrapper

N03 ยืนยัน top-level exports `spawn`, `open`, deprecated `fork`/`createTerminal` และ `native` สำหรับ platform ที่ไม่ใช่ Windows wrapper เลือก WindowsTerminal หรือ UnixTerminal ตาม `process.platform` ฝั่ง Unix เปิด process ผ่าน native `pty.fork` โดยส่ง executable, argv, environment, cwd, dimensions, uid/gid, UTF-8 flag, spawn-helper และ exit callback

wrapper แสดง stream-based read, `write`, `resize`, `kill`, `destroy`, event `onData`/`onExit` และ pause/resume ค่าเริ่มต้นที่ package นี้กำหนดคือ 80 columns, 24 rows, `sh`, terminal name `xterm` และ UTF-8; ค่าเหล่านี้เป็น defaults ของ package ไม่ใช่หลักฐานว่า Termius UI ใช้ defaults นี้จริง

N03 `unixTerminal.js:281–342` แสดง write queue ที่จัดการ partial write และ `EAGAIN` ด้วยการกลับมาทำงานผ่าน event loop ส่วน `65–90` รอการปิด socket ก่อน emit exit และมี timeout 200 ms สำหรับกรณี socket ไม่ปิด N06 ยืนยัน `pty.node` เป็น arm64 bundle และ `spawn-helper` เป็น arm64 executable แต่ไม่ได้รันตัว helper

**ข้ออนุมาน:** ขอบเขต local PTY ควรมี backpressure, resize และ disposal contract ที่ชัดเจน แยกจาก remote SSH transport แม้ UI terminal ใช้ event shape ร่วมกันได้

**ยังไม่ทราบ:** option จริงที่ Termius ส่งจาก UI, Windows ConPTY behavior ของ target นี้, process tree cleanup ที่ระดับ product และการ reconnect ของ session ชั้นบน

### Mosh: มี addon แต่ wrapper ไม่แจกแจง API

N04 ยืนยัน loader ของ `moshclient.node`, version `1.2.0-electron-22.3.27`, license `Proprietary` และ declaration path `mosh.d.ts` ที่ไม่พบใน N08 N06 แสดง addon arm64 มี linkage กับ zlib, libc++ และ libSystem N07 พบ `InitNodeMoshClient` และ native class symbols ของ `TMoshClient` สำหรับ `start`, `stop`, `send`, `resize`

**ข้ออนุมาน:** เป็น candidate native client สำหรับ Mosh session แต่ต้อง trace caller ใน ASAR เพื่อยืนยัน JavaScript contract และ bootstrap flow

**ยังไม่ทราบ:** API object/constructor จริง, SSH bootstrap, UDP/session negotiation, roaming, timeout, local prediction และ remote server requirements ไม่มี packet/runtime observation ในการตรวจครั้งนี้

### FIDO: native device/signing boundary

N05 ยืนยัน loader ของ `libfido2-nodejs.node`, version `0.3.1-electron-22.3.27`, license `Proprietary` และ declaration path `./libfido2-nodejs.d.ts` ที่ไม่พบใน N08 N06 แสดง linkage กับ bundled libfido2, libcrypto, libssl, libcbor รวมทั้ง IOKit/CoreFoundation; libfido2 dylib load command ระบุ current version 1.10.0

N07 พบ `InitNodeFido2`, `GetDevicesAmount`, `GetDevicesInfo`, `GetDetailedDeviceInfo`, `SignData` และ symbols กลุ่ม `ssh_sk_*`

**ข้ออนุมาน:** addon เป็น candidate สำหรับ hardware-backed SSH security key/device enumeration/signing ไม่ใช่หลักฐานว่า WebAuthn ของบัญชี Termius ใช้ addon เดียวกัน

**ยังไม่ทราบ:** request schema, resident key flow, user-presence/user-verification options, device permissions, cancellation, PIN retry และ UI contract ไม่มีการติดต่อ hardware หรือร้องขอ signature ใด ๆ

## ขอบเขตที่ยังเปิดอยู่

| คำถาม | สถานะ | หลักฐานที่ยังต้องใช้ |
|---|---|---|
| Native artifact identity และ platform loader | ตอบได้สำหรับ mac-arm64 tree นี้ | N01–N06 |
| JavaScript methods ของ credential store และ Unix PTY wrapper | ตอบได้บางส่วน | N02–N03; caller ใน ASAR ยังต้องเชื่อมต่อ |
| JavaScript methods ของ libtermius/Mosh/FIDO | ยังไม่ยืนยันจาก wrapper | ASAR caller trace หรือ declaration ที่ถูกแพ็กไว้ที่อื่น |
| ลำดับ SSH authenticate/host-key/PTY/close | ยังไม่ยืนยัน | caller trace และ controlled test หลังเลือก implementation |
| Native algorithm/crypto internals | ยังไม่ยืนยัน | focused REA native decompilation ด้วย engine ที่มีอยู่ หรือ public protocol spec สำหรับ implementation อิสระ |
| Keychain record schema และ actual secrets | ไม่ได้ตรวจ; ไม่จำเป็นต่อแผน implementation อิสระ | ออกแบบ namespace ใหม่และ fixture ของโครงการเอง |
| Mosh/FIDO end-to-end behavior | ยังไม่ยืนยัน | caller trace และ test environment/device ที่กำหนดภายหลัง |

ไม่มี native disassembly/decompilation engine ถูกใช้ใน scope นี้ จึงไม่อ้างว่าถอด implementation ของ SSH/authentication/encryption ภายใน native addon ได้ครบ การไม่พบ `.d.ts` ใช้ได้เฉพาะ unpacked tree ที่เลือก ไม่ใช่ข้อสรุปว่าไม่มี declaration อยู่ใน ASAR

## แผนและ ticket สำหรับ implementation อิสระ

รายการนี้เป็น input ให้แผนรวม หลังผู้ใช้ confirm implementation แล้วจึงเริ่มพัฒนา ขณะนี้ผู้ใช้เลือก React + Electron + shadcn/ui + Tailwind CSS สำหรับ UI แล้วตาม [architecture decision](proposed-architecture.md#baseline--stack-decision); งาน native/SSH adapter ต้อง integrate กับ Electron และไม่จำเป็นต้องใช้ native stack แบบเดียวกับ Termius

| งานเสนอ | สิ่งที่ต้องส่งมอบ | Acceptance criteria | Dependency / evidence |
|---|---|---|---|
| N-T01: ออกแบบ session transport contract | interface ของ connect, authenticate, open terminal, write, resize, close และ typed state/error events | contract แยก local/remote ได้; disposal ทำซ้ำได้; data ordering และ cancellation ระบุชัด; secret ไม่อยู่ใน UI event payload | trace ASAR ประกอบ N01/N03; API ใหม่เป็น design decision |
| N-T02: เลือก SSH backend ผ่าน spike | ADR เปรียบเทียบ mature SSH library ในภาษาเป้าหมาย, native library adapter หรือ managed OpenSSH process | ใช้ test server ของโครงการยืนยัน password/key auth, host-key changed rejection, resize, EOF/exit และ teardown; บันทึกข้อจำกัด forwarding/SFTP/agent ของแต่ละทาง | หลัง confirm implementation และเลือก runtime; N01/N06/N07 |
| N-T03: ออกแบบ secret store adapter | OS credential store adapter กับ opaque secret reference; memory-backed adapter สำหรับ fixture | create/read/update/delete ผ่าน fixture namespace; metadata/log ไม่มี secret; missing/denied store ให้ผลที่ caller จัดการได้ | N02/N07; ไม่ใช้ข้อมูล Keychain ของ Termius |
| N-T04: สร้าง local PTY adapter | spawn, data, write, resize, exit, dispose ผ่าน contract เดียวกับ session UI | shell fixture แสดง Unicode และ resize ถูกต้อง; large paste มี ordering/backpressure; ปิด session แล้วไม่ทิ้ง child/descriptor | N03; เลือก native PTY binding หรือ helper process ตาม runtime |
| N-T05: แยก SFTP/forwarding จาก terminal | capability interfaces และ session ownership | transfer/cancel/error และ tunnel teardown มี semantics; UI ปิด capability ได้โดยไม่ทำ session อื่นเสีย | N07 เป็น candidate surface; ยืนยัน caller ก่อนกำหนด feature parity |
| N-T06: ทำ Mosh capability spike ภายหลัง | optional transport adapter และ declared capability availability | connect/bootstrap, resize, network interruption/restore และ stop ผ่าน lab fixture; fallback มีข้อความชัดเจน | N04/N07; ไม่เป็น dependency ของ SSH MVP |
| N-T07: ทำ hardware security-key spike ภายหลัง | device/signing adapter ที่แยกจาก key material storage | device missing, cancel, touch/PIN failure และ retry เป็นผลลัพธ์ที่ UI จัดการได้; ไม่มี extraction ของ hardware private key | N05/N07; ใช้ hardware ของโครงการเมื่ออนุญาต |
| N-T08: ออกแบบ account/sync crypto เป็นงานแยก | threat model, protocol/versioning, key lifecycle และ migration spec ของระบบใหม่ | ใช้ cryptographic construction/library ที่ผ่านการตรวจสอบ; test vectors ใหม่; ไม่สมมติว่าสามารถเข้าใช้ Termius cloud หรือถอด ciphertext เดิม | N07 แสดง crypto candidate แต่ไม่ยืนยัน algorithm หรือ cloud protocol |

ทางเลือก implementation ของ SSH/PTY/FIDO ควรตัดสินจาก runtime ของโครงการ, platform เป้าหมาย, packaging, testability และ maintenance หลัง spike การพกชื่อ dylib หรือ version suffix เหมือน target ไม่ใช่เงื่อนไข feature parity การเลียน interface ของ native addon proprietary โดยยังไม่รู้ schema ทำให้มีความเสี่ยงมากกว่าการกำหนด contract ใหม่ที่ทดสอบได้

ลำดับที่เสนอสำหรับ MVP: กำหนด transport/state/secret contracts → ยืนยัน SSH backend → ทำ remote terminal session และ credential references → เพิ่ม file transfer/forwarding ส่วน local PTY, Mosh/FIDO และ account sync เป็น later scope ตาม [แผนรวม](implementation-plan.md) ไม่เป็น dependency ของ SSH MVP ทั้งหมดอยู่ในสถานะ **รอ confirm implementation**
