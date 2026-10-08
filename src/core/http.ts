import axios, { type AxiosInstance, type Method } from "axios";
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import type { CliConfig } from "./config.js";
import { getBearer } from "./auth.js";
import { TermixApiError, TermixConnectionError } from "./errors.js";
import { unavailableFor } from "./plugins.js";
import { CLI_VERSION } from "../version.js";

export { TermixApiError } from "./errors.js";

export interface RequestOptions {
  method: Method;
  path: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
  /** Skip the Authorization header (login, health). */
  noAuth?: boolean;
  /** Override the response type, e.g. "arraybuffer" for downloads. */
  responseType?: "json" | "text" | "arraybuffer" | "stream";
  /** Force retry on/off, overriding the method-based default. */
  retry?: boolean;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/**
 * Only methods that are safe to repeat. POST is excluded by default because
 * Termix has genuinely non-idempotent POSTs - replaying /snippets/execute
 * would run a remote command twice.
 */
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

function buildUserAgent(version: string): string {
  return `termix-cli/${version} (node/${process.versions.node}; ${process.platform})`;
}

// Default to a well-formed string so the header is always meaningful, even
// before the entry point injects the real version.
let userAgent = buildUserAgent(CLI_VERSION);

export function setUserAgent(version: string): void {
  userAgent = buildUserAgent(version);
}

/**
 * HTTP client for the Termix API. Attaches the bearer credential, retries
 * transient failures and normalises errors. Since Termix 2.9 core and every
 * plugin answer on the one origin, so there is a single base URL.
 *
 * There is no automatic re-login: Termix has no client refresh endpoint, so an
 * expired or revoked session surfaces as a 401 telling the user to log in.
 */
export class TermixClient {
  private instance?: AxiosInstance;

  constructor(private readonly config: CliConfig) {
    if (config.insecureTls) {
      process.stderr.write(
        "termix: warning: TERMIX_INSECURE_TLS=true - TLS certificate verification is disabled\n",
      );
    }
  }

  private axios(): AxiosInstance {
    if (this.instance) return this.instance;

    this.instance = axios.create({
      baseURL: this.config.url,
      timeout: this.config.requestTimeoutMs,
      httpsAgent: this.config.insecureTls
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
      maxRedirects: 0,
      // We handle non-2xx ourselves for uniform error mapping.
      validateStatus: () => true,
    });
    return this.instance;
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const method = String(opts.method).toUpperCase();
    const retryable = opts.retry ?? IDEMPOTENT.has(method);

    const headers: Record<string, string> = {
      "User-Agent": userAgent,
      ...opts.headers,
    };
    if (!opts.noAuth) {
      headers.Authorization = `Bearer ${getBearer(this.config)}`;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res;
      try {
        res = await this.axios().request({
          method: opts.method,
          url: opts.path,
          params: opts.params,
          data: opts.data,
          headers,
          responseType: opts.responseType ?? "json",
        });
      } catch (error) {
        // Transport-level failure (DNS, refused, TLS, timeout).
        lastError = new TermixConnectionError(
          connectionMessage(error),
          this.config.url,
        );
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (res.status >= 200 && res.status < 300) {
        if (isUnexpectedHtml(res.headers, opts.responseType)) {
          throw new TermixApiError(
            "The server answered with a web page instead of the API. This route does not exist on this Termix version.",
            404,
            opts.path,
          );
        }
        return res.data as T;
      }

      if (
        retryable &&
        RETRYABLE_STATUS.has(res.status) &&
        attempt < MAX_ATTEMPTS
      ) {
        await sleep(
          retryAfterMs(res.headers?.["retry-after"]) ?? backoffMs(attempt),
        );
        continue;
      }

      throw toApiError(res.status, res.data, opts.path);
    }

    throw lastError ?? new Error("Request failed");
  }
}

/** Exponential backoff with jitter, so parallel CLIs do not resynchronise. */
function backoffMs(attempt: number): number {
  const base = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * base);
}

function retryAfterMs(header: unknown): number | undefined {
  if (typeof header !== "string") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Behind nginx an unknown path falls through to the web app, which answers
 * 200 with index.html. Treat that as the missing route it is.
 */
function isUnexpectedHtml(
  headers: unknown,
  responseType: RequestOptions["responseType"],
): boolean {
  if (responseType && responseType !== "json") return false;
  const type = (headers as Record<string, unknown> | undefined)?.[
    "content-type"
  ];
  return typeof type === "string" && type.includes("text/html");
}

const PLUGIN_PATH = /^\/plugin-api\/([^/?#]+)/;
const NOT_AVAILABLE = "This feature is not available";

function toApiError(status: number, data: unknown, path: string): Error {
  // Core answers for a plugin that is gone (404) or turned off (503, with
  // its id) before the plugin ever sees the request.
  const pluginId = PLUGIN_PATH.exec(path)?.[1];
  if (pluginId && data && typeof data === "object") {
    const body = data as { error?: unknown; pluginId?: unknown };
    if (status === 503 && body.pluginId === pluginId) {
      return unavailableFor(pluginId, "disabled");
    }
    if (status === 404 && body.error === NOT_AVAILABLE && !body.pluginId) {
      return unavailableFor(pluginId, "missing");
    }
  }

  const { error, code } = extractError(data);
  return new TermixApiError(error ?? `HTTP ${status}`, status, path, code);
}

interface ConnectionLogEntry {
  type?: string;
  stage?: string;
  message?: string;
}

/**
 * Pull the most useful message out of an error body.
 *
 * The SSH-backed services answer with `{status, message, connectionLogs}`
 * rather than `{error}`, and the connection log holds the real reason a
 * connection failed. Without it the user sees a bare HTTP 500 for something
 * as actionable as an unverified host key.
 */
function extractError(data: unknown): { error?: string; code?: string } {
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;

  const primary =
    typeof record.error === "string"
      ? record.error
      : typeof record.message === "string"
        ? record.message
        : undefined;

  let detail: string | undefined;
  if (Array.isArray(record.connectionLogs)) {
    const failure = (record.connectionLogs as ConnectionLogEntry[])
      .filter((entry) => entry?.type === "error" && entry.message)
      .pop();
    // Skip a log line that just repeats the summary.
    if (failure?.message && failure.message !== primary) {
      detail = failure.message;
    }
  }

  const error = [primary, detail].filter(Boolean).join(" - ") || undefined;

  return {
    error,
    code: typeof record.code === "string" ? record.code : undefined,
  };
}

function connectionMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  switch (code) {
    case "ECONNREFUSED":
      return "Connection refused - is the Termix server running at this URL?";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Could not resolve the Termix server hostname.";
    case "ETIMEDOUT":
    case "ECONNABORTED":
      return "Request timed out. Raise TERMIX_REQUEST_TIMEOUT_MS if the server is slow.";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return "TLS certificate could not be verified. Set TERMIX_INSECURE_TLS=true to trust it anyway.";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
