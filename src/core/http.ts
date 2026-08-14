import axios, { type AxiosInstance, type Method } from "axios";
import https from "node:https";
import type { CliConfig } from "./config.js";
import { getBearer } from "./auth.js";

export interface RequestOptions {
  method: Method;
  path: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
  /** Skip the Authorization header (login, health). */
  noAuth?: boolean;
}

/** Error carrying the HTTP status and Termix error payload. */
export class TermixApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly path: string,
  ) {
    super(message);
    this.name = "TermixApiError";
  }
}

/**
 * Thin HTTP client around the Termix API. Attaches the bearer credential and
 * normalises errors. There is no automatic re-login: an expired token surfaces
 * as a 401 with a hint to run `termix login`.
 */
export class TermixClient {
  private readonly axios: AxiosInstance;

  constructor(private readonly config: CliConfig) {
    if (config.insecureTls) {
      process.stderr.write(
        "termix: warning: TERMIX_INSECURE_TLS=true — TLS certificate verification is disabled\n",
      );
    }
    this.axios = axios.create({
      baseURL: config.url,
      timeout: config.requestTimeoutMs,
      httpsAgent: config.insecureTls
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
      // We handle non-2xx ourselves for uniform error mapping.
      validateStatus: () => true,
    });
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { ...opts.headers };
    if (!opts.noAuth) {
      headers.Authorization = `Bearer ${getBearer(this.config)}`;
    }

    const res = await this.axios.request({
      method: opts.method,
      url: opts.path,
      params: opts.params,
      data: opts.data,
      headers,
    });

    if (res.status < 200 || res.status >= 300) {
      let message = extractError(res.data) ?? `HTTP ${res.status}`;
      if (res.status === 401 && !opts.noAuth) {
        message += " — your session may have expired; run `termix login`.";
      } else if (res.status === 403) {
        // 403 also covers not-owner/access-denied, not just missing admin.
        message +=
          " — permission denied (admin-only endpoints also return 403).";
      }
      throw new TermixApiError(message, res.status, opts.path);
    }

    return res.data as T;
  }
}

function extractError(data: unknown): string | undefined {
  if (data && typeof data === "object" && "error" in data) {
    const e = (data as { error: unknown }).error;
    if (typeof e === "string") return e;
  }
  return undefined;
}
