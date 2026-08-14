import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, it, expect, afterEach } from "vitest";
import { TerminalSocket } from "../src/terminal/ws-client.js";
import type { CliConfig } from "../src/core/config.js";

let server: http.Server | undefined;
let wss: WebSocketServer | undefined;

interface Harness {
  config: CliConfig;
  /** Authorization header seen on the upgrade request. */
  authHeader: () => string | undefined;
  /** Every message the client sent, in order. */
  received: Array<{ type: string; data?: unknown }>;
  /** Push a message to the connected client. */
  send: (payload: unknown) => void;
}

async function startServer(
  onConnect?: (ws: WebSocket) => void,
): Promise<Harness> {
  const received: Array<{ type: string; data?: unknown }> = [];
  let seenAuth: string | undefined;
  let socket: WebSocket | undefined;

  server = http.createServer();
  wss = new WebSocketServer({ server, path: "/ssh/websocket/" });

  wss.on("connection", (ws, req) => {
    seenAuth = req.headers.authorization;
    socket = ws;
    ws.on("message", (raw) => {
      try {
        received.push(JSON.parse(raw.toString("utf8")));
      } catch {
        // Ignore malformed frames; the assertions cover the real ones.
      }
    });
    onConnect?.(ws);
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;

  return {
    config: {
      url: `http://127.0.0.1:${port}`,
      insecureTls: false,
      requestTimeoutMs: 5000,
    },
    authHeader: () => seenAuth,
    received,
    send: (payload) => socket?.send(JSON.stringify(payload)),
  };
}

afterEach(async () => {
  wss?.close();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  wss = undefined;
  server = undefined;
});

describe("TerminalSocket", () => {
  it("authenticates with a bearer header rather than a query parameter", async () => {
    // A token in the URL would end up in server logs and process listings.
    const harness = await startServer();
    const socket = new TerminalSocket(harness.config, "jwt-token");
    await socket.open();

    expect(harness.authHeader()).toBe("Bearer jwt-token");
    socket.close();
  });

  it("sends connectToHost in the server's {type,data} envelope", async () => {
    const harness = await startServer();
    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    socket.connectToHost({
      cols: 120,
      rows: 40,
      hostConfig: { id: 7, ip: "10.0.0.5", port: 22, username: "root" },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.received[0]).toMatchObject({
      type: "connectToHost",
      data: {
        cols: 120,
        rows: 40,
        hostConfig: { id: 7, ip: "10.0.0.5", port: 22, username: "root" },
      },
    });
    socket.close();
  });

  it("resolves waitFor when the expected message arrives", async () => {
    const harness = await startServer((ws) => {
      ws.send(JSON.stringify({ type: "connected", message: "ok" }));
    });

    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    const message = await socket.waitFor(["connected"], 2000);
    expect(message.type).toBe("connected");
    socket.close();
  });

  it("rejects waitFor when the server reports an error instead", async () => {
    const harness = await startServer((ws) => {
      ws.send(JSON.stringify({ type: "error", message: "Host unreachable" }));
    });

    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    await expect(socket.waitFor(["connected"], 2000)).rejects.toThrow(
      "Host unreachable",
    );
    socket.close();
  });

  it("rejects waitFor when the connection closes early", async () => {
    const harness = await startServer((ws) => ws.close());
    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    await expect(socket.waitFor(["connected"], 2000)).rejects.toThrow(/closed/);
    socket.close();
  });

  it("forwards input and resize messages", async () => {
    const harness = await startServer();
    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    socket.input("ls -la\r");
    socket.resize(100, 30);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.received).toEqual([
      { type: "input", data: "ls -la\r" },
      { type: "resize", data: { cols: 100, rows: 30 } },
    ]);
    socket.close();
  });

  it("explains an authentication failure during the handshake", async () => {
    // A plain HTTP server refuses the upgrade with a 4xx.
    server = http.createServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server!.address() as AddressInfo;

    const socket = new TerminalSocket(
      {
        url: `http://127.0.0.1:${port}`,
        insecureTls: false,
        requestTimeoutMs: 5000,
      },
      "expired",
    );

    await expect(socket.open()).rejects.toThrow(/termix login/);
  });
});
