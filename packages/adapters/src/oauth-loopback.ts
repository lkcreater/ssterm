import { createServer, type Server } from "node:http";

export type CallbackResult =
  | { status: "code"; code: string }
  | { status: "denied" | "timeout" | "cancelled" | "port-in-use" | "failed" };

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,system-ui;background:#0b1220;color:#e6edf7;display:grid;place-items:center;height:100vh;margin:0"><div><h1 style="font-size:20px">${title}</h1><p>${text}</p></div>`;

/**
 * One OAuth redirect on 127.0.0.1 only: resolves with the code for the matching `state`, ignores other requests,
 * and always closes the listener (on success, denial, timeout or abort). The page never echoes parameters.
 */
export function waitForOAuthCallback(options: {
  port: number;
  path: string;
  state: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called once listening, before the browser is opened. */
  listening?: () => void;
}): Promise<CallbackResult> {
  return new Promise((resolve) => {
    let settled = false;
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${options.port}`);
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "text/html; charset=utf-8");
      // Host must be the literal loopback address (DNS-rebinding hardening on top of the 256-bit state).
      const hostOk = request.headers.host === `127.0.0.1:${options.port}`;
      if (!hostOk || request.method !== "GET" || url.pathname !== options.path || url.searchParams.get("state") !== options.state) {
        response.writeHead(404).end(PAGE("Not found", "This address is used only by ssterm sign-in."));
        return;
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code || code.length > 2048) {
        response.writeHead(200).end(PAGE("Sign-in was not completed", "You can close this tab and return to ssterm."));
        finish({ status: "denied" });
        return;
      }
      response.writeHead(200).end(PAGE("Signed in", "You can close this tab and return to ssterm."));
      finish({ status: "code", code });
    });
    const timer = setTimeout(() => finish({ status: "timeout" }), options.timeoutMs);
    const abort = () => finish({ status: "cancelled" });
    function finish(result: CallbackResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      server.closeAllConnections?.();
      server.close();
      resolve(result);
    }
    if (options.signal?.aborted) return finish({ status: "cancelled" });
    options.signal?.addEventListener("abort", abort, { once: true });
    server.once("error", (error: NodeJS.ErrnoException) => finish({ status: error.code === "EADDRINUSE" || error.code === "EACCES" ? "port-in-use" : "failed" }));
    server.listen({ host: "127.0.0.1", port: options.port, exclusive: true }, () => {
      if (settled) return void server.close();
      try { options.listening?.(); } catch { finish({ status: "failed" }); }
    });
  });
}
