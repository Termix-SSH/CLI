import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { UsageError } from "./errors.js";

/** A login method from GET /users/auth/methods. */
export interface PublicLoginMethod {
  id: string;
  kind: "redirect" | "form";
  instances: Array<{ id: string; label: string }>;
}

export interface BrowserLoginTarget {
  methodId: string;
  instanceId: string;
  label: string;
}

/**
 * Picks the single sign-on provider to use. `wanted` matches an instance
 * label or id, case-insensitively; it may be left out when there is only one.
 */
export function pickBrowserLogin(
  methods: PublicLoginMethod[],
  wanted?: string,
): BrowserLoginTarget {
  const targets = methods
    .filter((method) => method.kind === "redirect")
    .flatMap((method) =>
      method.instances.map((instance) => ({
        methodId: method.id,
        instanceId: instance.id,
        label: instance.label,
      })),
    );
  if (targets.length === 0) {
    throw new UsageError(
      "This Termix server has no single sign-on provider. Log in with a username and password, or an API key.",
    );
  }
  const names = targets.map((target) => `"${target.label}"`).join(", ");
  if (!wanted) {
    const [only] = targets;
    if (targets.length === 1 && only) return only;
    throw new UsageError(
      `This server has more than one single sign-on provider. Pick one with --sso <name>: ${names}.`,
    );
  }
  const needle = wanted.toLowerCase();
  const match = targets.find(
    (target) =>
      target.label.toLowerCase() === needle ||
      target.instanceId.toLowerCase() === needle,
  );
  if (!match) {
    throw new UsageError(
      `No single sign-on provider named "${wanted}". Choose one of: ${names}.`,
    );
  }
  return match;
}

export type BrowserLoginResult =
  | { kind: "token"; token: string }
  | { kind: "second-factor"; tempToken: string; factors: string[] };

const PAGE = (message: string) =>
  `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>${message}</h2><p>You can close this tab and go back to your terminal.</p></body></html>`;

/**
 * Listens on a loopback port for the server's redirect back to
 * http://localhost:<port>/oidc-callback, the same return address the desktop
 * app uses (RFC 8252).
 */
export async function listenForBrowserLogin(
  timeoutMs = 5 * 60 * 1000,
): Promise<{
  port: number;
  result: Promise<BrowserLoginResult>;
  close: () => void;
}> {
  let settle: (value: BrowserLoginResult | Error) => void = () => {};
  const outcome = new Promise<BrowserLoginResult | Error>((resolve) => {
    settle = resolve;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/oidc-callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const token = url.searchParams.get("token");
    const tempToken = url.searchParams.get("temp_token");
    if (url.searchParams.get("second_factor") === "1" && tempToken) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE("Almost done. Finish the second step in your terminal."));
      settle({
        kind: "second-factor",
        tempToken,
        factors: (url.searchParams.get("second_factors") ?? "")
          .split(",")
          .filter(Boolean),
      });
      return;
    }
    if (url.searchParams.get("success") === "true" && token) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE("Signed in to the Termix CLI."));
      settle({ kind: "token", token });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE("Sign in failed."));
    settle(new Error(url.searchParams.get("error") || "Sign in failed."));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  const timer = setTimeout(
    () => settle(new Error("Timed out waiting for the browser sign in.")),
    timeoutMs,
  );
  const close = () => {
    clearTimeout(timer);
    server.close();
  };

  const result = outcome.then((value) => {
    close();
    if (value instanceof Error) throw value;
    return value;
  });
  // The browser can answer before the caller awaits this.
  result.catch(() => {});
  return { port, result, close };
}

/** Best effort: the URL is printed too, for machines with no browser. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? // cmd's start would split the URL at "&".
        ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL still works.
  }
}
