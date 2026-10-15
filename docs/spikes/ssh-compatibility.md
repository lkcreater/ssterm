# SST-002 — SSH backend compatibility result

**วันที่:** 2026-10-15 · **Decision:** เลือก `ssh2 1.17.0` เป็น backend baseline สำหรับ adapter ของ ssterm ตามขอบเขต M0 · **Status:** TEST / REVIEW / DELIVERY passed; root commit pending

SST-001 ส่งมอบและ commit แล้วที่ `ad9ed51` ก่อนเริ่ม SST-002 รอบนี้เพิ่ม code เฉพาะ isolated spike และ project-owned fixture ไม่มี production React UI/services, Termius dependency, user credentials หรือ real Keychain operations

## Implementation

- `tests/fixtures/ssh/`: Debian OpenSSH/PAM + internal SFTP + HTTP fixture; user `fixture`, password/encrypted client keys สร้างใหม่ใน private temp directory, server keys สร้างใหม่ทุก container; SSH publish เฉพาะ loopback dynamic port
- `spikes/ssh-compat/src/`: fixture ownership, bounded connection/auth/trust, channels/streams/tunnel disposal, shared probes และ sanitized reporting
- `spikes/ssh-compat/test/`: real integration matrix และ regression tests สำหรับ failed startup key cleanup / hard timeout / normal exit
- `spikes/ssh-compat/electron/` และ `scripts/`: main-process probe entry, unsigned arm64 `.app` packaging, bounded packaged runner และ run-ID-scoped cleanup
- Exact dependency pins และ npm lockfile อยู่ใน isolated package; [.gitignore](../../.gitignore) กัน node_modules/runtime packages และ generated artifacts ออกจาก commit

## Actual validation

รันจาก `spikes/ssh-compat`; commands ที่ต้องใช้ Docker socket/launch binary รันด้วย permissions ที่ได้รับอนุญาต

| Check | Actual result |
|---|---|
| `npm ci --omit=optional --ignore-scripts` | exact lockfile reinstall ผ่าน; native install hooks ไม่ถูกรัน |
| `npm run runtime:prepare` | explicitly prepared pinned Electron runtime |
| `npm run check` | CommonJS source/test/scripts syntax ผ่าน |
| `npm test` | 4 Node tests ผ่าน: integration matrix 19 probes + regression tests 3 cases |
| `npm run package:mac` | สร้าง local `SSTermSSHSpike.app`, arm64, bundle ID `dev.ssterm.spike` ด้วย Electron 44.7.2 |
| `npm run test:packaged` | รัน executable ของ `.app` จริงและผ่าน shared matrix 19/19 หลัง `app.whenReady()` |
| Native acceleration | ทั้ง Node และ Electron รายงาน `optionalNativeBindingLoaded: false` และมี assertion รองรับ |
| Teardown | ไม่เหลือ Docker containers ที่ติด label ของ fixture; own temp keys/ports ปิดตาม probes และ run-scoped cleanup |
| Source hygiene | shell syntax, `git diff --check`, scoped JSON/Markdown references ตรวจใน delivery gate |

Host: macOS 15.7.4 arm64, Node 24.11.1/npm 11.6.2; packaged Electron 44.7.2 ใช้ embedded Node 24.21.0 Fixture: OpenSSH 9.2/OpenSSL 3.0.22, linux/arm64 ดู image/base digest และ executable SHA-256 ใน [environment.json](evidence/environment.json)

หลักฐาน sanitized ที่เก็บใน repo: [Node report](evidence/node-report.json), [packaged report](evidence/packaged-report.json) ส่วน `.app` และ full execution logs เป็น generated artifacts ที่ไม่ commit; local `.app` อยู่ใต้ `spikes/ssh-compat/artifacts/package/`

## Capability matrix — verified in both runtimes

