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
    const url = resolveWebSocketUrl(this.config, "/ssh/websocket/");

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        rejectUnauthorized: !this.config.insecureTls,
        handshakeTimeout: this.config.requestTimeoutMs,
      });
      this.ws = ws;

      const onOpen = (): void => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        ws.off("open", onOpen);
        reject(new Error(handshakeMessage(error, url)));
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

    // The server drops idle sockets; a periodic ping keeps a session alive
    // while the user is reading rather than typing.
    this.pingTimer = setInterval(() => this.send("ping"), 30_000);
    this.pingTimer.unref();
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

      const onClose = (): void => {
        if (state.settled) return;
        cleanup();
        reject(new Error("The server closed the connection."));
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
 * The handshake fails with a bare "Unexpected server response: 401", which
 * says nothing about what to do, so translate the common cases.
 */
function handshakeMessage(error: Error, url: string): string {
  const text = error.message;
  if (text.includes("401") || text.includes("403")) {
    return "The server rejected the connection. Your session may have expired: run `termix login`.";
  }
  if (text.includes("ECONNREFUSED")) {
    return `Could not reach the terminal service at ${url}. If you are connecting straight to a backend rather than through a proxy, set TERMIX_TERMINAL_URL.`;
  }
  if (text.includes("404")) {
    return `The terminal endpoint was not found at ${url}. If you are connecting straight to a backend, set TERMIX_TERMINAL_URL (default port 30002).`;
  }
  return `Could not open the terminal connection: ${text}`;
}
