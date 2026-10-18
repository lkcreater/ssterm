"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { startTerminalFixture } = require("../terminal/ssh.cjs");
const { startFixture } = require("../../../spikes/ssh-compat/src/fixture.cjs");
const run = promisify(execFile);
const ROOT = "/home/fixture/remote-edit-ไทย";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function startRemoteEditFixture(production, options) {
  let lab, terminal, edits, sftp;
  const documents = [];
  let launches = 0, mode = "replace", current;
  const directory = fs.mkdtempSync(path.join(options.tempDirectory, "ssterm-remote-edit-runtime-"));
  const root = path.join(directory, "remote-edit-temp");
  const python = async (script) => {
    try { return (await run("docker", ["exec", "-u", "fixture", lab.container, "python3", "-c", script], { timeout: 30_000 })).stdout.trim(); }
    catch { throw new Error("REMOTE_EDIT_FIXTURE_DOCKER_FAILED"); }
  };
  const cleanup = async () => {
    await edits?.dispose(); sftp?.dispose();
    const receipt = await terminal?.cleanup();
    if (lab) { lab.privateKey.fill(0); await lab.dispose(); await lab.assertCleaned(); }
    fs.rmSync(directory, { recursive: true, force: true });
    return { ...receipt, labCleaned: true };
  };
  try {
    lab = await startFixture();
    await python(`import os\nr=${JSON.stringify(ROOT)}\nos.mkdir(r)\nfor n in ['แก้ไข-🚀.txt','second.txt','third.txt']: open(r+'/'+n,'w').write('original-owned-text\\n')\nopen(r+'/binary.bin','wb').write(b'not\\x00text')`);
    terminal = await startTerminalFixture(production, { ...options, lab });
    const files = production.createRemoteEditFiles({ root });
    const trackedFiles = { ...files, async create(signal) {
      const result = await files.create(signal);
      if (result.ok) documents.push(result.value.documentPath);
      return result;
    } };
    const editor = production.createRemoteEditEditor({ launch: async (binary, args, launchOptions) => {
      if (binary !== "/usr/bin/open" || args.length !== 2 || args[0] !== "-e") throw new Error("UNSAFE_EDITOR_ARGUMENTS");
      launches++;
      await run(options.nodeBinary, [path.join(__dirname, "editor.cjs"), args[1], mode], launchOptions);
    } });
    const service = production.createRemoteEditService({ files: trackedFiles, editor });
    edits = production.createRemoteEditController({ registry: terminal.registry, service, onLock: terminal.runtime.onLock });
    sftp = production.createSftpController({ registry: terminal.registry, local: production.createLocalFiles(directory), checkAccess: async () => true });
    edits.register(options.owner, options.send); sftp.register(options.owner, options.send);
    return {
      edits, sftp,
      connect() {
        const result = terminal.registry.connect(terminal.ownerId, terminal.hostId, "sftp");
        if (!result.ok) throw new Error("REMOTE_EDIT_FIXTURE_CONNECT_FAILED");
        current = result.value; return this.status();
      },
      status() { const item = current && terminal.registry.snapshot(terminal.ownerId, current.id)[0]; return item ? { id: item.id, generation: item.generation, state: item.state, cleanup: item.cleanup } : null; },
      async disconnect() { await terminal.registry.close(terminal.ownerId, current.id, current.generation); return this.status(); },
      reconnect() { const result = terminal.registry.reconnect(terminal.ownerId, current.id); if (!result.ok) throw new Error("REMOTE_EDIT_FIXTURE_RECONNECT_FAILED"); current = result.value; return this.status(); },
      async lock() { options.power.emit("lock-screen"); await new Promise((done) => setImmediate(done)); return this.status(); },
      setMode(value) { if (!["append", "replace"].includes(value)) throw new Error("INVALID_MODE"); mode = value; },
      async save(index = 0) { await run(options.nodeBinary, [path.join(__dirname, "editor.cjs"), documents[index], "append"], { timeout: 10_000 }); },
      launches: () => launches,
      localInfo() {
        // Native cleanup can unlink between stat/read calls even while this synchronous receipt runs.
        const live = documents.flatMap((document) => {
          try { return [{ mode: fs.statSync(document).mode & 0o777, directoryMode: fs.statSync(path.dirname(document)).mode & 0o777, hash: hash(fs.readFileSync(document)) }]; }
          catch (error) { if (error.code === "ENOENT") return []; throw error; }
        });
        return { copies: live.length, rootMode: fs.existsSync(root) ? fs.statSync(root).mode & 0o777 : null,
          documents: live,
          entries: fs.existsSync(root) ? fs.readdirSync(root).length : 0, pending: edits.pendingCount() };
      },
      async remoteInfo(name) { return JSON.parse(await python(`import os,hashlib,json\np=${JSON.stringify(ROOT)}+'/'+${JSON.stringify(name)}\ns=os.stat(p)\nprint(json.dumps({'hash':hashlib.file_digest(open(p,'rb'),'sha256').hexdigest(),'size':s.st_size,'mtime':s.st_mtime_ns,'mode':s.st_mode&0o777}))`)); },
      async mutateSameMetadata(name) { return python(`import os\np=${JSON.stringify(ROOT)}+'/'+${JSON.stringify(name)}\ns=os.stat(p)\nf=open(p,'r+b');f.write(b'X');f.close()\nos.utime(p,ns=(s.st_atime_ns,s.st_mtime_ns))`); },
      async handles() { return Number(await python(`import glob,os\nn=0\nfor p in glob.glob('/proc/[0-9]*/fd/*'):\n try:\n  if os.readlink(p).startswith(${JSON.stringify(ROOT + "/")}): n+=1\n except OSError: pass\nprint(n)`)); },
      cleanup,
    };
  } catch { await cleanup().catch(() => undefined); throw new Error("REMOTE_EDIT_FIXTURE_START_FAILED"); }
}
module.exports = { startRemoteEditFixture };
