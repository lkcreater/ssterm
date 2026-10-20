#!/usr/bin/env python3
"""Isolated SST-038 protocol probe, never imported by the application.

Run only in the owned, disposable Docker image. Session keys, lab private keys,
and raw terminal output remain transient inside that container; the sole output
is a content-free receipt. No ports, mounts, or user credentials are needed.
"""

import errno
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import signal
import socket
import struct
import subprocess
import tempfile
import threading
import time
import uuid


class ProbeFailure(Exception):
    pass


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, timeout=15, **kwargs)


def require(value, code):
    if not value:
        raise ProbeFailure(code)


class Relay:
    """Loopback UDP relay with controllable loss and NAT source-port changes."""

    def __init__(self, port):
        self.port = port
        self.front = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.front.bind(("127.0.0.2", port))
        self.back = self.backend()
        self.client = None
        self.drop = False
        self.stopped = False
        self.error = None
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.pump, daemon=True)
        self.thread.start()

    @staticmethod
    def backend():
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("127.0.0.1", 0))
        return sock

    def rebind(self):
        with self.lock:
            old = self.back
            self.back = self.backend()  # Old socket stays bound until replacement is allocated.
            changed = old.getsockname()[1] != self.back.getsockname()[1]
            old.close()
            return changed

    def pump(self):
        try:
            while not self.stopped:
                with self.lock:
                    readable, _, _ = select.select([self.front, self.back], [], [], 0.05)
                    for sock in readable:
                        packet, peer = sock.recvfrom(65536)
                        if sock is self.front:
                            self.client = peer
                            if not self.drop:
                                self.back.sendto(packet, ("127.0.0.1", self.port))
                        elif not self.drop and self.client:
                            self.front.sendto(packet, self.client)
                time.sleep(0.001)
        except Exception:
            self.error = "relay-failed"

    def close(self):
        self.stopped = True
        self.thread.join(2)
        require(not self.thread.is_alive(), "relay-cleanup-timeout")
        self.front.close()
        self.back.close()
        require(self.error is None, self.error)


