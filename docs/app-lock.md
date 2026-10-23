# App lock — SST-039

**2026-10-17 · T053 · DONE through independent TEST/REVIEW/DELIVER.** Design and accepted risks: [ADR 0004](adr/0004-local-app-lock.md). [Delivery](agent-runs/sst-039-delivery.md).

## Behavior

- **First launch** shows *Set up sign-in*: a username + password form (zod: user name 3–64 characters without control characters, password at least 12, confirmation must match; the same schema runs again in main) or **Sign in with Google**. A recovery code (30 characters) is shown once; Continue is enabled after confirming it was saved. Existing workspaces see this screen once after updating; their data is unchanged.
- **Every app start** shows *Unlock ssterm*. Until it succeeds, main serves only bootstrap and the app-lock channels; every other IPC answers `unauthorized`, and no feature state is pushed. Wrong attempts back off 1, 2, 4 … 30 s. Screen lock/sleep keep the existing behavior.
- **Google:** ssterm opens the system browser; Google redirects to `http://127.0.0.1:55411/oauth/callback`, a listener that exists only during the sign-in (at most 5 minutes, one callback, Host and `state` checked). PKCE S256, `nonce`, ID token verified with Google's keys (`iss`, `aud`/`azp`, `exp`, verified email). Only the account bound at setup unlocks. No Google token is stored. Port 55411 in use is reported. Offline: “Continue offline” if the last Google sign-in is under 7 days old and Google is unreachable.
- **Recovery:** *Forgot? Use a recovery code* → a correct code allows a new setup (password or Google) and issues a new code; the old code stops working. If the Keychain record is missing but the profile marker exists, only the recovery code is offered.
- **Lock workspace (SST-040, [ADR 0004 amendment](adr/0004-local-app-lock.md#amendment--manual-relock-sst-040-2026-10-22)):** the sidebar-footer action (hidden when the lock is off) sends the owner-checked, strict `lockNow` command (`ssterm:app-lock-lock-now`, `{ owner }` → `{ status: "locked" | "not-allowed" | "busy" }`). Main runs the screen-lock/suspend session lock for the whole process and closes the app lock in the same synchronous turn, so no feature IPC is served in between and the remaining teardown runs behind the gate; then it reloads every window, which rotates its owner (unregistering feature pushes) and bootstraps it into the gate as at launch. A Settings confirmation window ends; an unlock, confirmation, recovery, Google sign-in (aborted) or offline unlock still in flight cannot open the app. A password/Google change or new recovery code from Settings that has not started its Keychain write is abandoned (old record and recovery code stay valid); while that write is in flight Lock workspace answers `busy` and locks nothing, so a saved code is never lost to a reloaded window and the change can never reopen a locked app. A failing session lock still locks and reloads. Backoff and Google offline grace are unchanged. A repeat while locked re-fences sessions without reloading. `not-allowed` while the lock is off or before a sign-in exists.
- **Live-work confirmation (SST-040/13):** the action first asks main `liveWork` (`ssterm:app-lock-live-work`, owner-checked strict `{ owner }`, answered only while unlocked, otherwise `unauthorized`) → `{ terminals: { phase, local?, target }[] (display fields only), tunnels: { ruleId, phase }[], transfers, remoteEdits }` over every window, by the close/quit rules (terminals connecting or ready, tunnels starting or running, main's pending transfer count, pending remote edits). Empty → lock at once. Otherwise a right-edge alert drawer lists the terminals (target, PROD), port forwards, transfers and remote edits with Cancel focused and a red **Lock and close N** (double-click guarded, keyed per open); Cancel/Esc/× keep everything. If the question fails, the drawer still asks ("couldn't check for live work", **Lock and close all**) instead of locking silently. The list is a snapshot: confirming runs `lockNow`, which closes whatever is live at that moment, including work started after the question. An OS screen lock while the drawer is open closes it (no gate). OS screen lock/suspend stay immediate and never ask.
- **Settings → Security (Sign-in):** confirm the current password (or Google) to change the password, switch method or create a new recovery code (a 2-minute window).

## Build with Google

1. In Google Cloud Console create an OAuth client of type **Desktop app** (no redirect URI to add; ssterm uses `http://127.0.0.1:55411/oauth/callback`).
2. Fill in the gitignored `.env.local` at the repository root (created from `.env.example`, mode 0600):

   ```sh
   SSTERM_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   SSTERM_GOOGLE_CLIENT_SECRET=xxxxxxxx
   # or instead: SSTERM_GOOGLE_CLIENT_FILE=~/Downloads/client_secret_….json
   ```

3. `npm run dev` or `npm run package:mac` reads it at build time (values exported in the shell take precedence). An ID without a secret fails the build; with nothing set the Google option is shown disabled.

The client ID and secret are compiled into the main bundle (Google treats installed-app secrets as non-confidential). Never commit them: `.env.local`, `.env*.local` and `client_secret_*.json` are ignored.

## Tests

`tests/unit/app-lock.test.ts` (schemas, verifiers, backoff, recovery, marker, tampered parameters, uncertain writes, Google grace, OAuth with fake JWKS, loopback listener, gate) and `tests/e2e/app-lock.spec.ts` (password setup/unlock/backoff/Settings/recovery, Lock workspace with nothing live and with a live Docker OpenSSH terminal, local terminal, tunnel and pending transfer, and Google through a local fake provider), development and packaged. E2E launches enable the lock with `SSTERM_TEST_APP_LOCK=on` and a fake provider with `SSTERM_TEST_GOOGLE`; both are honoured only with a test profile, and other specs run unlocked. `SSTERM_TEST_LOCAL_HOME` (test profiles only, a directory inside the profile) starts local terminals in an owned home, so the live-work E2E never runs the developer's shell startup files.

## Limitations

See ADR 0004: an access gate, not encryption; same-user reset by deleting both stores; `--inspect` stays available on the packaged binary; offline grace needs no extra secret; backoff resets on relaunch; the lock screen shows the user name or Google email; other windows are not told about an unlock (single window today). A real Google sign-in was not exercised in automated tests (fake provider only).