| Capability / scenario | Evidence |
|---|---|
| Unknown server key | rejected before authentication; explicit accept-once callback required |
| Remembered fingerprint | reused trusted fingerprint without repeated unknown-key prompt; persistent trust storage remains SST-009 |
| Actual changed server key | regenerate key + HUP sshd at same published endpoint; old trust blocked before auth; new key requires explicit replacement decision |
| Authentication | password, encrypted OpenSSH Ed25519 private key, PAM keyboard-interactive; bad password denied |
| PTY | interactive channel, remote `stty` confirms 41 rows × 111 columns, Thai/emoji UTF-8 bytes and exit code 7 |
| SFTP | streaming 196,625-byte upload/download, SHA-256 round-trip match, exclusive create and fixture-owned cleanup |
| Local forwarding | loopback listener relays real HTTP to fixture-local service; expected status/body; stop closes listener |
| Cancellation / deadlines | pre-connect, handshake, pending trust, pending auth prompt; blackhole handshake timeout |
| Stream / lifecycle | ordered 32,768-byte output, explicit bounded-buffer overflow, repeated disposal, transport-loss tunnel cleanup |
| Outer process recovery | Docker-unavailable startup erases generated keys; a child ignoring SIGTERM is killed with SIGKILL within a finite deadline; ordinary exit status preserved |

Negotiated algorithms in the recorded runs: `curve25519-sha256@libssh.org`, host key `ssh-ed25519`, `aes128-gcm@openssh.com`, no compression; empty separate MAC field accompanies the negotiated AEAD cipher This is observed negotiation, not the full supported algorithm inventory

## Findings resolved before delivery

1. Initial integration run found keyboard-interactive auth denied: ssh2 custom auth objects require an explicit `prompt` callback. Wiring the callback fixed interactive auth and pending-prompt cancellation; both now pass real fixture checks
2. Default Docker build stalled on public image metadata. Isolated temporary registry configuration resolved the build; no global Docker/account configuration changed. Root fixture container operations use the existing local daemon
3. Review found a private-key temp directory could survive Docker cleanup failure. Cleanup now attempts credential removal before reporting the sanitized Docker error; a regression test simulates Docker absence after key generation
4. Review found packaged timeout could wait forever after SIGTERM. Runner now escalates to SIGKILL with a finite final wait and performs cleanup scoped to the invocation UUID; regression tests cover ignored SIGTERM and normal exit

## Backend decision and remaining gates

Select ssh2 1.17.0 for the next production adapter work: it supports the required channel/SFTP/forwarding surfaces through one Node API and passed both host Node and packaged Electron checks. Managed OpenSSH subprocess and custom native/libssh2 adapters remain alternatives if later compatibility requirements fail; they were not implemented or benchmarked in this spike

This evidence closes the M0 compatibility question only. It does not implement the production connection service, persisted known-host UX, secret store, full transfer conflict/resume UI, xterm renderer, Thai IME, performance budgets, production IPC or account features Those retain their own tickets

Coverage is one project-owned OpenSSH/PAM server, one host-key/client-key family and one macOS arm64 host; RSA/certificates/FIDO/agent auth, wider algorithms, exit-signal behavior, other servers/platforms and native SSH/SQLite/Keychain ABI compatibility are unverified. The `.app` is a local unsigned feasibility artifact, without Developer ID signing, notarization, production artwork/font packaging or clean-machine release acceptance

Forced Electron termination has run-scoped recovery for matching containers and temporary credential directories; this is not a guarantee against every Docker daemon/CLI outage or descendant-process race. Such failures are reported instead of being counted as successful cleanup

## Reproduce / rollback

Follow [spike README](../../spikes/ssh-compat/README.md): build only this fixture image, install exact lockfile dependencies with optional native hooks disabled, explicitly prepare Electron runtime, then run checks/matrix/package/matrix in order No host SSH service, production account or user Keychain is needed

Stop/remove only this run's generated containers and temporary directories; never prune Docker globally or reset unrelated files. The fixture image and ignored local package may remain for reproduction Revert the SST-002 commit only if rollback is requested; SST-001 ADR commit remains independently reviewable
