# Personal encrypted sync server

Node **24.11.1+**; no server dependency install needed. Run from the repository root:

```sh
node --experimental-transform-types apps/sync-server/src/cli.ts init /absolute/owned-directory/server.json
node --experimental-transform-types apps/sync-server/src/cli.ts start /absolute/owned-directory/server.json
```

The account token authorizes the **first valid self-signed genesis only while the configured vault is empty**. Keep it private and initialize the intended owner promptly. A token holder who reaches an empty server first can claim that bootstrap slot and deny the intended owner's setup. The creating client independently pins its generated owner fingerprint; it must refuse a different server authority and preserve local keys/pending bytes for review. After genesis, token possession cannot authorize enrollment, roster changes or owner rollover: those require the accepted owner's signatures.

`init` prints the random account token once. Keep that output private. The private config/database contain its SHA-256 digest, never the token. Init refuses existing config/database paths. Start requires the existing database and matching scope/hash; foreign database/schema is refused. Default listener is `127.0.0.1:8787`. Every configured database represents one personal deployment/account/vault; use separate config/database/listeners for independent tenants.

Remote use requires an operator-managed HTTPS reverse proxy with request body/header/time limits; clients reject public HTTP and redirects. The server deliberately does not enable CORS or registration. It never receives private encryption keys or ordinary plaintext catalog data. Config, database, filesystem and TLS remain operator responsibilities. Backups do not include client Keychain keys. See [protocol and limits](../../docs/sync.md).

A Dockerfile is supplied for an owned lab; it does not deploy anything. Build with repository root context (`docker build -f apps/sync-server/Dockerfile -t ssterm-sync-fixture:sst035 .`). Explicitly bind a private config/data directory owned by UID 1000 at `/data`; for a container listener configure `host` as `0.0.0.0`, and publish only to loopback (for example `-p 127.0.0.1:8787:8787`). No production hosting, remote service or TLS setup is included.

Owned Docker smoke (after building that image):

```sh
node --experimental-transform-types tests/fixtures/sync/docker.mjs
```

The smoke creates a UUID-labeled container without a data mount, verifies restart persistence/ciphertext access controls, and removes only the container whose ownership label matches. It does not configure hosting.