class Terminal:
    def __init__(self, port, key):
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, 0x5414, struct.pack("HHHH", 24, 80, 0, 0))
        env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TERM": "xterm-256color", "MOSH_KEY": key}
        self.process = subprocess.Popen(
            ["mosh-client", "127.0.0.2", str(port)], stdin=slave, stdout=slave, stderr=slave,
            env=env, start_new_session=True,
        )
        os.close(slave)
        os.set_blocking(self.fd, False)
        self.output = bytearray()

    def collect(self, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            readable, _, _ = select.select([self.fd], [], [], min(0.1, end - time.monotonic()))
            if readable:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                if not chunk:
                    return
                self.output.extend(chunk)
                require(len(self.output) <= 2 * 1024 * 1024, "terminal-output-budget")

    def wait(self, marker, timeout=20):
        end = time.monotonic() + timeout
        while marker not in self.output and time.monotonic() < end:
            self.collect(0.1)
        require(marker in self.output, "terminal-marker-timeout")

    def send(self, command):
        os.write(self.fd, command.encode("utf-8") + b"\r")

    def print_marker(self, marker, prefix=""):
        # The requested marker must not occur in the echoed command itself.
        encoded = "".join("\\%03o" % byte for byte in marker)
        self.send(prefix + "printf '" + encoded + "\\n'")

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(3)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(3)
        os.close(self.fd)
        self.output[:] = b"\0" * len(self.output)
        self.output.clear()


def start_server(ssh, port):
    # Native mosh-server forks after returning MOSH CONNECT. Never forward its raw output.
    result = run(ssh + ["fixture@127.0.0.1", "env", "TERM=xterm-256color", "mosh-server", "new", "-s", "-p", str(port), "-l", "LANG=C.UTF-8",
                        "--", "/bin/bash", "--noprofile", "--norc"])
    match = re.search(rb"MOSH CONNECT (\d+) ([A-Za-z0-9+/=]+)", result.stdout)
    require(match is not None and int(match[1]) == port, "bootstrap-format")
    return match[2].decode("ascii")


def main():
    receipt = {"probe": "SST-038-native-mosh", "platform": "owned-linux-docker", "checks": {}}
    terminals, relays = [], []
    sshd = None
    failed = None
    phase = "setup"
    try:
        receipt["moshVersion"] = run(["mosh-client", "--version"]).stdout.decode().splitlines()[0]
        receipt["packageVersions"] = run(["dpkg-query", "-W", "-f=${Package}=${Version}\n", "mosh", "openssh-client", "openssh-server"]).stdout.decode().splitlines()
        receipt["executableSha256"] = {}
        for executable in ["mosh-client", "mosh-server"]:
            with open("/usr/bin/" + executable, "rb") as source:
                receipt["executableSha256"][executable] = hashlib.sha256(source.read()).hexdigest()
        with tempfile.TemporaryDirectory(prefix="ssterm-mosh-") as folder:
            os.chmod(folder, 0o755)  # sshd's unprivileged account needs directory traversal.
            key = folder + "/client"
            host = folder + "/host"
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key])
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", host])
            with open(key + ".pub") as source, open(folder + "/authorized", "w") as target:
                target.write(source.read())
            os.chmod(folder + "/authorized", 0o644)
            # Unlock the fixture-only account; password authentication stays disabled.
            run(["usermod", "-p", "*", "fixture"])
            with open(host + ".pub") as source, open(folder + "/known_hosts", "w") as target:
                target.write("[127.0.0.1]:2222 " + source.read())
            config = folder + "/sshd_config"
            with open(config, "w") as target:
                target.write("\n".join([
                    "Port 2222", "ListenAddress 127.0.0.1", "HostKey " + host,
                    "PidFile " + folder + "/sshd.pid", "AuthorizedKeysFile " + folder + "/authorized",
                    "AllowUsers fixture", "PubkeyAuthentication yes", "PasswordAuthentication no",
                    "KbdInteractiveAuthentication no", "UsePAM no", "StrictModes no",
                    "AllowTcpForwarding no", "AllowAgentForwarding no", "X11Forwarding no",
                    "LogLevel QUIET", "PrintMotd no", "PrintLastLog no", "",
                ]))
            sshd = subprocess.Popen(["/usr/sbin/sshd", "-D", "-f", config], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 5
            while True:
                try:
                    with socket.create_connection(("127.0.0.1", 2222), timeout=0.2):
                        break
                except OSError:
                    require(time.monotonic() < deadline, "sshd-start-timeout")
                    time.sleep(0.05)
            ssh = ["ssh", "-F", "/dev/null", "-p", "2222", "-i", key, "-o", "IdentitiesOnly=yes",
                   "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + folder + "/known_hosts",
                   "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3"]
            wrong = folder + "/wrong_hosts"
            with open(key + ".pub") as source, open(wrong, "w") as target:
                target.write("[127.0.0.1]:2222 " + source.read())
            wrong_ssh = ["UserKnownHostsFile=" + wrong if part.startswith("UserKnownHostsFile=") else part for part in ssh]
            rejected = subprocess.run(wrong_ssh + ["fixture@127.0.0.1", "true"],
                                      capture_output=True, timeout=5)
            require(rejected.returncode != 0, "changed-host-key-accepted")
            receipt["checks"]["changedHostKeyRejected"] = True
            empty = folder + "/empty_hosts"
            with open(empty, "w"):
                pass
            unknown_ssh = ["UserKnownHostsFile=" + empty if part.startswith("UserKnownHostsFile=") else part for part in ssh]
            rejected = subprocess.run(unknown_ssh + ["fixture@127.0.0.1", "true"], capture_output=True, timeout=5)
            require(rejected.returncode != 0, "unknown-host-key-accepted")
            receipt["checks"]["unknownHostKeyRejected"] = True
            bad_key = folder + "/bad-client"
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", bad_key])
            bad_auth_ssh = [bad_key if part == key else part for part in ssh]
            rejected = subprocess.run(bad_auth_ssh + ["fixture@127.0.0.1", "true"], capture_output=True, timeout=5)
            require(rejected.returncode != 0, "unauthorized-client-key-accepted")
            receipt["checks"]["unauthorizedClientKeyRejected"] = True
            phase = "positive-ssh-auth"
            require(run(ssh + ["fixture@127.0.0.1", "printf", "ssterm-owned-auth-ok"]).stdout == b"ssterm-owned-auth-ok", "ssh-positive-auth-marker")
            receipt["checks"]["authorizedClientKeyAccepted"] = True

            relay = Relay(60001)
            relays.append(relay)
            phase = "native-bootstrap"
            session_key = start_server(ssh, 60001)
            phase = "pty-client"
            terminal = Terminal(60001, session_key)
            del session_key
            terminals.append(terminal)
            terminal.collect(1)
            marker = uuid.uuid4().hex.encode()
            terminal.print_marker(marker, "stty -echo; __ssterm_pid=$$; __ssterm_token=" + uuid.uuid4().hex + "; ")
            terminal.wait(marker)
            receipt["checks"]["strictSshBootstrapAndNativePty"] = True

            unicode_marker = ("ไทย λ 漢字 " + uuid.uuid4().hex).encode()
            terminal.print_marker(unicode_marker)
            terminal.wait(unicode_marker)
            receipt["checks"]["unicodeOutputUtf8"] = True

            fcntl.ioctl(terminal.fd, 0x5414, struct.pack("HHHH", 37, 101, 0, 0))
            os.kill(terminal.process.pid, signal.SIGWINCH)
            terminal.collect(0.5)
            marker = uuid.uuid4().hex.encode()
            terminal.print_marker(marker, "[ \"$(stty size)\" = '37 101' ] && ")
            terminal.wait(marker)
            receipt["checks"]["remotePtyResize"] = True

            relay.drop = True
            marker = uuid.uuid4().hex.encode()
            terminal.print_marker(marker, '[ "$__ssterm_pid" = "$$" ] && [ -n "$__ssterm_token" ] && ')
            terminal.collect(3)
            require(marker not in terminal.output, "udp-drop-did-not-block")
            relay.drop = False
            terminal.wait(marker)
            receipt["checks"]["udpLossRecoverySameShell"] = True

            require(relay.rebind(), "relay-source-port-unchanged")
            marker = uuid.uuid4().hex.encode()
            terminal.print_marker(marker, '[ "$__ssterm_pid" = "$$" ] && [ -n "$__ssterm_token" ] && ')
            terminal.wait(marker)
            receipt["checks"]["udpSourcePortRebindingSameShell"] = True

            blocked = Relay(60002)
            blocked.drop = True
            relays.append(blocked)
            session_key = start_server(ssh, 60002)
            pending = Terminal(60002, session_key)
            del session_key
            terminals.append(pending)
            pending.collect(3)
            require(pending.process.poll() is None, "blocked-client-exited-early")
            started = time.monotonic()
            pending.close()
            terminals.remove(pending)
            require(time.monotonic() - started < 4, "blocked-cancel-timeout")
            receipt["checks"]["blockedUdpStartupBoundedClientCancellation"] = True
    except ProbeFailure as error:
        failed = str(error)
    except subprocess.CalledProcessError as error:
        failed = phase + "-exit-" + str(error.returncode)
        # Whitelisted diagnostic categories only; never persist native messages.
        for needle, code in [(b"Permission denied", "permission"), (b"locale", "locale"),
                             (b"TERM", "term"), (b"setrlimit", "rlimit"), (b"Usage:", "usage")]:
            if needle in error.stderr:
                receipt["diagnostic"] = code
                break
    except subprocess.TimeoutExpired:
        failed = phase + "-timeout"
    except Exception:
        failed = phase + "-infrastructure-failure"
    finally:
        try:
            cleanup_failed = False
            for resource in terminals + relays:
                try:
                    resource.close()
                except Exception:
                    cleanup_failed = True
            # The disposable lab owns all these processes. Cancellation does not
            # imply Mosh remotely kills its server: cleanup is deliberately explicit.
            subprocess.run(["pkill", "-TERM", "-u", "fixture", "-x", "mosh-server"], capture_output=True, timeout=5)
            if sshd:
                sshd.terminate()
                sshd.wait(3)
            # This harness is container PID 1 and must reap adopted daemon children.
            reap_deadline = time.monotonic() + 3
            while time.monotonic() < reap_deadline:
                try:
                    while os.waitpid(-1, os.WNOHANG)[0]:
                        pass
                except ChildProcessError:
                    break
                time.sleep(0.05)
            remaining = subprocess.run(["pgrep", "-a", "-u", "fixture", "mosh-server|bash"], capture_output=True, timeout=5)
            require(remaining.returncode == 1, "server-cleanup-incomplete")
            require(not cleanup_failed, "terminal-or-relay-cleanup-failed")
            receipt["checks"]["ownedProcessesCleaned"] = True
        except Exception:
            failed = failed or "cleanup-failed"
    receipt["ok"] = failed is None
    if failed:
        receipt["failure"] = failed
    print(json.dumps(receipt, sort_keys=True), flush=True)
    return 0 if failed is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
