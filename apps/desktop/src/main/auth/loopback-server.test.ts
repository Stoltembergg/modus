import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { LOOPBACK_HOST, startLoopbackListener } from "./loopback-server";

function get(port: number, path: string, host = `${LOOPBACK_HOST}:${port}`) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: LOOPBACK_HOST, port, path, headers: { host }, agent: false },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("loopback OAuth listener", () => {
  it("binds to 127.0.0.1 on an ephemeral port", async () => {
    const listener = await startLoopbackListener({ timeoutMs: 5_000 });
    try {
      expect(listener.address().address).toBe("127.0.0.1");
      expect(listener.address().family).toBe("IPv4");
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.callbackUrl).toBe(`http://127.0.0.1:${listener.port}/auth/callback`);
    } finally {
      await listener.close();
    }
  });

  it("hands over the first callback, never echoes the code, then stops listening", async () => {
    const listener = await startLoopbackListener({ timeoutMs: 5_000 });
    const response = await get(listener.port, "/auth/callback?code=SECRET-CODE&state=abc");
    expect(response.status).toBe(200);
    expect(response.body).not.toContain("SECRET-CODE");
    const { params } = await listener.callback;
    expect(params.get("code")).toBe("SECRET-CODE");
    expect(params.get("state")).toBe("abc");
    // Closed by itself (no close() call): later requests cannot even connect.
    await vi.waitFor(() =>
      expect(get(listener.port, "/auth/callback?code=again&state=abc")).rejects.toMatchObject({
        code: "ECONNREFUSED",
      }),
    );
  });

  it("ignores other paths and foreign Host headers without consuming the callback", async () => {
    const listener = await startLoopbackListener({ timeoutMs: 5_000 });
    try {
      expect((await get(listener.port, "/favicon.ico")).status).toBe(404);
      expect(
        (await get(listener.port, "/auth/callback?code=x&state=y", "evil.example:80")).status,
      ).toBe(404);
      expect((await get(listener.port, "/auth/callback?code=ok&state=s")).status).toBe(200);
      expect((await listener.callback).params.get("code")).toBe("ok");
    } finally {
      await listener.close();
    }
  });

  it("rejects and closes on timeout", async () => {
    const listener = await startLoopbackListener({ timeoutMs: 20 });
    await expect(listener.callback).rejects.toThrow(/timed out/);
    await listener.close();
    await expect(get(listener.port, "/auth/callback")).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });
});
