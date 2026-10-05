import WebSocket from "ws";
import { resolveWebSocketUrl } from "../core/services.js";
import type { CliConfig } from "../core/config.js";

/** Messages the server sends. Only the ones the CLI acts on are named. */
export interface ServerMessage {
  type: string;
  data?: unknown;
  message?: string;
  code?: string;
  sessionId?: string;
  path?: string;
}

export interface HostConfig {
  id: number;
  ip: string;
  port: number;
  username: string;
  /** Present only when the caller supplies an inline secret. */
  password?: string;
  key?: string;
  keyPassword?: string;
  keyType?: string;
  authType?: string;
  credentialId?: number;
}

export interface ConnectOptions {
  cols: number;
  rows: number;
  hostConfig: HostConfig;
  initialPath?: string;
  executeCommand?: string;
  tmuxAttachSession?: string;
}

type MessageHandler = (message: ServerMessage) => void;

/**
 * Where the terminal socket lives, newest layout first.
 *
 * Termix 2.9 moved the terminal into the ssh-terminal plugin, which serves it
 * under /plugin-ws/. Older servers serve it at /ssh/websocket/, a route 2.9
 * removed. Trying the current path first means only an older server pays for
 * a second handshake.
 */
export const TERMINAL_WEBSOCKET_PATHS = [
  "/plugin-ws/ssh-terminal/terminal",
  "/ssh/websocket/",
];

const LOGIN_HINT =
  "The server rejected the connection. Your session may have expired: run `termix login`.";

/**
 * Client for the Termix terminal WebSocket.
 *
 * The socket authenticates with a session JWT: the handlers verify it directly
 * and never consult the API-key table, so a `tmx_` credential cannot be used
 * here. Auth goes in the Authorization header rather than the documented
 * `?token=` query parameter, to keep the credential out of server logs and
 * process listings.
 */
export class TerminalSocket {
  private ws?: WebSocket;
  private readonly handlers = new Set<MessageHandler>();
  private pingTimer?: NodeJS.Timeout;
  /**
   * Messages that arrived before anything was listening.
   *
   * The server can answer a request in the same tick it is sent, so a
   * `waitFor` registered immediately afterwards would otherwise miss the
   * reply and hang until its timeout.
   */
  private readonly pending: ServerMessage[] = [];

  constructor(
    private readonly config: CliConfig,
    private readonly token: string,
  ) {}

  async open(): Promise<void> {
    let unanswered: { error: Error; url: string } | undefined;

    for (const path of TERMINAL_WEBSOCKET_PATHS) {
      const url = resolveWebSocketUrl(this.config, path);
      try {
        this.ws = await this.handshake(url);
        break;
      } catch (caught) {
        const error = caught as Error;
        // Refused, timed out or unauthorised would fail the same way at the
        // other path, so only a server that answered without upgrading is
        // worth asking again.
        if (!isWrongPath(error)) throw new Error(handshakeMessage(error, url));
        unanswered ??= { error, url };
      }
    }

    if (!this.ws) {
      // Neither layout answered. Report the current one, which is where a
      // supported server serves the terminal.
      throw new Error(handshakeMessage(unanswered!.error, unanswered!.url));
    }

    // The server drops idle sockets; a periodic ping keeps a session alive
    // while the user is reading rather than typing.
    this.pingTimer = setInterval(() => this.send("ping"), 30_000);
    this.pingTimer.unref();
  }

