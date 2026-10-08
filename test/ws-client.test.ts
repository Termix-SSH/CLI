import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, it, expect, afterEach } from "vitest";
import {
  TERMINAL_WEBSOCKET_PATH,
  TerminalSocket,
} from "../src/terminal/ws-client.js";
import { FeatureUnavailableError } from "../src/core/errors.js";
import type { CliConfig } from "../src/core/config.js";

let server: http.Server | undefined;
let wss: WebSocketServer | undefined;

interface Harness {
  config: CliConfig;
  /** Authorization header seen on the upgrade request. */
  authHeader: () => string | undefined;
  /** Path of every upgrade request, accepted or not, in order. */
  upgrades: string[];
  /** Every message the client sent, in order. */
  received: Array<{ type: string; data?: unknown }>;
  /** Push a message to the connected client. */
  send: (payload: unknown) => void;
}

async function startServer(
  onConnect?: (ws: WebSocket) => void,
  path = TERMINAL_WEBSOCKET_PATH,
): Promise<Harness> {
  const received: Array<{ type: string; data?: unknown }> = [];
  const upgrades: string[] = [];
  let seenAuth: string | undefined;
  let socket: WebSocket | undefined;

  server = http.createServer();
  server.on("upgrade", (req) => upgrades.push(req.url ?? ""));
  wss = new WebSocketServer({ server, path });

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
    upgrades,
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
        hostConfig: {
          id: 7,
          ip: "10.0.0.5",
          port: 22,
          username: "root",
        },
      },
    });

    socket.close();
  });

  it("waits until the terminal application handler answers ping", async () => {
    const harness = await startServer((ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8")) as {
          type?: string;
        };

        if (message.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      });
    });

    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    await socket.waitUntilReady();

    expect(harness.received.some((message) => message.type === "ping")).toBe(
      true,
    );

    socket.close();
  });

  it("keeps probing until the terminal application handler becomes ready", async () => {
    const handlerDelayMs = 150;
    const probeIntervalMs = 25;

    const harness = await startServer((ws) => {
      setTimeout(() => {
        ws.on("message", (raw) => {
          const message = JSON.parse(raw.toString("utf8")) as {
            type?: string;
          };

          if (message.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        });
      }, handlerDelayMs);
    });

    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    await socket.waitUntilReady(
      harness.config.requestTimeoutMs,
      probeIntervalMs,
    );

    const pingCount = harness.received.filter(
      (message) => message.type === "ping",
    ).length;

    expect(pingCount).toBeGreaterThan(1);

    socket.close();
  });

  it("times out when the terminal application handler never becomes ready", async () => {
    const harness = await startServer();
    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    await expect(socket.waitUntilReady(100, 20)).rejects.toThrow(
      /Timed out waiting for pong/,
    );

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

  it("connects at the ssh-terminal plugin's path", async () => {
    const harness = await startServer();
    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    expect(harness.upgrades).toEqual(["/plugin-ws/ssh-terminal/terminal"]);
    socket.close();
  });

  it("does not try any other path", async () => {
    const upgrades: string[] = [];
    server = http.createServer((req, res) => {
      upgrades.push(req.url ?? "");
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
    expect(upgrades).toEqual([TERMINAL_WEBSOCKET_PATH]);
  });

  it.each([
    [404, "missing", /not installed/],
    [503, "disabled", /turned off/],
  ])(
    "reports the ssh-terminal plugin as unavailable on a %i",
    async (status, reason, message) => {
      server = http.createServer((_req, res) => {
        res.writeHead(status);
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
        "jwt",
      );

      const error = await socket.open().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FeatureUnavailableError);
      expect((error as FeatureUnavailableError).reason).toBe(reason);
      expect((error as Error).message).toMatch(message);
    },
  );

  it("reports the failure when neither path is served", async () => {
    // Cloudflare in front of a server with no terminal route answers 502.
    server = http.createServer((_req, res) => {
      res.writeHead(502);
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
      "jwt",
    );

    await expect(socket.open()).rejects.toThrow(
      "Could not open the terminal connection: Unexpected server response: 502",
    );
  });

  it("explains a session the server closes for want of authentication", async () => {
    // 2.9 accepts the upgrade, then closes with 1008 for a missing or
    // expired token instead of refusing the handshake with a 401.
    const harness = await startServer((ws) =>
      ws.close(1008, "Authentication required"),
    );
    const socket = new TerminalSocket(harness.config, "expired");
    await socket.open();

    await expect(socket.waitFor(["connected"], 2000)).rejects.toThrow(
      /termix login/,
    );
    socket.close();
  });

  it("includes the server's reason when it closes the connection", async () => {
    const harness = await startServer((ws) =>
      ws.close(1008, "Data access required"),
    );
    const socket = new TerminalSocket(harness.config, "jwt");
    await socket.open();

    await expect(socket.waitFor(["connected"], 2000)).rejects.toThrow(
      "The server closed the connection: Data access required",
    );
    socket.close();
  });
});
