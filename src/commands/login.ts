import readline from "node:readline/promises";
import { Writable } from "node:stream";
import type { Command } from "commander";
import {
  loadStoredConfig,
  saveStoredConfig,
  deleteStoredConfig,
  resolveConfig,
  configFilePath,
  type CliConfig,
} from "../core/config.js";
import { decodeJwtExpMs } from "../core/auth.js";
import { TermixClient } from "../core/http.js";
import { printJson, run } from "../core/output.js";

interface LoginResponse {
  success?: boolean;
  token?: string;
  requires_totp?: boolean;
  temp_token?: string;
  is_admin?: boolean;
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Prompt without echoing the typed characters (passwords, TOTP). */
async function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    const pending = rl.question(question);
    muted = true;
    const answer = await pending;
    process.stderr.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

function bareClient(url: string): TermixClient {
  const config: CliConfig = {
    url: url.replace(/\/+$/, ""),
    insecureTls: process.env.TERMIX_INSECURE_TLS === "true",
    requestTimeoutMs: 60000,
  };
  return new TermixClient(config);
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description(
      "Log in to a Termix instance and store the session token (never the password) in the config file.",
    )
    .option("--url <url>", "Termix base URL (e.g. https://termix.example.com)")
    .option("--username <username>", "Termix username")
    .action(async (opts: { url?: string; username?: string }) =>
      run(async () => {
        const stored = loadStoredConfig();
        const url =
          opts.url ||
          process.env.TERMIX_URL ||
          stored?.url ||
          (await prompt("Termix URL: "));
        if (!url) throw new Error("A Termix URL is required.");

        const username =
          opts.username || stored?.username || (await prompt("Username: "));
        const password = await promptHidden("Password: ");

        const client = bareClient(url);
        let res = await client.request<LoginResponse>({
          method: "POST",
          path: "/users/login",
          data: { username, password, rememberMe: true },
          headers: { "X-Electron-App": "true" },
          noAuth: true,
        });

        if (res.requires_totp && res.temp_token) {
          const totpCode = await promptHidden("TOTP code: ");
          res = await client.request<LoginResponse>({
            method: "POST",
            path: "/users/totp/verify-login",
            data: {
              temp_token: res.temp_token,
              totp_code: totpCode,
              rememberMe: true,
            },
            headers: { "X-Electron-App": "true" },
            noAuth: true,
          });
        }

        if (!res.token) {
          throw new Error(
            "Login succeeded but no token was returned — this Termix version may not support the X-Electron-App header.",
          );
        }

        const file = saveStoredConfig({
          url: url.replace(/\/+$/, ""),
          token: res.token,
          username,
        });

        const expMs = decodeJwtExpMs(res.token);
        printJson({
          success: true,
          username,
          url: url.replace(/\/+$/, ""),
          tokenExpiresAt: expMs ? new Date(expMs).toISOString() : null,
          configFile: file,
        });
      }),
    );

  program
    .command("logout")
    .description("Delete the stored session (config file).")
    .action(async () =>
      run(async () => {
        const removed = deleteStoredConfig();
        printJson({ success: true, removed, configFile: configFilePath() });
      }),
    );

  program
    .command("whoami")
    .description("Show the authenticated user and session expiry.")
    .action(async () =>
      run(async () => {
        const config = resolveConfig();
        const client = new TermixClient(config);
        const me = await client.request<Record<string, unknown>>({
          method: "GET",
          path: "/users/me",
        });
        const expMs = config.token ? decodeJwtExpMs(config.token) : null;
        printJson({
          url: config.url,
          authMethod: config.token ? "token" : "apiKey",
          tokenExpiresAt: expMs ? new Date(expMs).toISOString() : null,
          user: me,
        });
      }),
    );
}
