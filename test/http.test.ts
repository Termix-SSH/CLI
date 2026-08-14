import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { TermixClient } from "../src/core/http.js";
import { TermixApiError, TermixConnectionError } from "../src/core/errors.js";
import type { CliConfig } from "../src/core/config.js";

interface Recorded {
  method: string;
  url: string;
  auth?: string;
  userAgent?: string;
}

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  count: number,
) => void;

let server: http.Server | undefined;

/** Spin up a throwaway HTTP server so the client is exercised end to end. */
async function serve(handler: Handler): Promise<{
  url: string;
  requests: Recorded[];
}> {
  const requests: Recorded[] = [];
  server = http.createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization,
      userAgent: req.headers["user-agent"],
    });
    handler(req, res, requests.length);
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

function makeConfig(
  url: string,
  overrides: Partial<CliConfig> = {},
): CliConfig {
  return {
    url,
    apiKey: "tmx_test",
    insecureTls: false,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("TermixClient", () => {
  it("sends the bearer credential and a descriptive User-Agent", async () => {
    const { url, requests } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const client = new TermixClient(makeConfig(url));
    await client.request({ method: "GET", path: "/host/db/host" });

    expect(requests[0]?.auth).toBe("Bearer tmx_test");
    expect(requests[0]?.userAgent).toMatch(/^termix-cli\//);
  });

  it("omits auth when the caller asks for none", async () => {
    const { url, requests } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const client = new TermixClient(makeConfig(url));
    await client.request({ method: "GET", path: "/health", noAuth: true });
    expect(requests[0]?.auth).toBeUndefined();
  });

  it("surfaces the server error message and machine code", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(423, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: "User data is locked", code: "DATA_LOCKED" }),
      );
    });

    const client = new TermixClient(makeConfig(url));
    await expect(
      client.request({ method: "GET", path: "/credentials" }),
    ).rejects.toMatchObject({
      message: "User data is locked",
      status: 423,
      code: "DATA_LOCKED",
    });
  });

  it("retries idempotent requests on a transient status", async () => {
    const { url, requests } = await serve((_req, res, count) => {
      if (count < 3) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ recovered: true }));
    });

    const client = new TermixClient(makeConfig(url));
    const result = await client.request({
      method: "GET",
      path: "/host/db/host",
    });

    expect(result).toEqual({ recovered: true });
    expect(requests).toHaveLength(3);
  });

  it("never retries a POST, which may not be idempotent", async () => {
    // Replaying /snippets/execute would run a remote command twice.
    const { url, requests } = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });

    const client = new TermixClient(makeConfig(url));
    await expect(
      client.request({ method: "POST", path: "/snippets/execute" }),
    ).rejects.toBeInstanceOf(TermixApiError);
    expect(requests).toHaveLength(1);
  });

  it("gives up after the retry budget", async () => {
    const { url, requests } = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });

    const client = new TermixClient(makeConfig(url));
    await expect(
      client.request({ method: "GET", path: "/host/db/host" }),
    ).rejects.toBeInstanceOf(TermixApiError);
    expect(requests).toHaveLength(3);
  });

  it("reports an unreachable server as a connection error", async () => {
    // Port 9 (discard) refuses connections.
    const client = new TermixClient(makeConfig("http://127.0.0.1:9"));
    await expect(
      client.request({ method: "GET", path: "/health", noAuth: true }),
    ).rejects.toBeInstanceOf(TermixConnectionError);
  });

  it("explains a 404 from a service that lives on another port", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    });

    const client = new TermixClient(makeConfig(url));
    await expect(
      client.request({ method: "GET", path: "/status", service: "metrics" }),
    ).rejects.toThrow(/metrics service/);
  });
});
