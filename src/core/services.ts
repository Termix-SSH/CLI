import type { CliConfig } from "./config.js";

/**
 * WebSocket URL on the server's origin, with the ws(s) scheme. Since Termix
 * 2.9 every socket rides the main backend under /plugin-ws/.
 */
export function resolveWebSocketUrl(config: CliConfig, path: string): string {
  const url = new URL(config.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = joinPath(url.pathname, path);
  return url.toString();
}

function joinPath(base: string, path: string): string {
  const left = base.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  return `${left}/${right}`;
}
