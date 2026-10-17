import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import ssh2, { type Connection, type SFTPWrapper } from "ssh2";
import type { ResolvedHostConfig, SecretProvider, SftpFailure, SftpResult, SftpSession } from "../../packages/domain/src/index.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import { channelGone, createSftpChannel, remotePath, SFTP_MAX_ENTRIES, SFTP_MAX_READ } from "../../packages/adapters/src/sftp.ts";
import { ed25519 } from "./ssh-keys.ts";
import { createSavedHostSshAdapter, KnownHostPolicy, SessionRegistry, TransientSecrets, type SessionSnapshot } from "../../packages/services/src/index.ts";

const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp;
const password = Buffer.from("owned-fixture-password");
const hostKey = Buffer.from(ed25519().private);
const otherHostKey = Buffer.from(ed25519().private);
const HOME = "/home/fixture";
const SERVER_TEXT = "SECRET-SERVER-TEXT /etc/shadow";
const owner = "fixture-owner";

type Reply = () => void;
/** Owned in-memory SFTP server state; tests reshape it before or during a session. */
interface Remote {
  files: Map<string, Buffer>;
  /** Directory path → its names (generated on demand for very large listings). */
  dirs: Map<string, () => string[]>;
  statusFor: Map<string, number>;
  /** Request types whose replies are held until released. */
  hold: Set<string>;
  held: Reply[];
  closes: string[];
  channels: SFTPWrapper[];
  requests: { type: string; path?: string; flags?: number; mode?: number }[];
  refuse?: "channel" | "subsystem";
  holdSubsystem?: boolean;
  releaseSubsystem?: Reply;
  realpathStatus?: number;
  fstatMode?: number;
}
function remote(): Remote {
  return {
    files: new Map([[`${HOME}/hello.txt`, Buffer.from("hello world")]]),
    dirs: new Map([[HOME, () => ["hello.txt"]]]),
    statusFor: new Map(), hold: new Set(), held: [], closes: [], channels: [], requests: [],
  };
}
const fileAttrs = (size: number) => ({ mode: 0o100644, size, uid: 0, gid: 0, atime: 1, mtime: 1_700_000_000 });
const dirAttrs = { mode: 0o040755, size: 4096, uid: 0, gid: 0, atime: 1, mtime: 1_700_000_000 };

function serve(sftp: SFTPWrapper, state: Remote) {
  state.channels.push(sftp);
  const handles = new Map<string, { path: string; dir?: string[]; at?: number }>();
  let next = 0;
  const reply = (type: string, send: Reply) => { if (state.hold.has(type)) state.held.push(send); else send(); };
  const failed = (id: number, path: string) => {
    const code = state.statusFor.get(path);
    if (code === undefined) return false;
    sftp.status(id, code, SERVER_TEXT);
    return true;
  };
  sftp.on("REALPATH", (id: number, path: string) => {
    state.requests.push({ type: "REALPATH", path });
    reply("REALPATH", () => {
      if (path === "." && state.realpathStatus !== undefined) { sftp.status(id, state.realpathStatus, SERVER_TEXT); return; }
      sftp.name(id, [{ filename: path === "." ? HOME : path, longname: "", attrs: {} as never }]);
    });
  });
  for (const type of ["STAT", "LSTAT"] as const)
    sftp.on(type, (id: number, path: string) => {
      state.requests.push({ type, path });
      reply(type, () => {
        if (failed(id, path)) return;
        const file = state.files.get(path);
        if (file) sftp.attrs(id, fileAttrs(file.length));
        else if (state.dirs.has(path)) sftp.attrs(id, dirAttrs);
        else sftp.status(id, STATUS_CODE.NO_SUCH_FILE, SERVER_TEXT);
      });
    });
  sftp.on("OPENDIR", (id: number, path: string) => {
    state.requests.push({ type: "OPENDIR", path });
    reply("OPENDIR", () => {
      if (failed(id, path)) return;
      const names = state.dirs.get(path);
      if (!names) { sftp.status(id, STATUS_CODE.NO_SUCH_FILE, SERVER_TEXT); return; }
      const handle = `d${++next}`;
      handles.set(handle, { path, dir: [".", "..", ...names()] });
      sftp.handle(id, Buffer.from(handle));
    });
  });
  sftp.on("READDIR", (id: number, handle: Buffer) => {
    state.requests.push({ type: "READDIR" });
    reply("READDIR", () => {
      const open = handles.get(handle.toString());
      if (!open?.dir) { sftp.status(id, STATUS_CODE.FAILURE); return; }
      const batch = open.dir.splice(0, 100);
      if (!batch.length) { sftp.status(id, STATUS_CODE.EOF); return; }
      sftp.name(id, batch.map((filename) => ({ filename, longname: "", attrs: fileAttrs(1) })));
    });
  });
  sftp.on("OPEN", (id: number, path: string, flags: number, attrs: { mode?: number }) => {
    state.requests.push({ type: "OPEN", path, flags, mode: attrs?.mode });
    reply("OPEN", () => {
      if (failed(id, path)) return;
      const exists = state.files.has(path);
      if (flags & OPEN_MODE.WRITE) {
        if (exists && flags & OPEN_MODE.EXCL) { sftp.status(id, STATUS_CODE.FAILURE, SERVER_TEXT); return; }
        state.files.set(path, Buffer.alloc(0));
      } else if (!exists) { sftp.status(id, STATUS_CODE.NO_SUCH_FILE, SERVER_TEXT); return; }
      const handle = `h${++next}`;
      handles.set(handle, { path });
      sftp.handle(id, Buffer.from(handle));
    });
  });
  sftp.on("FSTAT", (id: number, handle: Buffer) => {
    state.requests.push({ type: "FSTAT" });
    reply("FSTAT", () => {
      const data = state.files.get(handles.get(handle.toString())?.path ?? "");
      if (data) sftp.attrs(id, { ...fileAttrs(data.length), mode: state.fstatMode ?? fileAttrs(data.length).mode });
      else sftp.status(id, STATUS_CODE.FAILURE);
    });
  });
  sftp.on("READ", (id: number, handle: Buffer, offset: number, length: number) => {
    state.requests.push({ type: "READ" });
    reply("READ", () => {
      const data = state.files.get(handles.get(handle.toString())?.path ?? "");
      if (!data) { sftp.status(id, STATUS_CODE.FAILURE); return; }
      if (offset >= data.length) { sftp.status(id, STATUS_CODE.EOF); return; }
      sftp.data(id, data.subarray(offset, offset + length));
    });
  });
  sftp.on("WRITE", (id: number, handle: Buffer, offset: number, data: Buffer) => {
    state.requests.push({ type: "WRITE" });
    reply("WRITE", () => {
      const path = handles.get(handle.toString())?.path ?? "";
      const current = state.files.get(path) ?? Buffer.alloc(0);
      const grown = Buffer.alloc(Math.max(current.length, offset + data.length));
      current.copy(grown); data.copy(grown, offset);
      state.files.set(path, grown);
      sftp.status(id, STATUS_CODE.OK);
    });
  });
  sftp.on("CLOSE", (id: number, handle: Buffer) => {
    state.closes.push(handle.toString());
    handles.delete(handle.toString());
    reply("CLOSE", () => sftp.status(id, STATUS_CODE.OK));
  });
}

