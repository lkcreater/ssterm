# ssterm — local release guide (macOS arm64)

**Status:** SST-028 local, reviewable package. The app is **ad-hoc signed** with the stable identifier `dev.ssterm.desktop`; it is **not** signed with an Apple Developer ID and **not** notarized. Signing, notarization, publishing and upload need credentials and authorization and are a separate future gate. Release notes: [0.1.0](0.1.0.md).

## Build the artifacts

From the repository root (verified commands; see [AGENTS.md](../../AGENTS.md)):

```sh
npm ci --ignore-scripts
npm run runtime:prepare
npm run package:mac      # build, derived icon, notices, Info.plist, fuses, ad-hoc signature → artifacts/package/
                         # Google sign-in: fill .env.local first (see docs/app-lock.md)
npm run release:local    # zip, SHA256SUMS, release-manifest.json → artifacts/release/ (refuses a package built
                         # from another commit or a dirty tree; `node scripts/release-local.mjs --allow-dirty` = trial)
npm run test:packaged    # packaged E2E incl. artifact review and upgrade fixture
```

`release-manifest.json` records version, bundle id, Electron, minimum macOS, signature kind, and the commit and clean-tree state captured when the package was built (`trial: true` marks an `--allow-dirty` archive). Verify a download with:

```sh
cd artifacts/release && shasum -a 256 -c SHA256SUMS
```

## Install

1. Unzip `SSTerm-<version>-darwin-arm64.zip` (Finder or `ditto -x -k`), move `SSTerm.app` to `/Applications`.
2. Because the app is not notarized, Gatekeeper blocks the first launch of a downloaded copy. On macOS 15 or later: try to open it, then choose **System Settings → Privacy & Security → Open Anyway** and confirm. On macOS 13–14: Control-click → **Open** → **Open**. Alternatively, after verifying the checksum, remove the quarantine flag: `xattr -dr com.apple.quarantine /Applications/SSTerm.app`.
3. Requirements: Apple silicon, macOS 13 or later (Electron 44's minimum, `LSMinimumSystemVersion`). Tested on macOS 15.7 arm64 only.

ssterm needs no account and makes no network requests except SSH connections you start. The first time you open Desktop, Documents, Downloads, a network or a removable volume in **Files**, macOS asks for access with ssterm's own explanation.

## Where data lives

| Data | Location | Notes |
|---|---|---|
| Hosts, groups, tags, identities (metadata), known hosts, snippets (ciphertext), tunnel rules, workspace templates, settings | `~/Library/Application Support/ssterm/metadata/catalog.sqlite` (+ `-wal`, `-shm`) | SQLite, schema version 4; directory `0700`. Snippet bodies are AES-256-GCM ciphertext. The folder name is fixed in code (`appData/ssterm`) |
| Remote-edit working copies and immutable upload snapshots | `~/Library/Application Support/ssterm/remote-edit-temp/` | Plaintext, private `0700` directories and `0600` document/`0400` snapshot files. Explicit discard and lifecycle cleanup remove only owned copies; verified marked leftovers are retried on startup. TextEdit's independent copies are outside this cleanup |
| Passwords, private keys, passphrases, the snippet content key | login Keychain, generic passwords with service `dev.ssterm.desktop.secrets` | Never in the database. Item access is bound to the app's code signature |
| Chromium data (caches, local state) | `~/Library/Application Support/ssterm/` beside `metadata/`; possibly `~/Library/Caches/SSTerm` | No credentials |
| Logs, telemetry | none | ssterm writes no logs and sends no telemetry |

## Upgrade

Replace `SSTerm.app` with the newer one; your data stays where it is. The bundle id (`dev.ssterm.desktop`), app name (`ssterm` → data folder), database path and Keychain service names are fixed, and the packaged upgrade fixture verifies that metadata written by another build reopens unchanged and that Keychain-held secrets survive relaunching a signed build.

**Prompts after an upgrade:** macOS binds Keychain item access and folder permissions to the code signature. An ad-hoc signature is identified by a hash that changes with every build, so after replacing the app macOS may ask again whether **SSTerm** may use its saved Keychain items (choose **Always Allow**) and may repeat the Desktop/Documents/Downloads/volume prompts. If Keychain access is denied, saved passwords are unavailable (ssterm asks for the password) and snippets cannot be opened until access is allowed. The cross-build Keychain prompt itself was not exercised in automated tests. Prompt-free upgrades require Developer ID signing.

A newer database schema is refused by an older app ("A newer ssterm version is required"); keep the original files. Downgrades are not supported.

## Uninstall

1. Quit ssterm (running tunnels and sessions close; owned remote-edit cleanup is attempted).
2. Delete `/Applications/SSTerm.app`.
3. To remove your data as well: delete `~/Library/Application Support/ssterm` (and `~/Library/Caches/SSTerm` if present), and in **Keychain Access** delete the items named `dev.ssterm.desktop.secrets`. Removing the folder without the Keychain items (or the reverse) leaves the other half unusable but harmless.
4. Optional: reset folder permissions with `tccutil reset All dev.ssterm.desktop`.

## Release checklist (SST-028)

| Item | Status |
|---|---|
| Packaged artifact on macOS arm64 with a clean profile | PASS — every packaged E2E launches a fresh temporary profile (63 tests incl. SSH, SFTP, tunnels on the owned OpenSSH fixture, artifact review, upgrade fixture) |
| Native bindings load packaged | PASS — Keychain round trips and `keyring.darwin-arm64.node` unpacked |
| Storage/secret identifiers stable | PASS for identifiers: metadata written by another build reopens unchanged; Keychain items survive relaunch of the same signed build. Cross-build Keychain access (re-signed upgrade) is prompt-dependent and unverified (documented above) |
| Version, checksums, notes, manifest | PASS — `release:local` |
| Offline fonts, notices, licences | PASS — local woff2, `THIRD_PARTY_NOTICES.txt`, Electron/Chromium licences in `Contents/Resources` |
| App icon from supplied artwork (DS06) | PARTIAL — derived 16–1024 px and `.icns`, transparent corners, ~11–13 % padding; legible at 32 px and above, **16 px not legible** (needs an adapted small-size variant); Dock/Finder visual check not performed; brand lockup not in About. Release branding is not claimed as passed |
| Developer ID signing / notarization | NOT DONE — no credentials; unsigned limitation |
| Clean macOS user/VM | NOT DONE — tested in fresh profiles on one development Mac |
| Manual: real menu ⌘C/⌘A, VoiceOver, TCC prompt from Finder, Thai IME | PENDING — needs a human operator. Info.plist now carries ssterm's folder usage strings and drops Electron's camera/microphone/Bluetooth strings; the signing identifier is `dev.ssterm.desktop` (not `Electron`), but ad-hoc grants still do not survive rebuilds |
| Manual: native TextEdit UI/save/autosave for SST-032 | PENDING — automated [remote-edit checks](../remote-edit.md) launch a project-owned editor process through the shipped launcher seam and verify safe fixed TextEdit arguments. Native TextEdit and its independent retained copies require a manual check using owned fixture text; app cleanup cannot revoke editor copies |
