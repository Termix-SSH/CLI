import type { CliConfig } from "./config.js";

/**
 * Termix runs as several Express apps on separate ports. In Docker (and any
 * normal deployment) nginx fronts them all on a single origin, so plain paths
 * work. Running a bare backend exposes only the main API on PORT, and the
 * other services stay on their own localhost ports.
 *
 * Commands declare which service they need; this resolves the base URL, using
 * an explicit override when one is set and otherwise assuming the single-origin
 * layout.
 */
export type TermixService =
  "api" | "metrics" | "docker" | "files" | "tunnel" | "terminal";

/** Default localhost ports, for the error message when a bare backend 404s. */
export const SERVICE_PORTS: Record<Exclude<TermixService, "api">, number> = {
  terminal: 30002,
  tunnel: 30003,
  files: 30004,
  metrics: 30005,
  docker: 30007,
};

export function resolveServiceUrl(
  config: CliConfig,
  service: TermixService,
): string {
  if (service === "api") return config.url;
  return config.serviceUrls?.[service] ?? config.url;
}

/**
 * WebSocket URL for the terminal service. Behind a proxy this is the same
 * origin with the ws(s) scheme; a bare backend needs the override.
 */
export function resolveWebSocketUrl(config: CliConfig, path: string): string {
  const base = resolveServiceUrl(config, "terminal");
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = joinPath(url.pathname, path);
  return url.toString();
}

function joinPath(base: string, path: string): string {
  const left = base.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  return `${left}/${right}`;
}
