# 07: External MCP clients: pairing, binding, bridge

**What to build:** An external AI client can be paired with ssterm and bound by the user to a session. Through the Unix socket, or the bundled `ssterm-mcp` stdio bridge, it then uses the terminal tools under the same mode, plan, PROD and password rules.

**Blocked by:** 02, 04

**Status:** done

- [ ] Off by default. The 0600 Unix socket lives in the profile and no TCP is opened. The `ssterm-mcp` stdio bridge is bundled, signed and packaged.
- [ ] Pair new client issues a short-lived one-time token. The client exchanges it for a per-client credential kept in Keychain. The user approves the client name.
- [ ] Clients cannot list sessions or the catalog. A binding request opens an ssterm drawer where the user picks a Ready SSH session, and the binding lasts until the session ends, the workspace locks, or the user revokes it.
- [ ] A banner names the controlling client and mode, with Stop. Settings lists clients with last use and Revoke.
- [ ] Lock workspace drops all connections and bindings; after unlock, a new binding is required.
- [ ] E2E: pairing, binding, a command under Auto with plan approval, revoke, lock and a wrong token, all through the stdio bridge with a test client, in development and packaged runs.