function config(port: number, passwordRef: string | null = "fixture-password-ref"): ResolvedHostConfig {
  const entity = { vaultId: "fixture-vault", revision: 1, createdAt: "fixture", updatedAt: "fixture" };
  return {
    hostRef: { id: "fixture-host", revision: 1, label: "Owned SFTP", groupId: null },
    address: "127.0.0.1", port: { value: port, source: { kind: "default" } }, environment: "DEV",
    auth: { selection: "identity", source: { kind: "default" }, key: null, identity: {
      ...entity, id: "fixture-identity", label: "Owned identity", username: "fixture",
      method: "password", passwordRef, keyId: null,
    } }, ancestry: [], catalogRevision: 1,
  };
}
async function until(check: () => boolean, message = "Expected owned SFTP fixture state within 5 seconds"): Promise<void> {
  const limit = Date.now() + 5_000;
  while (!check() && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(check(), message);
}
/** Resolves `hung` when an operation has not settled within the bound: the ssh2 hang trap. */
const settled = <T>(promise: Promise<T>, ms = 1_000) =>
  Promise.race([promise, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms))]);
const code = (result: SftpResult<unknown> | "hung") => result === "hung" ? "hung" : result.ok ? "ok" : result.code;
function must<T>(result: SftpResult<T>): T {
  if (!result.ok) assert.fail(`unexpected ${result.code}`);
  return result.value;
}

