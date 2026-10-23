# ADR 0004 — Local app lock (password or Google)

**Status:** Accepted 2026-10-17 (SST-039, authorized by the user: “เริ่มงานตาม plan”).

## Context

The user asked for sign-in before using ssterm: either a local username + password set on first launch (validated with zod) or “Sign in with Google” through a loopback callback on port 55411. Decisions taken with the user: it is a **local app lock** (not an account and not data encryption); one method is chosen at first launch and can be changed in Settings; sign-in is required **when the app opens** (screen lock/sleep keep the existing behavior); a **recovery code** is issued at setup; Google unlock accepts only the account bound at setup, and offline the last successful Google sign-in counts for **7 days**.

## Decision

- **Marker:** a non-secret `app-lock.json` (mode 0600) in the profile records that a lock was configured, with a copy of the recovery-code verifier. A missing or corrupt Keychain record with the marker present does **not** fall back to first-run setup; only the recovery code leads to a new setup. An unreadable Keychain shows a Try again screen.
- **Storage:** one Keychain generic password (service = the app's secret namespace, account `app-lock/v1`) holding a JSON record: method, username, scrypt password verifier, scrypt recovery-code verifier, Google `sub`/email and last successful sign-in time. Not SQLite: adding a table needs a migration, and migrations refuse protected vaults (ADR 0003), which would lock existing users out.
- **Verifiers:** Node `crypto.scrypt` (N=2^15, r=8, p=1, 32-byte salt, 32-byte key) compared with `timingSafeEqual`. Records with other parameters are rejected. An uncertain Keychain write is read back before it is reported. No custom cryptography.
- **Packaged binary fuses:** RunAsNode and NODE_OPTIONS disabled; the app loads only from its integrity-validated archive. The Node inspector switch stays enabled because the packaged Playwright suite drives the app through it.
- **Enforcement in main:** an app-lock gate refuses every IPC channel except bootstrap and the app-lock channels until the process is unlocked; the renderer screens are presentation only. Failed attempts back off 1, 2, 4 … 30 s per process.
- **Google:** installed-app OAuth with the system browser, PKCE S256, `state`, `nonce`, scope `openid email`, redirect `http://127.0.0.1:55411/oauth/callback` (IP literal instead of `localhost` to avoid IPv6 resolution mismatches). The listener binds 127.0.0.1 only, lives at most 5 minutes, accepts one callback and closes. Main exchanges the code and verifies the ID token (RS256 against Google's JWKS, `iss`, `aud`, `exp`, `nonce`), then compares `sub`. No access or refresh token is stored. The client file is read at build time from `SSTERM_GOOGLE_CLIENT_FILE` and never committed; without it the Google option is disabled.
- **Network exception:** besides SSH, ssterm contacts Google (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`) only when the user uses Google sign-in, from main; the renderer CSP is unchanged.
- **Tests:** `SSTERM_TEST_APP_LOCK=off|on` is honoured only with a test user-data directory; existing specs run unlocked, app-lock specs turn it on. A fake OAuth server is selected only in test mode.

## Consequences and accepted risks

- It is an access gate: anyone with the user's macOS session can still read the database files, delete both the Keychain record and the marker to get first-run setup again, or start the binary with `--inspect`. Documented.
- **Offline grace (accepted with the user's choice):** in Google mode, if Google cannot be reached and the last successful Google sign-in is under 7 days old, “Continue offline” unlocks without any other secret. Someone at the Mac can trigger it by cutting the network; a daily user is usually inside the window. Requiring the recovery code (or a local PIN) offline is the stricter alternative.
- The offline grace relies on the local clock. Backoff resets when the app restarts.
- An ad-hoc signed upgrade may make macOS ask for Keychain access to the lock record; denying means the recovery code is needed.

## Amendment — manual relock (SST-040, 2026-10-22)

The user chose to ship the UI v2 sidebar action **Lock workspace** in SST-040. Terms: *session lock* is the existing screen-lock/suspend path that closes live terminals, tunnels, transfers and remote edits and purges transient secrets; *app lock* is this ADR's gate. Lock workspace runs the session lock for the whole process (every window), then returns main to the locked state so feature IPC answers `unauthorized` until the existing gate unlocks it (same methods, backoff and Google offline grace). With live resources it first asks in a drawer ("Lock and close N"); with none it locks at once. OS screen lock/suspend keep their current behavior and still do not show the gate. The action is hidden when the app lock is off (test profiles). Races with in-flight sessions, transfers, sync and Team actions are an SST-040 test gate. Implemented in SST-040/12: a sign-in or recovery-code change that has not reached its Keychain write is abandoned by a relock (the old record and code stay valid); while that write is in flight Lock workspace answers `busy` and locks nothing, so a relock never reopens the app or loses a recovery code the user has not seen. A Keychain write blocked on an OS prompt keeps it `busy` until answered.
