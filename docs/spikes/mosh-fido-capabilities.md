# SST-038 — Mosh / FIDO capability investigation

Date: 2026-10-20. Decision: [ADR 0007](../adr/0007-mosh-and-security-key-capability-gates.md). This is an isolated capability investigation, not application support.

## Evidence boundaries

| Category | Evidence / conclusion |
|---|---|
| Existing ssterm behavior | SSH terminals use ssh2; no Mosh transport or FIDO signer is implemented in `apps/` or `packages/` |
| Upstream Mosh claim | [Mosh documentation](https://mosh.org/) describes SSH bootstrap followed by UDP, intermittent connectivity, roaming and predictive local echo |
| Owned runtime observation | Recorded below only after the fixture actually runs; not inferred from upstream claims |
| FIDO upstream capability | OpenSSH [ssh-keygen](https://man.openbsd.org/ssh-keygen.1) documents security-key types and presence/verification options |
| FIDO local observation | No hardware is available in this scope; PIN/touch/cancel and provider support are untested |
| Proprietary evidence | [Native boundary](../termius/native-boundary.md) contains bounded static observations; no new proprietary runtime/native investigation is performed |

## Lab design and limits

Use only freshly generated lab SSH keys and owned Docker resources. A private known-hosts file is populated from the owned server's generated host public key via the fixture's administrative setup, not unauthenticated network scanning. SSH bootstrap must enforce strict host verification. Parse the Mosh server's connection line transiently; never save it or its session key. A native client runs under a real Linux PTY and sends UDP through a fixture relay. Suppressing packets simulates an outage; changing the relay's upstream socket simulates source-port rebinding. This does not establish physical Wi-Fi roaming, host sleep/wake, changed IP, WAN NAT behavior or macOS native compatibility.

Checks must use remote responses, not local prediction or command echo. Retaining a remote shell identifier across recovery distinguishes reconnection to the same shell from a fresh bootstrap. Output capture is bounded and kept in memory; receipts contain only allowlisted verdicts and nonsecret artifact identity. Container removal is also the final boundary for a remote process that does not exit cooperatively.

## Runtime evidence

The owned native probe passed all **11 checks** on Linux arm64 in Docker. An independent repeat is recorded in the [delivery](../agent-runs/sst-038-delivery.md). Run instructions and a sanitized reference receipt are in [the fixture](../../tests/fixtures/mosh/README.md).

| Check | Observed result |
|---|---|
| Unknown / changed SSH host key | Both rejected under strict checking |
| Unauthorized client key | Rejected; separate positive SSH authentication passed |
| SSH bootstrap + native PTY client | Remote marker returned; bootstrap required `TERM=xterm-256color` and native `new -s` |
| UTF-8 | Thai, Greek and CJK output marker returned; no claim about IME or renderer correctness |
| Resize | Remote `stty size` became 37 rows × 101 columns |
| UDP loss | 3-second bidirectional blackhole withheld marker; restoring packets delivered it from the same remote shell |
| Source-port change | Replacing relay upstream socket retained the same remote shell |
| Blocked UDP startup | Native client remained pending and was explicitly cancelled within the fixture bound |
| Cleanup | Native client/server/shell cleaned; exact owned container removed |

Identity: `sha256:d8e2160a35474d2fe5a0968e0431c227c4e3adc50c5687295eb7c76ffd5c9839` (`linux/arm64`); Debian Mosh `1.4.0-1+b1`, OpenSSH `1:9.2p1-2+deb12u10`. The receipt records executable SHA-256 hashes and package versions. These identify this run; floating base/package updates can produce a different image.

Initial Docker probe failed because the daemon was stopped; opening Docker Desktop with approval restored access. The first image build stalled at registry metadata, then succeeded without a blind retry. First runtime failed before bootstrap completion; a second diagnostic run isolated `native-bootstrap-exit-1`. Adding the terminal environment and native wrapper bootstrap option resolved the failure; positive SSH authentication was added to distinguish auth failure from server startup. These unsuccessful runs are not counted as passes.

Cancellation of a Mosh client does not prove the remote server exits. This lab explicitly terminates owned server processes and then removes its container. Missing-server handling, real IP migration, sleep/wake, adverse WAN/NAT behavior, renderer integration and app lifecycle remain unverified.

## Capability matrix

| Capability | SST-038 scope / limit |
|---|---|
| SSH-authenticated Mosh bootstrap | Owned fixture gate; no production adapter |
| UDP outage/recovery / source-port migration | Owned relay gate; broader network roaming unverified |
| Unicode and PTY resize | Linux terminal protocol gate; renderer/Thai IME unverified |
| Mosh over SSH jump / HTTP CONNECT / SOCKS5 | Unsupported/unverified; TCP bootstrap routes do not supply UDP reachability |
| SFTP / forwarding | Remain independent SSH capabilities; Mosh terminal success proves neither |
| macOS arm64 packaging / signing / license distribution | Not implemented or verified |
| Linux/Windows desktop Mosh support | Not implemented or verified |
| FIDO PIN / touch / cancel / resident credentials | ADR only; all hardware/provider runtime cases untested |
| Termius native API / protocol compatibility | Unknown; not a reconstruction target |

The future production gates and FIDO hardware matrix are defined in ADR 0007. Existing manual release checks and Developer ID/notarization remain pending.
