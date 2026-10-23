import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { LOGO_DATA_URI } from "./oauth-loopback-logo.ts";

export type CallbackResult =
  | { status: "code"; code: string }
  | { status: "denied" | "timeout" | "cancelled" | "port-in-use" | "failed" };

// UI v2 Charcoal (ADR 0008). Dark only, system fonts, inline logo: the page makes no requests.
const STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}html,body{height:100%}body{margin:0;padding:16px;display:grid;place-items:center;background:#1e1e1e;color:#f3f3f3;font:14px/20px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}main{width:100%;max-width:400px;padding:32px 24px;background:#252525;border:1px solid #383838;border-radius:12px;text-align:center}.logo{display:block;width:64px;height:64px;margin:0 auto 24px}h1{display:flex;align-items:center;justify-content:center;gap:8px;margin:0 0 8px;font-size:20px;line-height:28px;font-weight:600}h1 svg{flex:none}.ok{color:#22c55e}.warn{color:#f59e0b}.muted{color:#a3a3a3}p{margin:0;color:#a3a3a3}button{width:100%;height:36px;margin-top:24px;border:0;border-radius:8px;background:#2563eb;color:#fff;font:inherit;font-weight:500;cursor:pointer}button:hover{background:#3b74ee}button:active{background:#1c4bb3}button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}button[hidden]{display:none}.hint{margin-top:12px;font-size:13px;line-height:18px}@media (prefers-reduced-motion:no-preference){button{transition:background-color 120ms}}`;
// Browsers let scripts close only windows they opened; when the tab survives, say how to close it.
const SCRIPT = `const b=document.getElementById("close"),h=document.getElementById("hint");b.hidden=false;b.addEventListener("click",()=>{window.close();setTimeout(()=>{h.textContent="Your browser kept this tab open \\u2014 close it with \\u2318W and return to ssterm."},300)});`;
const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const CALLBACK_CSP = `default-src 'none'; img-src data:; style-src ${hash(STYLE)}; script-src ${hash(SCRIPT)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const ICONS = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  warn: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.5h.01"/>',
  muted: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.2M12 17h.01"/>',
} as const;

/** Constant content only: nothing from the request is ever interpolated. */
const PAGE = (tone: keyof typeof ICONS, title: string, text: string, closable: boolean) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} \u00b7 ssterm</title><style>${STYLE}</style></head><body><main>` +
  `<img class="logo" src="${LOGO_DATA_URI}" width="64" height="64" alt="ssterm">` +
  `<h1><svg class="${tone}" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[tone]}</svg>${title}</h1><p>${text}</p>` +
  (closable
    ? `<button id="close" type="button" hidden>Close this window</button><p class="hint" id="hint" aria-live="polite">You can close this tab with \u2318W and return to ssterm.</p><script>${SCRIPT}</script>`
    : "") +
  `</main></body></html>`;

const NOT_FOUND = PAGE("muted", "Not found", "This address is used only by ssterm sign-in.", false);
const NOT_COMPLETED = PAGE("warn", "Sign-in was not completed", "Google did not finish signing you in. Return to ssterm to try again.", true);
const SIGNED_IN = PAGE("ok", "Signed in", "Google sign-in finished. Return to ssterm to continue.", true);

function send(response: ServerResponse, status: number, page: string) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": CALLBACK_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  }).end(page);
}

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
      // URL.parse, not new URL: a malformed absolute-form request line must answer 404, not throw in main.
      const url = URL.parse(request.url ?? "/", `http://127.0.0.1:${options.port}`);
      // Host must be the literal loopback address (DNS-rebinding hardening on top of the 256-bit state).
      const hostOk = request.headers.host === `127.0.0.1:${options.port}`;
      if (settled || !url || !hostOk || request.method !== "GET" || url.pathname !== options.path || url.searchParams.get("state") !== options.state) {
        send(response, 404, NOT_FOUND);
        return;
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code || code.length > 2048) {
        send(response, 200, NOT_COMPLETED);
        finish({ status: "denied" }, response);
        return;
      }
      send(response, 200, SIGNED_IN);
      finish({ status: "code", code }, response);
    });
    const timer = setTimeout(() => finish({ status: "timeout" }), options.timeoutMs);
    const abort = () => finish({ status: "cancelled" });
    /** Single use: stops listening at once; the page being sent is allowed to flush before its connection is dropped. */
    function finish(result: CallbackResult, response?: ServerResponse) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      server.close();
      if (response && !response.writableFinished) {
        response.once("close", () => server.closeAllConnections?.());
        setTimeout(() => server.closeAllConnections?.(), 1_000).unref(); // a client that never reads cannot hold it open
      } else server.closeAllConnections?.();
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
