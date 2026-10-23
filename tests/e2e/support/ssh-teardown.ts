import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, type Desktop } from "../fixtures";

const runFile = promisify(execFile);

/** Host processes (other than Docker's port proxy) holding an ESTABLISHED TCP connection to the fixture's port. */
async function clientConnections(host: string, port: number) {
  try {
    const { stdout } = await runFile("lsof", ["-nP", `-iTCP@${host}:${port}`, "-sTCP:ESTABLISHED", "-Fpc"]);
    const rows: string[] = [];
    let pid = "";
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      else if (line.startsWith("c") && !/docker|vpnkit|gvproxy/iu.test(line)) rows.push(`${line.slice(1)} (${pid})`);
    }
    return rows;
  } catch (error) {
    // lsof exits 1 both when nothing matches and on some errors: only a silent exit 1 means "none".
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 1 && !failure.stderr?.trim()) return [];
    throw error;
  }
}

/**
 * Quits the app and proves its SSH sessions to an owned fixture ended. ssh2 runs in main, so its client sockets close
 * when main exits; the fixture's sshd children exit only once Docker Desktop's port proxy relays that close, which can
 * lag under load (the fixture sets no ClientAliveInterval). So the check is split: a quit that fell back to SIGKILL is
 * a soft failure (and an annotation); no surviving host process (a helper or orphan, not main) may still hold a
 * connection to the fixture; and the server side then gets a longer, clearly labelled wait for the proxy relay.
 */
export async function closeAndExpectNoSsh(
  desktop: Desktop,
  lab: { host: string; port: number },
  serverSessions: () => Promise<number>,
  serverTimeout = 60_000,
) {
  await desktop.close();
  const forced = desktop.forcedKill();
  if (forced) test.info().annotations.push({ type: "teardown", description: "the app did not quit within 5 s and was killed with SIGKILL" });
  expect.soft(forced, "the app quit by itself within 5 s (no SIGKILL fallback)").toBe(false);
  expect(await clientConnections(lab.host, lab.port), "no surviving process still holds a connection to the fixture").toEqual([]);
  await expect.poll(serverSessions, {
    timeout: serverTimeout,
    message: `no fixture sshd session survives app quit (client side already closed; waiting on the Docker port proxy${forced ? "; quit fell back to SIGKILL" : ""})`,
  }).toBe(0);
}