  private handshake(url: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        rejectUnauthorized: !this.config.insecureTls,
        handshakeTimeout: this.config.requestTimeoutMs,
      });

      const onOpen = (): void => {
        ws.off("error", onError);
        resolve(ws);
      };
      const onError = (error: Error): void => {
        ws.off("open", onOpen);
        reject(error);
      };

      ws.once("open", onOpen);
      ws.once("error", onError);

      ws.on("message", (raw) => {
        const message = parseMessage(raw);
        if (!message) return;
        if (this.handlers.size === 0) {
          this.pending.push(message);
          return;
        }
        for (const handler of this.handlers) handler(message);
      });
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);

    // Replay anything that arrived before this handler existed, so a reply
    // sent immediately after a request is never dropped.
    if (this.pending.length > 0) {
      const buffered = this.pending.splice(0, this.pending.length);
      for (const message of buffered) handler(message);
    }

    return () => this.handlers.delete(handler);
  }

  /** Wait for one of `types`, rejecting on `error` or an early close. */
  waitFor(types: string[], timeoutMs = 60_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      // onMessage replays buffered messages synchronously, so the handler can
      // run during registration - before the timer and unsubscribe exist.
      // Holding them in a box keeps cleanup safe at any point in that order.
      const state: {
        unsubscribe?: () => void;
        timer?: NodeJS.Timeout;
        settled: boolean;
      } = { settled: false };

      const cleanup = (): void => {
        state.settled = true;
        if (state.timer) clearTimeout(state.timer);
        state.unsubscribe?.();
        this.ws?.off("close", onClose);
      };

      const onClose = (code: number, reason: Buffer): void => {
        if (state.settled) return;
        cleanup();
        reject(new Error(closeMessage(code, reason.toString("utf8"))));
      };

      state.unsubscribe = this.onMessage((message) => {
        if (state.settled) return;
        if (types.includes(message.type)) {
          cleanup();
          resolve(message);
        } else if (message.type === "error") {
          cleanup();
          reject(new Error(message.message ?? "The server reported an error."));
        }
      });

      if (state.settled) {
        // A buffered message already resolved this during registration.
        state.unsubscribe();
        return;
      }

      state.timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${types.join(" or ")}.`));
      }, timeoutMs);

      this.ws?.once("close", onClose);
    });
  }

  send(type: string, data?: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify(data === undefined ? { type } : { type, data }),
    );
  }

  connectToHost(options: ConnectOptions): void {
    this.send("connectToHost", options);
  }

  input(data: string): void {
    this.send("input", data);
  }

  resize(cols: number, rows: number): void {
    this.send("resize", { cols, rows });
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send("disconnect");
      this.ws.close();
    }
    this.ws = undefined;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.ws?.once("close", (code, reason) =>
      handler(code, reason.toString("utf8")),
    );
  }
}

function parseMessage(raw: WebSocket.RawData): ServerMessage | null {
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as ServerMessage;
    return typeof parsed?.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The server answered the upgrade with an ordinary HTTP response, so it is up
 * but serves nothing there: a route that does not exist on this version, or a
 * proxy (Cloudflare answers 502) with nothing behind that path. A refused
 * credential is not a wrong path.
 */
function isWrongPath(error: Error): boolean {
  const match = /Unexpected server response: (\d{3})/.exec(error.message);
  return match !== null && match[1] !== "401" && match[1] !== "403";
}

/**
 * The handshake fails with a bare "Unexpected server response: 401", which
 * says nothing about what to do, so translate the common cases.
 */
function handshakeMessage(error: Error, url: string): string {
  const text = error.message;
  if (text.includes("401") || text.includes("403")) {
    return LOGIN_HINT;
  }
  if (text.includes("ECONNREFUSED")) {
    return `Could not reach the terminal service at ${url}. If you are connecting straight to a backend older than Termix 2.9 rather than through a proxy, set TERMIX_TERMINAL_URL.`;
  }
  if (text.includes("404")) {
    return `The terminal endpoint was not found at ${url}. If you are connecting straight to a backend older than Termix 2.9, set TERMIX_TERMINAL_URL (default port 30002).`;
  }
  return `Could not open the terminal connection: ${text}`;
}

/**
 * Termix 2.9 accepts the upgrade and then closes with 1008 when the token is
 * missing or expired, where older servers refused the handshake with a 401.
 * Both mean the same thing to the user.
 */
function closeMessage(code: number, reason: string): string {
  if (code === 1008 && reason === "Authentication required") return LOGIN_HINT;
  return reason
    ? `The server closed the connection: ${reason}`
    : "The server closed the connection.";
}
