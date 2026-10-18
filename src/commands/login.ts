import type { Command } from "commander";
import {
  loadStoredConfig,
  configFilePath,
  type CliConfig,
} from "../core/config.js";
import { saveSession, clearSession } from "../core/credentials-store.js";
import { decodeJwtExpMs } from "../core/auth.js";
import {
  listenForBrowserLogin,
  openInBrowser,
  pickBrowserLogin,
  type PublicLoginMethod,
} from "../core/browser-login.js";
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
  /** The account's second factors, on Termix 2.9 and later. */
  second_factors?: Array<{ id?: string; pluginId?: string }>;
  is_admin?: boolean;
  username?: string;
}

/** Client for the unauthenticated login exchange. */
function bareClient(
  url: string,
  insecure: boolean,
  token?: string,
): TermixClient {
  const config: CliConfig = {
    url: url.replace(/\/+$/, ""),
    insecureTls: insecure || process.env.TERMIX_INSECURE_TLS === "true",
    requestTimeoutMs: 60000,
    ...(token ? { token } : {}),
  };
  return new TermixClient(config);
}

// Termix only returns the token in the body for native apps; otherwise it is
// set as an httpOnly cookie the CLI cannot read.
const NATIVE_HEADERS = { "X-Electron-App": "true" };

/** Finishes a login that asked for a second factor. Only TOTP can be typed. */
async function completeTotp(
  client: TermixClient,
  tempToken: string,
  factorIds: string[],
  totp: string | undefined,
): Promise<LoginResponse> {
  const hasTotp = factorIds.length === 0 || factorIds.includes("totp");
  if (!hasTotp) {
    throw new UsageError(
      "This account signs in with a second factor the CLI cannot complete, such as a passkey. Create an API key in Termix and pass it with --api-key or TERMIX_API_KEY.",
    );
  }
  const totpCode = totp || (await promptHidden("Two-factor code: "));
  if (!totpCode) {
    throw new UsageError("A two-factor code is required.");
  }
  return client.request<LoginResponse>({
    method: "POST",
    path: "/users/totp/verify-login",
    data: {
      temp_token: tempToken,
      totp_code: totpCode,
      ...(factorIds.length ? { factor: "totp" } : {}),
      rememberMe: true,
    },
    headers: NATIVE_HEADERS,
    noAuth: true,
  });
}

/**
 * Single sign-on through the system browser. The server sends the token back
 * to a loopback port, like the desktop app.
 */
async function browserLogin(
  client: TermixClient,
  wanted: string | undefined,
  totp: string | undefined,
): Promise<string> {
  const methods = await client.request<PublicLoginMethod[]>({
    method: "GET",
    path: "/users/auth/methods",
    noAuth: true,
  });
  const target = pickBrowserLogin(
    Array.isArray(methods) ? methods : [],
    wanted,
  );

  const listener = await listenForBrowserLogin();
  try {
    const start = await client.request<{ redirectUrl?: string }>({
      method: "GET",
      path: `/users/auth/${encodeURIComponent(target.methodId)}/start`,
      params: {
        instance: target.instanceId,
        rememberMe: true,
        desktopCallbackPort: listener.port,
      },
      noAuth: true,
    });
    if (!start.redirectUrl) {
      throw new Error("The server did not return a sign in address.");
    }
    process.stderr.write(
      `Opening your browser to sign in with ${target.label}. If it does not open, visit:\n${start.redirectUrl}\n`,
    );
    openInBrowser(start.redirectUrl);

    const result = await listener.result;
    if (result.kind === "token") return result.token;
    const verified = await completeTotp(
      client,
      result.tempToken,
      result.factors,
      totp,
    );
    if (!verified.token) throw new Error("Two-factor sign in failed.");
    return verified.token;
  } finally {
    listener.close();
  }
}

async function storeSession(
  url: string,
  token: string,
  username: string,
  isAdmin: boolean | undefined,
): Promise<void> {
  const { file, usedKeychain } = await saveSession({ url, token, username });
  const expMs = decodeJwtExpMs(token);
  printResult(`Logged in to ${url} as ${username}.`, {
    username,
    url,
    isAdmin: isAdmin ?? false,
    tokenExpiresAt: expMs ? new Date(expMs).toISOString() : null,
    configFile: file,
    storage: usedKeychain ? "keychain" : "file",
  });
}

interface LoginOpts {
  url?: string;
  username?: string;
  passwordStdin?: boolean;
  totp?: string;
  sso?: string | boolean;
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
    .option(
      "--sso [name]",
      "Sign in with single sign-on in your browser. Name the provider when the server has more than one",
    )
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
        const normalisedUrl = url.replace(/\/+$/, "");
        const insecure = flags.insecure === true;
        const client = bareClient(url, insecure);

        if (opts.sso !== undefined && opts.sso !== false) {
          const token = await browserLogin(
            client,
            typeof opts.sso === "string" ? opts.sso : undefined,
            opts.totp,
          );
          const me = await bareClient(url, insecure, token).request<{
            username?: string;
            is_admin?: boolean;
          }>({ method: "GET", path: "/users/me" });
          await storeSession(
            normalisedUrl,
            token,
            String(me.username ?? ""),
            me.is_admin,
          );
          return;
        }

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

        let res = await client.request<LoginResponse>({
          method: "POST",
          path: "/users/login",
          data: { username, password, rememberMe: true },
          headers: NATIVE_HEADERS,
          noAuth: true,
        });

        if (res.requires_totp && res.temp_token) {
          res = await completeTotp(
            client,
            res.temp_token,
            (res.second_factors ?? [])
              .map((factor) => factor.id)
              .filter((id): id is string => !!id),
            opts.totp,
          );
        }

        if (!res.token) {
          throw new Error(
            "Login succeeded but no token was returned. This Termix version may be too old for the CLI.",
          );
        }

        await storeSession(normalisedUrl, res.token, username, res.is_admin);
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
