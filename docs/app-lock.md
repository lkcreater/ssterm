# App lock — SST-039

**2026-10-17 · T053 · DONE through independent TEST/REVIEW/DELIVER.** Design and accepted risks: [ADR 0004](adr/0004-local-app-lock.md). [Delivery](agent-runs/sst-039-delivery.md).

## Behavior

- **First launch** shows *Set up sign-in*: a username + password form (zod: user name 3–64 characters without control characters, password at least 12, confirmation must match; the same schema runs again in main) or **Sign in with Google**. A recovery code (30 characters) is shown once; Continue is enabled after confirming it was saved. Existing workspaces see this screen once after updating; their data is unchanged.
- **Every app start** shows *Unlock ssterm*. Until it succeeds, main serves only bootstrap and the app-lock channels; every other IPC answers `unauthorized`, and no feature state is pushed. Wrong attempts back off 1, 2, 4 … 30 s. Screen lock/sleep keep the existing behavior.
- **Google:** ssterm opens the system browser; Google redirects to `http://127.0.0.1:55411/oauth/callback`, a listener that exists only during the sign-in (at most 5 minutes, one callback, Host and `state` checked). PKCE S256, `nonce`, ID token verified with Google's keys (`iss`, `aud`/`azp`, `exp`, verified email). Only the account bound at setup unlocks. No Google token is stored. Port 55411 in use is reported. Offline: “Continue offline” if the last Google sign-in is under 7 days old and Google is unreachable.
- **Recovery:** *Forgot? Use a recovery code* → a correct code allows a new setup (password or Google) and issues a new code; the old code stops working. If the Keychain record is missing but the profile marker exists, only the recovery code is offered.
- **Settings → Sign-in:** confirm the current password (or Google) to change the password, switch method or create a new recovery code (a 2-minute window).

## Build with Google

Download the OAuth client JSON of type **Desktop app** from Google Cloud Console (its redirect `http://localhost` covers any loopback port) and build with:

```sh
SSTERM_GOOGLE_CLIENT_FILE=~/Downloads/client_secret_….json npm run package:mac
```

The client ID and secret are compiled into the main bundle (Google treats installed-app secrets as non-confidential). Never commit the file; `client_secret_*.json` is ignored. Without the variable the Google option is shown disabled.

## Tests

`tests/unit/app-lock.test.ts` (schemas, verifiers, backoff, recovery, marker, tampered parameters, uncertain writes, Google grace, OAuth with fake JWKS, loopback listener, gate) and `tests/e2e/app-lock.spec.ts` (password setup/unlock/backoff/Settings/recovery and Google through a local fake provider), development and packaged. E2E launches enable the lock with `SSTERM_TEST_APP_LOCK=on` and a fake provider with `SSTERM_TEST_GOOGLE`; both are honoured only with a test profile, and other specs run unlocked.

## Limitations

See ADR 0004: an access gate, not encryption; same-user reset by deleting both stores; `--inspect` stays available on the packaged binary; offline grace needs no extra secret; backoff resets on relaunch; the lock screen shows the user name or Google email; other windows are not told about an unlock (single window today). A real Google sign-in was not exercised in automated tests (fake provider only).
