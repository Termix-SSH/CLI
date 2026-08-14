import type { Command } from "commander";
import {
  loadStoredConfig,
  configFilePath,
  type CliConfig,
} from "../core/config.js";
import { saveSession, clearSession } from "../core/credentials-store.js";
import { decodeJwtExpMs } from "../core/auth.js";
import { TermixClient } from "../core/http.js";
import { UsageError } from "../core/errors.js";
import { prompt, promptHidden, readSecretFromStdin } from "../core/prompt.js";
import {
  printRecord,
  printResult,
  printWarning,
  run,
} from "../core/output/index.js";
import { createContext, globalFlags } from "../core/context.js";

interface LoginResponse {
  success?: boolean;
  token?: string;
  requires_totp?: boolean;
  temp_token?: string;
  is_admin?: boolean;
  username?: string;
}

/** Client for the unauthenticated login exchange. */
function bareClient(url: string, insecure: boolean): TermixClient {
  const config: CliConfig = {
    url: url.replace(/\/+$/, ""),
    insecureTls: insecure || process.env.TERMIX_INSECURE_TLS === "true",
    requestTimeoutMs: 60000,
    serviceUrls: {},
  };
  return new TermixClient(config);
}

interface LoginOpts {
  url?: string;
  username?: string;
  passwordStdin?: boolean;
  totp?: string;
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description(
      "Log in and store the session token. The password is never written to disk.",
    )
    .option("--url <url>", "Termix base URL (e.g. https://termix.example.com)")
    .option("--username <username>", "Termix username")
    .option(
      "--password-stdin",
      "Read the password from stdin instead of prompting",
    )
    .option("--totp <code>", "Two-factor code, for non-interactive login")
    .action(async function (this: Command, opts: LoginOpts) {
      await run(async () => {
        const flags = globalFlags(this);
        const stored = loadStoredConfig();

        const url =
          opts.url ||
          flags.url ||
          process.env.TERMIX_URL ||
          stored?.url ||
          (await prompt("Termix URL: "));
        if (!url) throw new UsageError("A Termix URL is required.");

        // Do not silently reuse a stored username: after switching accounts
        // that would log in as the wrong user without ever showing which.
        const username =
          opts.username ||
          (await prompt(
            stored?.username ? `Username [${stored.username}]: ` : "Username: ",
          )) ||
          stored?.username;
        if (!username) throw new UsageError("A username is required.");

        const password = opts.passwordStdin
          ? await readSecretFromStdin()
          : await promptHidden("Password: ");
        if (!password) throw new UsageError("A password is required.");

        const client = bareClient(url, flags.insecure === true);
        let res = await client.request<LoginResponse>({
          method: "POST",
          path: "/users/login",
          data: { username, password, rememberMe: true },
          // Termix only returns the token in the body for native apps;
          // otherwise it is set as an httpOnly cookie the CLI cannot read.
          headers: { "X-Electron-App": "true" },
          noAuth: true,
        });

        if (res.requires_totp && res.temp_token) {
          const totpCode =
            opts.totp || (await promptHidden("Two-factor code: "));
          if (!totpCode) {
            throw new UsageError("A two-factor code is required.");
          }
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
            "Login succeeded but no token was returned. This Termix version may be too old for the CLI.",
          );
        }

        const normalisedUrl = url.replace(/\/+$/, "");
        const { file, usedKeychain } = await saveSession({
          url: normalisedUrl,
          token: res.token,
          username,
        });

        const expMs = decodeJwtExpMs(res.token);
        printResult(`Logged in to ${normalisedUrl} as ${username}.`, {
          username,
          url: normalisedUrl,
          isAdmin: res.is_admin ?? false,
          tokenExpiresAt: expMs ? new Date(expMs).toISOString() : null,
          configFile: file,
          storage: usedKeychain ? "keychain" : "file",
        });
      });
    });

  program
    .command("logout")
    .description("Delete the stored session.")
    .action(async () =>
      run(async () => {
        // Clears the keychain entry as well as the file, so a logout does not
        // leave a usable token behind.
        const removed = await clearSession();
        printResult(removed ? "Logged out." : "No stored session to remove.", {
          removed,
          configFile: configFilePath(),
        });
      }),
    );

  program
    .command("whoami")
    .description("Show the authenticated user and session expiry.")
    .action(async function (this: Command) {
      await run(async () => {
        const { config, client } = await createContext(this);
        const me = await client.request<Record<string, unknown>>({
          method: "GET",
          path: "/users/me",
        });

        const expMs = config.token ? decodeJwtExpMs(config.token) : null;
        if (expMs && expMs < Date.now()) {
          printWarning("The stored token has expired. Run `termix login`.");
        }

        printRecord({
          username: me.username,
          userId: me.userId,
          isAdmin: me.is_admin,
          isOidc: me.is_oidc,
          totpEnabled: me.totp_enabled,
          url: config.url,
          authMethod: config.apiKey ? "api-key" : "session token",
          tokenExpiresAt: expMs ? new Date(expMs).toISOString() : null,
        });
      });
    });
}
