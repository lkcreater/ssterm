# SST-002 isolated SSH compatibility spike

This CommonJS harness tests `ssh2` 1.17.0 against the project-owned Debian OpenSSH/PAM fixture. It is separate from production application modules and uses no Termius profiles, real credentials, Keychain, renderer or UI dependencies.

On the observed macOS arm64 host with Node 24.11.1+, npm, Docker daemon and `ssh-keygen`:

```sh
# From repository root:
docker build -t ssterm-ssh-fixture:m0 tests/fixtures/ssh
cd spikes/ssh-compat
npm ci --omit=optional --ignore-scripts
npm run runtime:prepare
npm run check
npm test
npm run package:mac
npm run test:packaged
```

The Docker image must already exist. Each run creates its own random-named, labelled container bound only to a dynamic `127.0.0.1` host port, generated password, encrypted OpenSSH Ed25519 key and private temporary directory. Teardown removes the exact owned container/directory and checks that its port is closed. Do not replace the endpoint with a real host. The suite serializes tests and rotates the actual fixture host key at the same endpoint. Reports contain sanitized outcomes, negotiated algorithms and versions; private keys, passwords, passphrases and raw errors are never written to reports.

The shared Node/Electron probes cover explicit trust and changed-key rejection before auth, password/encrypted-key/PAM keyboard-interactive auth, PTY input/resize/UTF-8/exit, streaming SFTP upload/download hashes, loopback forwarding through the fixture HTTP server, denied auth, handshake deadlines, cancellation before/during connect/trust/auth, ordered bounded output, repeated disposal, transport-loss cleanup and final fixture cleanup. `artifacts/node-report.json` and `artifacts/packaged-report.json` record actual results; their presence alone is not a pass. Failures exit nonzero.

Packaging uses the installed exact Electron distribution, `@electron/packager` 20.3.0 and production `ssh2` dependency, producing an **unsigned** local `dev.ssterm.spike` arm64 `.app` under ignored `artifacts/`. `test:packaged` launches its actual executable and reruns the same real fixture suite after `app.whenReady`. User data/session data use a temporary spike directory. Install with both `--omit=optional --ignore-scripts`: this excludes optional CPU detection and prevents ssh2's bundled optional crypto build hook. `runtime:prepare` then explicitly downloads the pinned Electron runtime if absent. Both suites assert that native SSH acceleration is not loaded; this is not an Electron native ABI proof. No production signing/notarization or distribution is configured.

Scope limits: one Linux OpenSSH/PAM server and one host/key format do not establish broad algorithm/server compatibility. PTY byte tests do not establish terminal rendering, Thai IME or accessibility. SSH backend ownership in this spike is not a production service implementation. SFTP uses exclusive creation on its owned path; fixture teardown removes partial data. Native SQLite/Keychain, persistent host trust, production IPC, full transfer-conflict UX and packaged release gates remain later tickets. See [ADR 0001](../../docs/adr/0001-mvp-platform-stack.md) and [execution plan](../../docs/agent-runs/implementation-plan.md).
