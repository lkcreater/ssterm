# SST-038 native Mosh capability lab

This is an isolated investigation, not an application transport or a production
Mosh integration. Requires Docker, Python 3 and initial package/image network
access. From the repository root:

```sh
docker build -t ssterm-mosh-fixture:sst-038 tests/fixtures/mosh
python3 tests/fixtures/mosh/run.py
```

The runner creates one UUID-labeled container with `--network none`, no published
ports and no mounts. All SSH and UDP communication is on its internal loopback.
It generates disposable SSH host/client keys, preinstalls the lab's known host,
rejects unknown/changed host keys and an unauthorized client key, then bootstraps
the real `mosh-server` over OpenSSH. The server's session key travels only in
captured bootstrap memory and the client environment inside that container.
Neither terminal output nor session keys are included in logs or receipts.

The real `mosh-client` uses a PTY and an owned UDP relay. The probe checks Unicode
output, remote PTY resize, recovery after a three-second UDP blackhole, and a
relay source-port change. A shell PID and private shell variable must survive
recovery. Test markers are octal-encoded in commands, so command echo cannot
satisfy output assertions. A second session starts with UDP blocked and verifies
bounded local client cancellation. The probe explicitly stops native servers;
local client cancellation does not establish remote server cleanup semantics.

The host runner bounds the lab to 110 seconds and removes only its own validated
container ID after checking the ownership label, including on failure. The
container separately closes all clients/relays and stops/reaps fixture servers.
The only receipt is sanitized JSON containing image identity/architecture,
package versions, executable SHA-256 values, booleans and fixed failure codes.

This Linux container does not verify a macOS packaged adapter, application IPC,
renderer/xterm integration, real network roaming, native IME, physical hardware,
SFTP, port forwarding, or a production distribution/license bundle. Rebuilding
the floating Debian/package inputs can change the image; retain the receipt's
identity when citing a run. No app dependency or runtime behavior is changed.

## Observed run — 2026-10-20

The final native run exited 0: all 11 probe checks passed and the runner verified
removal of its owned container. The sanitized receipt is [receipt.json](receipt.json).
The image was Linux arm64, ID
`sha256:d8e2160a35474d2fe5a0968e0431c227c4e3adc50c5687295eb7c76ffd5c9839`,
with Mosh `1.4.0-1+b1` and OpenSSH `1:9.2p1-2+deb12u10`. The receipt records both
native executable hashes. Remote resize was 37 rows × 101 columns; UDP loss lasted
three seconds. A different relay source port then recovered the same shell.

The first Docker build spent 133.6 seconds resolving the base metadata, then
completed successfully; it did not require a fallback image. Two initial native
runs failed before establishing the terminal: the first had a generic failure
code and the second isolated `native-bootstrap-exit-1`. Both reported all three
negative trust/auth checks and cleanup successful. The corrected bootstrap sets
`TERM=xterm-256color` and uses native `mosh-server new -s`; it also includes a
separate positive SSH authorization check. Only the final corrected run is
evidence for Mosh capability. Initial failures are not counted as passes.

The runner ownership regression gate passed 4/4 without Docker access:

```sh
PYTHONPYCACHEPREFIX=/private/tmp/ssterm-mosh-pycache python3 -m unittest discover -s tests/fixtures/mosh -p 'test_*.py'
```

Those tests reject removal after a failed create/name collision, mismatched
ownership and an invalid create-returned identity, and verify successful cleanup
uses only the validated owned container ID.
