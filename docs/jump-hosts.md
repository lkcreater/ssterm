# Jump hosts and proxies (SST-030)

Saved hosts can connect directly, through another saved host, or through an HTTP CONNECT / SOCKS5 proxy. A host configured through a jump host can itself use another jump host, up to three jump hosts before the final target (four SSH hops total). A host uses either a jump chain or a proxy; these route choices cannot be combined on the same saved host.

## Jump chain behavior

The app opens the outermost jump host first, then opens each next SSH connection over a `direct-tcpip` channel from the previously authenticated hop. The final SSH connection carries the requested terminal, SFTP, or tunnel session. Each hop uses that saved host's effective port, username, identity, and inherited catalog settings.

Host-key trust is checked independently for every SSH endpoint using the shared known-host policy. A prompt identifies the host whose key is being checked and, for an intermediate hop, says which final target it is on the way to. Trust is stored against that hop's endpoint, not the proxy or final target. Changed keys continue to block the connection until deliberate replacement.

Authentication is also per hop. Only that hop's configured identity and its own key/password/passphrase/keyboard-interactive prompt are used. A credential is never offered to the next hop. The UI labels intermediate-hop credential prompts with the hop's user and endpoint, plus the final target context.

The local app does not resolve the address of a host reached after a jump: the current jump server resolves and connects to the next host. A direct connection still resolves from the Mac. A cycle or a chain longer than three jumps is rejected during catalog validation and resolution. A saved host cannot be deleted while another host still refers to it as a jump host, because deleting it would silently change the route.

Each connection, forwarded channel, and proxy socket is owned by the session. Cancellation, app lock, hop failure, timeout, and disconnect dispose the chain. A jump server refusing its onward `direct-tcpip` request reports `jump-refused`; failure to authenticate a hop reports that hop's SSH error.

## Proxy behavior and limits

HTTP CONNECT and SOCKS5 are supported without proxy authentication. The proxy applies to the outermost SSH hop. HTTP CONNECT asks the proxy to connect to that hop's host and port; SOCKS5 sends DNS names unresolved so the proxy resolves them, while IP literals are sent in their address form. The app does not store proxy credentials and does not prompt for proxy authentication. A proxy refusing the request or returning an invalid response reports `proxy-failed`; connection errors, DNS failures, timeout, and cancellation retain their respective outcomes.

The handshake is bounded to 15 seconds by default. HTTP response headers are capped at 8 KiB; SOCKS5 replies have a bounded address field (IPv4, IPv6, or a nonempty domain of at most 255 bytes) and require the correct version, success status and reserved byte. Bytes arriving immediately after the successful handshake are preserved for the SSH protocol. Proxy response text is not surfaced to the user. Proxy settings cannot be combined with a jump host on the same host; to reach a jump chain through a proxy, configure the proxy on the outermost jump host.

## Storage and rollback

Schema version 3 adds nullable `jumpHostId`, `proxyType`, `proxyHost`, and `proxyPort` columns to `host`, plus an index for jump-host references. Existing rows receive `NULL` values and keep their previous direct-connection behavior. Migration 2 → 3 extends the table with `ALTER TABLE` (the host table is referenced by other tables), and preserves protected vault content and pending secret-operation journals.

The migration system creates a verified backup before applying the migration chain. A schema-3 store is refused by older app builds. To roll back after migration, close the app and restore the matching `catalog.sqlite.v2-*.backup` beside the catalog, then run the older build. A store upgraded directly from schema 1 instead has a `catalog.sqlite.v1-*.backup`. Reverting application code alone does not downgrade the database. Preserve the current catalog before restoring a backup.

## Verification coverage

Unit coverage in `tests/unit/host-chain.test.ts`, `tests/unit/jump-hosts.test.ts` and `tests/unit/proxy.test.ts` exercises chain resolution and limits (including edits extending a dependent server's route), per-hop host trust and credential isolation, cancellation and cleanup, refused forwarding, and HTTP CONNECT/SOCKS5 protocol handling with test-owned local proxies. Regression checks cover malformed proxy replies, coalesced SSH banners, IPv4-embedded IPv6 encoding, and incomplete proxy records rejected by database constraints. The proxy checks are unit-level integration tests; there is no proxy Docker E2E.

`tests/e2e/jump-hosts.spec.ts` exercises the shipped packaged main adapter against test-owned OpenSSH jump fixtures for one and two jumps, per-hop trust prompts, intermediate authentication failure, refused onward forwarding, and cleanup. `tests/e2e/jump-hosts-ui.spec.ts` exercises configuring and connecting through a jump host, prompt labeling, cycle rejection, and refusing deletion of a host in use. E2E runs use owned fixtures and suppress traces/screenshots/video around credential-bearing scenarios.

SST-030/T038 is delivered (2026-10-18): typecheck/build/package PASS, unit 451/451, development E2E 66/66, packaged 67/67. The additional minimum-window check found a validation-text contrast issue; after the correction, Jump UI and eight affected catalog/release checks passed, followed by the full packaged suite on final source. Independent review has no remaining material findings. See [the SST-030 delivery record](agent-runs/sst-030-delivery.md) for evidence, visual context, and limits.
