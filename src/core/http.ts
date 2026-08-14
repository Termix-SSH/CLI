import axios, { type AxiosInstance, type Method } from "axios";
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import type { CliConfig } from "./config.js";
import { getBearer } from "./auth.js";
import { TermixApiError, TermixConnectionError } from "./errors.js";
import { resolveServiceUrl, type TermixService } from "./services.js";
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
  /** Which backend service serves this path. Defaults to the main API. */
  service?: TermixService;
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
 * HTTP client for the Termix API. Attaches the bearer credential, routes to
 * the right backend service, retries transient failures and normalises errors.
 *
 * There is no automatic re-login: Termix has no client refresh endpoint, so an
 * expired or revoked session surfaces as a 401 telling the user to log in.
 */
export class TermixClient {
  private readonly instances = new Map<string, AxiosInstance>();

  constructor(private readonly config: CliConfig) {
    if (config.insecureTls) {
      process.stderr.write(
        "termix: warning: TERMIX_INSECURE_TLS=true - TLS certificate verification is disabled\n",
      );
    }
  }

  private clientFor(service: TermixService): AxiosInstance {
    const baseURL = resolveServiceUrl(this.config, service);
    const existing = this.instances.get(baseURL);
    if (existing) return existing;

    const instance = axios.create({
      baseURL,
      timeout: this.config.requestTimeoutMs,
      httpsAgent: this.config.insecureTls
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
      maxRedirects: 0,
      // We handle non-2xx ourselves for uniform error mapping.
      validateStatus: () => true,
    });
    this.instances.set(baseURL, instance);
    return instance;
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const service = opts.service ?? "api";
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
        res = await this.clientFor(service).request({
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
          resolveServiceUrl(this.config, service),
        );
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (res.status >= 200 && res.status < 300) {
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

      throw toApiError(res.status, res.data, opts.path, service);
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

function toApiError(
  status: number,
  data: unknown,
  path: string,
  service: TermixService,
): TermixApiError {
  const { error, code } = extractError(data);
  let message = error ?? `HTTP ${status}`;

  // A 404 on a non-API service usually means the CLI is talking to a bare
  // backend where that service listens on its own port, rather than through
  // the reverse proxy that normally fronts them all.
  if (status === 404 && service !== "api") {
    message +=
      ` - "${path}" is served by the ${service} service, which is not reachable at this URL.` +
      ` Point TERMIX_${service.toUpperCase()}_URL at it, or use the address your reverse proxy serves.`;
  }

  return new TermixApiError(message, status, path, code);
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
