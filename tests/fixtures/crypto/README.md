# SST-036 cryptography conformance fixtures

Everything in this directory is **test-only, public fixture material**. The private keys and signing seeds are intentionally published test keys. Never use them for user data. No application/package imports this harness. The normative independent construction and deferred integration gates are in [sync cryptography](../../../docs/sync-crypto.md).

`reference.ts` uses Node/OpenSSL primitives and bounded canonical framing. Callers supply fixed salts/nonces/identities for reproducibility, plus already-trusted expected context and public keys. This is not an entropy generator, persistent replay database, enrollment service, Keychain adapter or recovery payload importer. It does not establish trust in a supplied expected context. JavaScript buffer wiping is best effort.

`control-reference.ts` checks bounded certificate/roster/checkpoint and enrollment-proof transcripts, pinned-authority signatures, admission metadata, role/epoch changes and pure operation disposition against caller-supplied authenticated state. `acceptControl` binds the opaque recovery-descriptor digest but does **not** parse or fetch a recovery descriptor. The descriptor's match to a recovery envelope, recovery payload schema, durable salt/operation ledgers, device-local access/revocation, stored high-water marks, one-shot enrollment challenge persistence and publication transactions are not implemented here. Its return value is reference evidence for tests, not a production enrollment or durable checkpoint acceptance API. Enrollment expiry/replay tests supply explicit clock/deadline/used evidence; the harness owns no trusted clock or journal.

## Independent primitive known answers

| Evidence | Exact source and parameters |
|---|---|
| HKDF-SHA256 | [RFC 5869 Appendix A.1](https://www.rfc-editor.org/rfc/rfc5869.html#appendix-A.1), fixed IKM/salt/info and 42-byte expected output transcribed in the unit test. |
| Ed25519 | [RFC 8032 section 7.1 TEST 1](https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1), empty message, fixed 32-byte seed/public key and 64-byte signature transcribed in the unit test. |
| AES-256-GCM | `nist-gcm256.json` selects Count 0 from the CAVS 14.0 `gcmEncryptExtIV256.rsp` groups with IVlen=96, Taglen=128 and (PTlen,AADlen)=(0,0),(128,128),(256,128). Independent expected ciphertext and tag are compared directly; altered tags/AAD must fail. |
| RSA-OAEP | `rsa_oaep_3072_sha256_mgf1sha256_test.json`, all 37 cases, 3072-bit RSA, OAEP SHA-256 and MGF1-SHA256, including labels and invalid padding/ciphertexts. Published expected plaintext is used for decryption; protocol encryption is separately tested by round trip. |

NIST source: [official CAVP GCM vector ZIP](https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Algorithm-Validation-Program/documents/mac/gcmtestvectors.zip), retrieved 2026-10-20. ZIP SHA-256: `f9fc479e134cde2980b3bb7cddbcb567b2cd96fd753835243ed067699f26a023`; original CRLF response-file SHA-256: `4448b4998c3f58cd9f5542ddf7c573189a721ff3d3ac24cd5177bb4910a787f8`. The JSON is a verbatim value selection with section parameters, not a new test oracle. NIST US-government test data is public domain; see [NIST copyright policy](https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-and-software).

RSA source: [C2SP Wycheproof at immutable commit 7a325932231bd7a724c791c8b0d65ea4d6d2f435](https://github.com/C2SP/wycheproof/blob/7a325932231bd7a724c791c8b0d65ea4d6d2f435/testvectors_v1/rsa_oaep_3072_sha256_mgf1sha256_test.json), retrieved 2026-10-20 without alteration. SHA-256: `c8122302f522bfd539650c71c4aa966bd1f89acb50c6f4c190030fdb9b2684a4`. Apache-2.0 license from that commit is preserved in [WYCHEPROOF-LICENSE](WYCHEPROOF-LICENSE), SHA-256 `58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd`. The unit test pins both file hashes. The fixture's `privateKeyPem` is a public corpus key, not a secret.

## Project protocol regression vectors

`project-golden.json` was generated for this repository with Node 24.11.1/OpenSSL via `reference.ts`: fixed epoch key, incremental salt, fixed nonce, RFC public signing seed, canonical IDs and UTF-8 Thai plaintext. It freezes exact header bytes, HKDF-derived operation key, ciphertext/tag, signature and commitment. **It is a project-generated regression vector, not independent evidence that the protocol construction is secure.** Golden bytes are committed and asserted; the test does not regenerate its own expected values.

`control-golden.json` likewise freezes certificate bytes/commitment, canonical roster bytes/digest, dual-signed genesis checkpoint bytes/commitment, and a fixed enrollment body/OAEP challenge/fingerprint/proof signature. The OAEP ciphertext was generated once; tests decrypt and reproduce its proof bytes, rather than expecting randomized encryption to repeat. Its owner authority seed (`cd` repeated 32), original device seed (RFC 8032 TEST 1) and new-device seed (`ab` repeated 32) are separate public test keys. Rollover uses another separate test seed (`ef` repeated 32).

`public-test-owner-rsa.pem` contains only an SPKI **public key**, generated once using Node 24.11.1 `generateKeyPairSync('rsa', { modulusLength: 3072 })` with exponent 65537. Its private key is not retained in the repository. It has no production origin, user data or independent known-answer status. It lets the genesis device and newly enrolling device use distinct wrapping keys; the latter uses the published Wycheproof key. Adversarial tests additionally generate transient synthetic RSA keys in memory.

## Verification

At repository root with the manifest-required Node 24 runtime:

```sh
node --import tsx --test tests/unit/sync-crypto.test.ts
npm run typecheck
```

Neither command needs network, Docker, Keychain, an account or a GUI for this suite. Enrollment, durable checkpoint/replay persistence, multi-device rotation/revocation, native publication journals, full recovery drills and external cryptographic audit remain downstream work.