async function listen(state: Remote, key: Buffer, clients: Connection[], methods: string[], port = 0) {
  const server = new ssh2.Server({ hostKeys: [key], ident: "OpenSSH_9.2p1" });
  server.on("connection", (client) => {
    clients.push(client);
    client.on("error", () => {});
    client.on("authentication", (auth) => {
      methods.push(auth.method);
      if (auth.method === "password" && Buffer.from(auth.password).equals(password)) auth.accept();
      else auth.reject(["password"]);
    });
    client.on("ready", () => client.on("session", (accept, reject) => {
      if (state.refuse === "channel") { reject(); return; }
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty?.());
      session.on("shell", (acceptShell) => { acceptShell(); });
      session.on("sftp", (acceptSftp, rejectSftp) => {
        if (state.refuse === "subsystem") { rejectSftp(); return; }
        const start = () => serve(acceptSftp(), state);
        if (state.holdSubsystem) state.releaseSubsystem = start; else start();
      });
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, port: address.port };
}

async function fixture(t: TestContext, options: { passwordRef?: string | null } = {}) {
  const dir = mkdtempSync("/private/tmp/ssterm-sftp-");
  const opened = await openMetadata({ path: join(dir, "metadata.db") });
  assert(opened.ok);
  const repository = opened.value;
  const policy = new KnownHostPolicy({ repository });
  const state = remote();
  const clients: Connection[] = [];
  const methods: string[] = [];
  let { server, port } = await listen(state, hostKey, clients, methods);
  const resolved = config(port, options.passwordRef === undefined ? "fixture-password-ref" : options.passwordRef);
  const provider: SecretProvider = {
    async read() { return { status: "present", value: Buffer.from(password) }; },
    async lookup() { return { status: "missing" }; },
    async write() { return { status: "confirmed" }; },
    async delete() { return { status: "missing" }; },
  };
  const registry = new SessionRegistry({
    resolve: () => ({ ok: true, value: resolved }),
    transient: new TransientSecrets(), adapter: createSavedHostSshAdapter({ provider, policy }),
    limits: { connectMs: 10_000 },
  });
  t.after(async () => {
    await registry.dispose();
    for (const client of clients) client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    policy.dispose(); repository.close(); rmSync(dir, { recursive: true, force: true });
  });
  const find = (id: string) => registry.snapshot(owner, id)[0]!;
  const f = {
    state, registry, clients, methods, policy,
    find,
    async connect(kind: "terminal" | "sftp" = "sftp"): Promise<SessionSnapshot> {
      const result = registry.connect(owner, "fixture-host", kind);
      assert(result.ok);
      await until(() => !!find(result.value.id).prompt || find(result.value.id).state === "Failed");
      return find(result.value.id);
    },
    trust(id: string, decision: "accept-once" | "remember" | "replace" | "reject" = "accept-once") {
      const snapshot = find(id);
      assert(snapshot.prompt?.kind === "host-trust");
      assert(registry.answerPrompt(owner, id, snapshot.generation, snapshot.prompt.id, { kind: "host-trust", decision }).ok);
    },
    /** A trusted, Ready SFTP session and its fenced capability. */
    async open(): Promise<{ id: string; generation: number; sftp: SftpSession }> {
      const snapshot = await f.connect();
      f.trust(snapshot.id);
      await until(() => find(snapshot.id).state === "Ready");
      const sftp = registry.sftp(owner, snapshot.id, snapshot.generation);
      assert(sftp);
      return { id: snapshot.id, generation: snapshot.generation, sftp };
    },
    /** Replaces the server on the same endpoint with a different host key. */
    async rekeyServer() {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ({ server, port } = await listen(state, otherHostKey, clients, methods, port));
    },
  };
  return f;
}

test("a refused subsystem is subsystem-unavailable and a refused channel is channel-open-failed", async (t) => {
  for (const [refuse, expected] of [["subsystem", "subsystem-unavailable"], ["channel", "channel-open-failed"]] as const) {
    const f = await fixture(t);
    f.state.refuse = refuse;
    const snapshot = await f.connect();
    f.trust(snapshot.id);
    await until(() => f.find(snapshot.id).state === "Failed" && f.find(snapshot.id).cleanup === "complete");
    assert.equal(f.find(snapshot.id).error?.code, expected);
    assert.equal(f.registry.sftp(owner, snapshot.id, 1), undefined);
  }
});

test("Ready waits for the negotiated subsystem and the resolved home; a refused home falls back to /", async (t) => {
  const f = await fixture(t);
  f.state.holdSubsystem = true;
  f.state.hold.add("REALPATH");
  const snapshot = await f.connect();
  assert.equal(snapshot.kind, "sftp");
  f.trust(snapshot.id);
  await until(() => f.state.releaseSubsystem !== undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.find(snapshot.id).state, "Authenticating");
  f.state.releaseSubsystem!();
  await until(() => f.state.held.length === 1);
  assert.equal(f.find(snapshot.id).state, "Authenticating", "VERSION alone is not Ready");
  assert.equal(f.registry.sftp(owner, snapshot.id, 1), undefined);
  f.state.hold.clear();
  f.state.held.shift()!();
  await until(() => f.find(snapshot.id).state === "Ready");
  assert.equal(f.registry.sftp(owner, snapshot.id, 1)?.home, HOME);
  assert.deepEqual(f.state.requests[0], { type: "REALPATH", path: "." });

  const other = await fixture(t);
  other.state.realpathStatus = STATUS_CODE.PERMISSION_DENIED;
  const opened = await other.open();
  assert.equal(opened.sftp.home, "/");
});

test("status codes map to finite failures without server text", async (t) => {
  const f = await fixture(t);
  const { sftp } = await f.open();
  const expected: [number, SftpFailure][] = [
    [STATUS_CODE.NO_SUCH_FILE, "not-found"], [STATUS_CODE.PERMISSION_DENIED, "permission-denied"], [STATUS_CODE.FAILURE, "failure"],
    [STATUS_CODE.BAD_MESSAGE, "invalid-path"], [STATUS_CODE.OP_UNSUPPORTED, "unsupported"], [STATUS_CODE.NO_CONNECTION, "connection-lost"],
    [STATUS_CODE.CONNECTION_LOST, "connection-lost"], [STATUS_CODE.EOF, "failure"],
  ];
  const results: unknown[] = [];
  for (const [status, failure] of expected) {
    const path = `${HOME}/status-${status}`;
    f.state.statusFor.set(path, status);
    for (const result of [await sftp.stat(path), await sftp.lstat(path), await sftp.list(path), await sftp.openRead(path), await sftp.openWrite(path, { mode: 0o600 })]) {
      assert.deepEqual(result, { ok: false, code: failure }, `${status}`);
      results.push(result);
    }
  }
  assert.deepEqual(await sftp.stat(`${HOME}/missing`), { ok: false, code: "not-found" });
  assert(!JSON.stringify(results).includes("SECRET"));
});

test("paths are absolute, lexically normalized, bounded and well formed before any request", async (t) => {
  const f = await fixture(t);
  const { sftp } = await f.open();
  const before = f.state.requests.length;
  for (const path of ["relative.txt", "", `${HOME}/a\0b`, `/${"a".repeat(4096)}`, `${HOME}/\uD800`, 42 as unknown as string]) {
    assert.equal(code(await sftp.stat(path)), "invalid-request", JSON.stringify(path));
    assert.equal(code(await sftp.list(path)), "invalid-request");
    assert.equal(code(await sftp.openRead(path)), "invalid-request");
  }
  assert.equal(f.state.requests.length, before, "invalid paths never reach the server");
  assert.equal(remotePath(`/${"a".repeat(4095)}`), `/${"a".repeat(4095)}`);
  assert.equal(remotePath(`/${"ก".repeat(1366)}`), undefined, "the bound counts UTF-8 bytes");
  must(await sftp.stat(`//home///fixture/./x/../hello.txt/`));
  assert.deepEqual(f.state.requests.at(-1), { type: "STAT", path: `${HOME}/hello.txt` });
  assert.equal(must(await sftp.realpath(`${HOME}/x/..`)), HOME);
  assert.deepEqual(must(await sftp.stat(HOME)), { type: "directory", size: 4096, mtime: 1_700_000_000, permissions: 0o755 });
  assert.equal(code(await sftp.openWrite(`${HOME}/x`, { mode: 0o10000 })), "invalid-request");
});

test("listing drops dot entries, skips unsafe names, counts them and flags lossy names unaddressable", async (t) => {
  const f = await fixture(t);
  const { sftp } = await f.open();
  const long = "n".repeat(1_024);
  f.state.dirs.set(`${HOME}/hostile`, () => ["../escape", "a/b", "", "nul\0name", "n".repeat(1_025), "ไทย😀.txt", "\u202Etxt.exe", "\uD800lone", "\uFFFDreplacement", long, "ok.txt"]);
  const listing = must(await sftp.list(`${HOME}/hostile`));
  assert.equal(listing.skipped, 5);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.entries.map(({ name, addressable }) => [name, addressable]), [
    ["ไทย😀.txt", true], ["\u202Etxt.exe", true], ["\uFFFDlone", false], ["\uFFFDreplacement", false], [long, true], ["ok.txt", true],
  ]);
  assert.deepEqual(listing.entries.at(-1), { name: "ok.txt", addressable: true, type: "file", size: 1, mtime: 1_700_000_000, permissions: 0o644 });
  assert.deepEqual(f.state.closes, ["d1"]);
});

test("a 25,000-entry listing stops at 10,000 with the directory handle closed; exactly 10,000 is complete", async (t) => {
  const f = await fixture(t);
  const { sftp } = await f.open();
  const names = (count: number, prefix = "f") => () => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  f.state.dirs.set(`${HOME}/big`, names(25_000));
  f.state.dirs.set(`${HOME}/exact`, names(SFTP_MAX_ENTRIES));
  f.state.dirs.set(`${HOME}/unsafe`, () => Array<string>(25_000).fill(""));
  const big = must(await sftp.list(`${HOME}/big`));
  assert.equal(big.entries.length, SFTP_MAX_ENTRIES);
  assert.equal(big.truncated, true);
  assert.equal(f.state.closes.length, 1, "the handle is closed before the listing resolves");
  const exact = must(await sftp.list(`${HOME}/exact`));
  assert.equal(exact.entries.length, SFTP_MAX_ENTRIES);
  assert.equal(exact.truncated, false);
  const unsafe = must(await sftp.list(`${HOME}/unsafe`));
  assert.deepEqual([unsafe.entries.length, unsafe.skipped, unsafe.truncated], [0, SFTP_MAX_ENTRIES, true], "skipped names count toward the cap");
  assert.equal(f.state.closes.length, 3);
});

test("reads return owned bytes, short reads and null at EOF; exclusive create writes and confirms close", async (t) => {
  const f = await fixture(t);
  const { sftp } = await f.open();
  const reader = must(await sftp.openRead(`${HOME}/hello.txt`));
  assert.equal(Buffer.from(must(await reader.read(0, 5))!).toString(), "hello");
  assert.equal(Buffer.from(must(await reader.read(5, 100))!).toString(), " world");
  assert.equal(must(await reader.read(11, 10)), null);
  for (const [position, length] of [[0, 0], [-1, 1], [0.5, 1], [0, 262_145], [0, 260_097]])
    assert.equal(code(await reader.read(position!, length!)), "invalid-request", `${position}, ${length}`);
  const closing = reader.close();
  assert.equal(reader.close(), closing, "close is idempotent");
  must(await closing);
  assert.equal(code(await reader.read(0, 1)), "closed");
  assert.equal(f.state.closes.length, 1);

  assert.equal(code(await sftp.openWrite(`${HOME}/hello.txt`, { mode: 0o600 })), "failure", "an existing destination is never replaced");
  assert.equal(f.state.files.get(`${HOME}/hello.txt`)!.toString(), "hello world");
  const writer = must(await sftp.openWrite(`${HOME}/new.bin`, { mode: 0o640 }));
  const open = f.state.requests.at(-1)!;
  assert.equal(open.flags! & (OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.EXCL), OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.EXCL);
  assert.equal(open.mode, 0o640);
  const bytes = new Uint8Array([1, 2, 3]);
  must(await writer.write(0, bytes));
  must(await writer.write(3, new Uint8Array([4])));
  assert.equal(code(await writer.write(0, new Uint8Array(0))), "invalid-request");
  assert.equal(code(await writer.write(0, new Uint8Array(260_097))), "invalid-request");
  must(await writer.close());
  assert.equal(code(await writer.write(0, bytes)), "closed");
  assert.deepEqual([...f.state.files.get(`${HOME}/new.bin`)!], [1, 2, 3, 4]);
});

test("post-open handle attributes reject replaced special files and wait for their close", async (t) => {
  const f = await fixture(t);
  const { sftp } = await f.open();
  f.state.fstatMode = 0o010600;
  f.state.hold.add("CLOSE");
  const opened = sftp.openRead(`${HOME}/hello.txt`);
  await until(() => f.state.held.length === 1);
  assert.equal(await settled(opened, 20), "hung", "refusal must retain its permit until CLOSE settles");
  assert.equal(f.state.requests.filter((r) => r.type === "READ").length, 0);
  f.state.hold.clear(); f.state.held.shift()!();
  assert.equal(code(await opened), "not-file");
  f.state.fstatMode = 0o100644;
  must(await must(await sftp.openRead(`${HOME}/hello.txt`)).close());
});

test("open handles are capped at 32 per session and a closed handle frees its slot", async (t) => {
  const f = await fixture(t);
  const { sftp } = await f.open();
  const readers = [];
  for (let index = 0; index < 32; index++) readers.push(must(await sftp.openRead(`${HOME}/hello.txt`)));
  const opens = f.state.requests.filter((request) => request.type === "OPEN").length;
  assert.equal(code(await sftp.openRead(`${HOME}/hello.txt`)), "resource-limit");
  assert.equal(code(await sftp.list(HOME)), "resource-limit");
  assert.equal(f.state.requests.filter((request) => request.type === "OPEN").length, opens, "a refusal sends nothing");
  must(await readers[0]!.close());
  must(await sftp.list(HOME));
  must(await sftp.openRead(`${HOME}/hello.txt`));
});

test("in-flight bounds refuse past 64 requests or 2 MiB without queueing, while CLOSE stays available", async (t) => {
  const f = await fixture(t);
  const { sftp } = await f.open();
  const release = () => { f.state.hold.clear(); for (const send of f.state.held.splice(0)) send(); };
  const reader = must(await sftp.openRead(`${HOME}/hello.txt`));
  f.state.hold.add("READ");
  const reads = Array.from({ length: 64 }, () => reader.read(0, 1));
  assert.equal(code(await reader.read(0, 1)), "resource-limit");
  assert.equal(code(await sftp.stat(HOME)), "resource-limit");
  await until(() => f.state.held.length === 64);
  assert.equal(f.state.requests.filter((request) => request.type === "STAT").length, 0, "a refusal sends nothing");
  must(await reader.close());
  release();
  for (const result of await Promise.all(reads)) assert.notEqual(code(result), "resource-limit");

  const big = must(await sftp.openRead(`${HOME}/hello.txt`));
  f.state.hold.add("READ");
  const large = Array.from({ length: 8 }, () => big.read(0, 260_096));
  assert.equal(code(await big.read(0, 260_096)), "resource-limit", "a ninth maximum read would pass 2 MiB");
  const last = big.read(0, 2_097_152 - 8 * 260_096);
  assert.equal(code(await big.read(0, 1)), "resource-limit");
  await until(() => f.state.held.length === 9);
  release();
  for (const result of await Promise.all([...large, last])) assert.equal(code(result), "ok");
  must(await big.read(0, 1));
});

test("cancellation resolves at once and a handle that arrives later is closed", async (t) => {
  const f = await fixture(t);
  const { sftp } = await f.open();
  f.state.hold.add("OPEN");
  const controller = new AbortController();
  const opening = sftp.openRead(`${HOME}/hello.txt`, controller.signal);
  await until(() => f.state.held.length === 1);
  controller.abort();
  assert.equal(code(await settled(opening, 50)), "cancelled");
  f.state.hold.clear();
  f.state.held.shift()!();
  await until(() => f.state.closes.length === 1, "the late handle must be closed");
  assert.equal(code(await sftp.openRead(`${HOME}/hello.txt`, controller.signal)), "cancelled", "an aborted signal sends nothing");

  // The late handle's slot is released once closed: all 32 slots are available again.
  for (let index = 0; index < 32; index++) must(await sftp.openRead(`${HOME}/hello.txt`));

  const { sftp: second } = await f.open();
  f.state.hold.add("READDIR");
  const listing = new AbortController();
  const listed = second.list(HOME, listing.signal);
  await until(() => f.state.held.length === 1);
  listing.abort();
  assert.equal(code(await settled(listed, 50)), "cancelled");
  await until(() => f.state.closes.length === 2, "a cancelled listing still closes its directory handle");

  f.state.hold.clear();
  for (const send of f.state.held.splice(0)) send();
  f.state.hold.add("CLOSE");
  const closing = new AbortController();
  const complete = second.list(HOME, closing.signal);
  await until(() => f.state.held.length === 1);
  closing.abort();
  assert.equal(code(await settled(complete, 50)), "cancelled", "waiting for the final CLOSE honours cancellation");
  f.state.held.shift()!();
});

test("after close every operation resolves closed at once instead of hanging in ssh2", async (t) => {
  const f = await fixture(t);
  const { id, sftp } = await f.open();
  const reader = must(await sftp.openRead(`${HOME}/hello.txt`));
  const writer = must(await sftp.openWrite(`${HOME}/out.bin`, { mode: 0o600 }));
  await f.registry.close(owner, id);
  assert.equal(f.find(id).cleanup, "complete");
  assert.equal(f.registry.sftp(owner, id, 1), undefined);
  for (const operation of <Promise<SftpResult<unknown>>[]>[
    sftp.realpath(HOME), sftp.stat(HOME), sftp.lstat(HOME), sftp.list(HOME), sftp.openRead(`${HOME}/hello.txt`),
    sftp.openWrite(`${HOME}/x`, { mode: 0o600 }), reader.read(0, 1), writer.write(0, new Uint8Array([1])), reader.close(), writer.close(),
  ]) assert.equal(code(await settled(operation)), "closed");
});

test("close, lock and connection loss resolve in-flight operations and complete cleanup", async (t) => {
  for (const end of ["close", "lock", "lost", "subsystem"] as const) {
    const f = await fixture(t);
    const { id, sftp } = await f.open();
    const reader = must(await sftp.openRead(`${HOME}/hello.txt`));
    f.state.hold.add("STAT");
    f.state.hold.add("READ");
    const stat = sftp.stat(HOME);
    const read = reader.read(0, 1);
    await until(() => f.state.held.length === 2);
    if (end === "close") await f.registry.close(owner, id);
    else if (end === "lock") await f.registry.lock();
    else if (end === "lost") f.clients[0]!.end();
    else f.state.channels[0]!.end();
    const remote = end === "lost" || end === "subsystem";
    const expected = remote ? "connection-lost" : "closed";
    assert.equal(code(await settled(stat)), expected, end);
    assert.equal(code(await settled(read)), expected, end);
    assert.equal(code(await settled(reader.read(0, 1))), expected, end);
    await until(() => f.find(id).cleanup === "complete");
    assert.equal(f.find(id).state, remote ? "Failed" : "Closed");
    if (remote) assert.equal(f.find(id).error?.code, "network");
  }
});

test("reconnect keeps the SFTP kind; closing SFTP leaves a terminal on the same host Ready", async (t) => {
  const f = await fixture(t);
  const terminal = await f.connect("terminal");
  f.trust(terminal.id);
  await until(() => f.find(terminal.id).state === "Ready");
  assert.equal(f.find(terminal.id).kind, "terminal");
  const first = await f.open();
  assert.equal(f.registry.terminal(owner, first.id, 1), undefined, "an SFTP session is not a terminal");
  assert.equal(f.registry.sftp(owner, terminal.id, 1), undefined, "a terminal session is not SFTP");
  assert.equal(f.registry.sftp("other-owner", first.id, 1), undefined);
  await f.registry.close(owner, first.id);
  assert.equal(f.find(terminal.id).state, "Ready");
  assert(f.registry.terminal(owner, terminal.id, 1));

  const next = f.registry.reconnect(owner, first.id, 1);
  assert(next.ok);
  assert.equal(next.value.kind, "sftp");
  await until(() => !!f.find(first.id).prompt);
  f.trust(first.id);
  await until(() => f.find(first.id).state === "Ready");
  assert.equal(f.registry.sftp(owner, first.id, 1), undefined, "the old generation is fenced");
  const fresh = f.registry.sftp(owner, first.id, 2);
  assert(fresh && fresh !== first.sftp);
  must(await fresh.stat(HOME));
  assert.equal(code(await first.sftp.stat(HOME)), "closed");
});

test("SFTP uses the shared trust and credential path: unknown prompts, remembered reused, changed blocks before auth", async (t) => {
  const f = await fixture(t);
  const first = await f.connect();
  assert.equal(first.prompt?.kind === "host-trust" && first.prompt.status, "unknown");
  assert.deepEqual(f.methods, [], "no authentication before trust");
  f.trust(first.id, "remember");
  await until(() => f.find(first.id).state === "Ready");
  await f.registry.close(owner, first.id);

  const remembered = f.registry.connect(owner, "fixture-host", "sftp");
  assert(remembered.ok);
  await until(() => f.find(remembered.value.id).state === "Ready");
  assert.equal(f.find(remembered.value.id).prompt, undefined);
  await f.registry.close(owner, remembered.value.id);

  await f.rekeyServer();
  f.methods.length = 0;
  const changed = await f.connect();
  assert(changed.prompt?.kind === "host-trust" && changed.prompt.status === "changed");
  f.trust(changed.id, "reject");
  await until(() => f.find(changed.id).state === "Failed");
  assert.equal(f.find(changed.id).error?.code, "host-key-changed");
  assert.deepEqual(f.methods, [], "a changed key blocks before authentication");

  const prompted = await fixture(t, { passwordRef: null });
  const snapshot = await prompted.connect();
  prompted.trust(snapshot.id);
  await until(() => prompted.find(snapshot.id).state === "AwaitingInput");
  const prompt = prompted.find(snapshot.id).prompt;
  assert(prompt?.kind === "credentials" && prompt.purpose === "password");
  const value = Buffer.from(password);
  assert(prompted.registry.answerPrompt(owner, snapshot.id, 1, prompt.id, { kind: "credentials", values: [{ id: "password", value }] }).ok);
  value.fill(0);
  await until(() => prompted.find(snapshot.id).state === "Ready");
  assert.deepEqual(prompted.methods, ["password"]);
});

/** Server-side ssh2 internals: OpenSSH's internal-sftp sends CHANNEL_EOF before CHANNEL_CLOSE on exit. */
function remoteEof(channel: SFTPWrapper, close: boolean) {
  const raw = channel as unknown as { _protocol: { channelEOF(id: number): void; channelClose(id: number): void }; outgoing: { id: number } };
  raw._protocol.channelEOF(raw.outgoing.id);
  if (close) raw._protocol.channelClose(raw.outgoing.id);
}

test("a remote EOF, with or without CLOSE, resolves in-flight operations connection-lost and fails the session", async (t) => {
  for (const close of [true, false]) {
    const f = await fixture(t);
    const { id, sftp } = await f.open();
    const reader = must(await sftp.openRead(`${HOME}/hello.txt`));
    f.state.hold.add("STAT");
    f.state.hold.add("READ");
    const stat = sftp.stat(HOME);
    const read = reader.read(0, 1);
    await until(() => f.state.held.length === 2);
    remoteEof(f.state.channels[0]!, close);
    assert.equal(code(await settled(stat)), "connection-lost", `close: ${close}`);
    assert.equal(code(await settled(read)), "connection-lost", `close: ${close}`);
    assert.equal(code(await settled(sftp.stat(HOME))), "connection-lost", `close: ${close}`);
    await until(() => f.find(id).state === "Failed" && f.find(id).cleanup === "complete");
    assert.equal(f.find(id).error?.code, "network");
  }
});

test("a remote EOF before the home resolves fails subsystem-unavailable instead of Ready at /", async (t) => {
  const f = await fixture(t);
  f.state.hold.add("REALPATH");
  const snapshot = await f.connect();
  f.trust(snapshot.id);
  await until(() => f.state.held.length === 1);
  remoteEof(f.state.channels[0]!, false);
  await until(() => f.find(snapshot.id).state === "Failed" && f.find(snapshot.id).cleanup === "complete");
  assert.equal(f.find(snapshot.id).error?.code, "subsystem-unavailable");
  assert.equal(f.registry.sftp(owner, snapshot.id, 1), undefined);
});

test("a maximum-size read fits ssh2's inbound packet limit; malformed negotiated limits fall back to 32 KiB", async (t) => {
  const state = remote();
  state.files.set(`${HOME}/big.bin`, Buffer.alloc(SFTP_MAX_READ + 4_096, 7));
  const { server, port } = await listen(state, hostKey, [], []);
  const client = new ssh2.Client();
  t.after(async () => {
    client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    client.once("ready", resolve).once("error", reject);
    client.connect({ host: "127.0.0.1", port, username: "fixture", password: password.toString(), hostVerifier: () => true });
  });
  const raw = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
  const internals = raw as unknown as { _maxReadLen: unknown; _maxWriteLen: unknown; maxOpenHandles: unknown };
  const negotiated = { ...internals };
  // As if limits@openssh.com advertised 4 MiB: the read bound must still stay under ssh2's packet limit.
  internals._maxReadLen = 4 * 1_048_576;
  const wide = createSftpChannel(raw, HOME);
  const reader = must(await wide.openRead(`${HOME}/big.bin`));
  assert.equal(must(await reader.read(0, SFTP_MAX_READ))!.byteLength, SFTP_MAX_READ);
  assert.equal(code(await reader.read(0, SFTP_MAX_READ + 1)), "invalid-request");

  Object.assign(internals, { _maxReadLen: Number.NaN, _maxWriteLen: undefined, maxOpenHandles: -1 });
  const fallback = createSftpChannel(raw, HOME);
  Object.assign(internals, negotiated);
  const small = must(await fallback.openRead(`${HOME}/big.bin`));
  assert.equal(must(await small.read(0, 32_768))!.byteLength, 32_768);
  assert.equal(code(await small.read(0, 32_769)), "invalid-request");
  const writer = must(await fallback.openWrite(`${HOME}/out.bin`, { mode: 0o600 }));
  must(await writer.write(0, new Uint8Array(32_768)));
  assert.equal(code(await writer.write(0, new Uint8Array(32_769))), "invalid-request");
  assert.equal(channelGone({} as SFTPWrapper), true, "missing channel state counts as gone");
  wide.dispose();
});

test("publication uses standard exclusive rename or the exact negotiated OpenSSH replacement capability", async () => {
  for (const extension of [undefined, "0", 1, Buffer.from("1"), "1"]) {
    const raw = new EventEmitter() as EventEmitter & Record<string, any>;
    raw.incoming = { state: "open" }; raw.outgoing = { state: "open" };
    raw._extensions = { "posix-rename@openssh.com": extension };
    const calls: { kind: string; source: string; destination: string }[] = [];
    raw.rename = (source: string, destination: string, callback: (error?: Error) => void) => { calls.push({ kind: "rename", source, destination }); callback(); };
    raw.ext_openssh_rename = (source: string, destination: string, callback: (error?: Error) => void) => { calls.push({ kind: "replace", source, destination }); callback(); };
    raw.unlink = () => assert.fail("replacement must never fall back to deleting the destination");
    raw.end = () => raw.emit("close");
    const channel = createSftpChannel(raw as unknown as SFTPWrapper, HOME);
    assert.equal(channel.atomicReplace, extension === "1");
    assert.deepEqual(await channel.publish!(`${HOME}/.ssterm-owned.part`, `${HOME}/final`, { replace: false }), { ok: true, value: { retainedPartial: false } });
    assert.equal(calls[0]!.kind, "rename");
    const replace = await channel.publish!(`${HOME}/.ssterm-owned.part`, `${HOME}/final`, { replace: true });
    assert.equal(code(replace), extension === "1" ? "ok" : "unsupported");
    assert.equal(calls.length, extension === "1" ? 2 : 1);
    if (extension === "1") assert.equal(calls[1]!.kind, "replace");
    assert.equal(code(await channel.publish!(`${HOME}/.part`, "/other/final", { replace: false })), "invalid-request");
    assert.equal(code(await channel.publish!(`${HOME}/.part`, `${HOME}/.part`, { replace: true })), "invalid-request");
    channel.dispose();
  }
});

test("remote publication maps v3 generic failures without claiming quota detail and preserves no-delete policy", async () => {
  const raw = new EventEmitter() as EventEmitter & Record<string, any>;
  raw.incoming = { state: "open" }; raw.outgoing = { state: "open" };
  raw._extensions = { "posix-rename@openssh.com": "1" };
  let status = 4;
  const operation = (_source: string, _destination: string, callback: (error: Error & { code: number }) => void) => callback(Object.assign(new Error(SERVER_TEXT), { code: status }));
  raw.rename = operation; raw.ext_openssh_rename = operation;
  raw.unlink = () => assert.fail("never remove the original"); raw.end = () => raw.emit("close");
  const channel = createSftpChannel(raw as unknown as SFTPWrapper, HOME);
  for (const [remoteStatus, expected] of [[4, "failure"], [3, "permission-denied"], [2, "not-found"], [7, "connection-lost"]] as const) {
    status = remoteStatus;
    assert.deepEqual(await channel.publish!(`${HOME}/.part`, `${HOME}/final`, { replace: true }), { ok: false, code: expected });
  }
  channel.dispose();
});
