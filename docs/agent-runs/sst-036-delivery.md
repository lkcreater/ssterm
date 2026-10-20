# SST-036 / T043 — Sync cryptography and key lifecycle

**2026-10-20 · DONE — protocol specification and conformance gate.** The authorized scope is a protocol decision and isolated conformance tests before SST-035, not enabled synchronization.

## Delivered scope

[ADR 0006](../adr/0006-sync-cryptography-and-key-lifecycle.md) and [the protocol](../sync-crypto.md) define the independent threat model, canonical wire bytes, key hierarchy, enrollment trust, signed authority/roster checkpoints, rotation/revocation, recovery, lock/logout, key loss and version migration. The chosen primitives use existing Node/OpenSSL: AES-256-GCM, HKDF-SHA256, Ed25519 and RSA-OAEP-3072 with explicit SHA256/MGF1-SHA256. Recovery uses an independent random 256-bit secret, never an app-lock password, Google token or app-lock recovery code.

The [envelope reference](../../tests/fixtures/crypto/reference.ts), [control reference](../../tests/fixtures/crypto/control-reference.ts) and [unit suite](../../tests/unit/sync-crypto.test.ts) are test-only. [Fixture provenance](../../tests/fixtures/crypto/README.md) distinguishes independently published RFC/NIST/Wycheproof known answers from project regression vectors. Public synthetic fixture keys do not belong to a real user or server; the separate generated owner RSA fixture retains only its public SPKI. No application imports this harness; no new dependency, IPC, UI, network exchange, database migration or Keychain operation is added. Schema remains 4 and local `aes-256-gcm-v1`/recording formats remain unchanged.

## Review findings and resolution

- The first independent review identified underspecified control/enrollment transcripts as high severity. The revision fixes ordered certificate/roster/control/enrollment schemas, signature domains and commitments, including dual owner signatures for rollover.
- Parser limits now bound every message/key/roster/challenge/recovery epoch list. Newly received authenticated operations from stale control/epochs or revoked/downgraded authors remain conflicts; timestamps cannot prove creation before revocation.
- Root review found a rollover recovery gap: the base checkpoint's old-owner signature needs its previous public key. The recovery payload now carries that canonical SPKI, verifies its fingerprint and both signatures, and treats the authenticated recovery kit plus independent owner expectation as its trust anchor.
- Recovery ciphertext references an already accepted base checkpoint; a successor checkpoint commits the recovery descriptor. This avoids a circular checkpoint/ciphertext commitment.

Final independent static review passed with no unresolved critical/high findings. Follow-up review also aligned the 256-device roster framing ceiling, preserved immutable original admission metadata across owner rollover/re-signing, and corrected the genesis vector to its specified zero admission commitment. The reference deliberately verifies descriptor digest binding only; descriptor/payload import and durable journals remain adoption work.

## Verification

Node 24.11.1 was used (setup npm 11.6.2; independent tester reported npm 11.0.0). The shell initially selected Node 20 and dependencies were absent. Root downloaded the official macOS arm64 Node archive into a task-owned temporary directory, verified its SHA256 against official sums, installed the existing lockfile with `npm ci --ignore-scripts`, and ran `npm run runtime:prepare`. Network-dependent setup required host access after sandbox DNS failures; manifests/lockfile were unchanged.

| Check | Actual result |
|---|---|
| New crypto/control suite | 60/60 PASS, including 37 Wycheproof and 3 NIST subcases |
| Final focused crypto + protection + secrets + app-lock | 96/96 PASS with host access for owned loopback/Keychain fixtures |
| Full `npm test` | 648 total, 646 passed, 0 failed/cancelled, 2 skipped; independent run exit 0, 28.3 s |
| Final `npm run typecheck` | PASS |
| `npm run build` | PASS; subsequent changes affected only docs/test fixtures |
| Scope / links / whitespace | No harness imports under `apps/` or `packages/`; new relative links resolve; `git diff --check` PASS |

The two skipped existing shell cases are the owned Docker bash 5.2 fixture (Docker daemon unavailable on this run) and Homebrew bash 5 (absent). They are unrun, not passes. Existing recording SSH/bash runtime behavior retains its earlier SST-034 evidence.

The first focused attempt passed all new crypto cases but encountered existing OAuth loopback `EPERM` and a Keychain provider failure under sandbox constraints; the final host-access 96/96 resolved those failures. A duplicate root full-suite attempt was interrupted/inconclusive (638 results, an SSH-file pending-promise cancellation) and is excluded from the pass claim; the independent full run is authoritative. A separate root SSH regression check subsequently passed 41/41 with no cancellation.

`npm audit --json` reports **7 high, 0 critical** advisories in the existing development-tool chain: `shadcn`, `@shadcn/registry`, `@ts-morph/common`, `ts-morph`, `fast-glob`, `micromatch`, `braces` (GHSA-vfj7-8cjw-p6xm). These are unchanged baseline dependencies, not a new crypto provider. npm's suggested change alters the selected tooling version; no automatic audit fix or lockfile update was made in this protocol-only ticket. The audit is not a clean security certification.

## Limits and downstream gates

Internal protocol review and provider known answers are not an external cryptographic audit or proof of the complete composition. Persistent replay/high-water enforcement, provider/publication journals, real enrollment/recovery drills, transport authentication/rate limits and multi-device offline conflict/tombstone behavior are SST-035 integration gates. SST-037 separately proves team ACL/tenant boundaries, rekey and cached-access limitations. A fully reset client cannot prove global freshness from a stale kit against a malicious server; revoked devices can retain already obtained keys/plaintext. There is no forward secrecy, post-quantum or remote-erasure guarantee.

Existing native Thai IME/VoiceOver/menu/TCC/TextEdit and Developer ID/notarization checks remain pending. No E2E/package rerun is claimed for this isolated docs/test change; the last runtime baseline remains SST-034 development 79/79 plus final integration 10/10 and packaged 80/80.

Rollback removes this docs/test commit without changing user data or keys. Production protocol rollback must preserve incompatible envelopes/key refs and disable writes instead of silently downgrading. Local commit only; no push, hosting or publication. SST-038 is next in the already authorized order.
