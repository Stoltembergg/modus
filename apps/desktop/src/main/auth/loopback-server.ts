import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The only interface the listener binds to (never 0.0.0.0, never "localhost" → ::1 ambiguity). */
export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_CALLBACK_PATH = "/auth/callback";

export type LoopbackCallback = {
  /** Query parameters of the first request to the callback path (code, state, error…). */
  params: URLSearchParams;
};

export type LoopbackListener = {
  port: number;
  /** http://127.0.0.1:<port>/auth/callback */
  callbackUrl: string;
  /** Resolves on the first callback request, rejects on timeout or close(). */
  callback: Promise<LoopbackCallback>;
  close(): Promise<void>;
  /** For tests and diagnostics: the address actually bound. */
  address(): AddressInfo;
};

type Options = {
  timeoutMs: number;
  /** Ephemeral (0) by default; GoTrue accepts any port on a loopback IP literal (RFC 8252 §7.3). */
  port?: number;
};

const DONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Modus</title></head><body style="font-family:system-ui;padding:3rem;text-align:center"><h1>You can close this tab</h1><p>Return to Modus to continue.</p></body></html>`;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/**
 * Single-use OAuth callback listener on 127.0.0.1. It closes itself after the first request to
 * the callback path (valid or not), on timeout, or on close(). The page never echoes the code.
 */
export async function startLoopbackListener({
  timeoutMs,
  port = 0,
}: Options): Promise<LoopbackListener> {
  const server: Server = createServer();
  let settled = false;
  let resolveCallback!: (value: LoopbackCallback) => void;
  let rejectCallback!: (reason: Error) => void;
  const callback = new Promise<LoopbackCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // Callers may close() without awaiting the callback; never leave an unhandled rejection.
  callback.catch(() => undefined);

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (!closing) {
      clearTimeout(timer);
      closing = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    if (!settled) {
      settled = true;
      rejectCallback(new Error("The sign-in listener was closed."));
    }
    return closing;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address() as AddressInfo;
  const callbackUrl = `http://${LOOPBACK_HOST}:${bound.port}${LOOPBACK_CALLBACK_PATH}`;

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCallback(new Error("The sign-in timed out."));
    }
    void close();
  }, timeoutMs);
  timer.unref?.();

  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}:${bound.port}`);
    } catch {
      response.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    // Host check blocks DNS-rebinding pages from driving the listener.
    const hostOk = request.headers.host === `${LOOPBACK_HOST}:${bound.port}`;
    if (request.method !== "GET" || url.pathname !== LOOPBACK_CALLBACK_PATH || !hostOk) {
      response.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
    response.end(DONE_PAGE);
    if (!settled) {
      settled = true;
      resolveCallback({ params: url.searchParams });
    }
    void close();
  });

  return {
    port: bound.port,
    callbackUrl,
    callback,
    close,
    address: () => bound,
  };
}
