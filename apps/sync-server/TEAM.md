# Owned self-hosted team ciphertext server

SST-037 is a separate server entry, database and listener. It does not change the personal SST-035 server. Each configuration supports exactly one team with an independent Owner authority and independent human transport tokens. The server persists public policies, ciphertext snapshots, token hashes and bounded opaque audit fields; it cannot verify decrypted host/password content.

Node 24.11.1 or newer is required. From the repository root, initialize a fresh private directory:

```sh
node --experimental-transform-types apps/sync-server/src/team-cli.ts init /path/to/private/team.json
node --experimental-transform-types apps/sync-server/src/team-cli.ts start /path/to/private/team.json
```

`init` prints the initial Owner principal ID, scope and random token once. Protect that output and independently transfer it to the intended Owner; the config/database retain only the hash. The first valid signed genesis initializes authority, so an attacker with the bootstrap token can squat an empty vault. Desktop clients pin their locally generated authority before uploading and reject alien authority. Do not publish tokens in logs, shell history or source control. Initialization refuses an existing config or database. Backup the private config and database consistently; unknown/foreign schemas refuse startup.

Loopback HTTP is for an owned local lab. Remote clients require HTTPS with a trusted certificate, terminate TLS at the operator's reverse proxy, retain the exact root-origin route paths and forward the scoped headers. Do not expose an unprotected plaintext listener publicly. No hosting, reverse proxy configuration or deployment is included here. No external account/SSO service is used. Token possession grants the current human role only; data reads additionally require that principal's currently approved device and a one-use signed nonce. The old bootstrap hash never bypasses accepted membership.

Owner manages members, independent secret token transfer and shared passwords. Editor edits metadata and connects; Connector connects; Viewer reads metadata without credential ciphertext/wraps. Exactly one Owner device is allowed; non-Owner humans may have multiple devices. Changing a role removes all that principal's devices and requires new approval. Revocation and role changes rotate both encryption domains and re-encrypt retained snapshots atomically. New connections require current online authorization. Revocation cannot retract copied plaintext or rotate an actual remote SSH password.

Owner recovery needs the independently retained Owner transport token plus the encrypted kit and independent recovery secret. The token-only recovery endpoint returns ciphertext and public policy/control data, never epoch wraps or keys. A stale kit missing current epoch keys fails on the client before publication. Loss of the Owner token requires separate operator account recovery, outside this release; editing the server database must never substitute for client authority verification.

Bounds reject writes without pruning protected history: 32 principals, 128 devices, 256 policy checkpoints/64 MiB, 256 operations/64 MiB per domain and 256 epoch wraps per publication. HTTP bodies/responses are at most 12 MiB, four concurrent request bodies and 120 requests/minute per remote address and principal. Audit retains 10,000 entries and discloses its first retained sequence; event deduplication is limited to 10,000 unique client event IDs, after which further event submissions fail `too-large`. Audit event labels explicitly identify client-reported connection lifecycle; these do not prove SSH success or command execution. No command text, passwords or host/member labels are audit fields.

Owned verification only:

```sh
docker build -f apps/sync-server/team.Dockerfile -t ssterm-team-fixture:sst037 .
node --import tsx tests/fixtures/team/docker.ts
```

The fixture publishes a random loopback port, creates no mounted user volumes, and removes only its recorded container after checking its exact fixture label. See [team behavior and limitations](../../docs/team-vault.md).

Before genesis, possession of the provisioned Owner bootstrap token can establish the initial Owner authority. Protect that token against empty-team squatting and independently verify the Owner fingerprint before enrolling another device. Once genesis is accepted, the server requires the signed authority chain and current membership; a bootstrap token does not reset it.
