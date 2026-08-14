import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Resolved CLI configuration. Sources, in priority order:
 *   1. Environment variables (TERMIX_URL, TERMIX_TOKEN, TERMIX_API_KEY, ...)
 *   2. The stored config file written by `termix login`
 *      ($XDG_CONFIG_HOME/termix/config.json, default ~/.config/termix/config.json)
 *
 * The password is never stored anywhere: `termix login` exchanges it for a JWT
 * (30 days with rememberMe) and only the JWT is persisted, mirroring how the
 * Termix desktop app handles credentials.
 */
export interface CliConfig {
  url: string;
  /** JWT obtained via login — full (encrypted-data) access. */
  token?: string;
  /** API key (tmx_...) — non-encrypted endpoints only (alerts, audit logs). */
  apiKey?: string;
  /** Username recorded at login time (informational). */
  username?: string;
  insecureTls: boolean;
  requestTimeoutMs: number;
}

const storedConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().optional(),
  username: z.string().optional(),
});

export type StoredConfig = z.infer<typeof storedConfigSchema>;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  return path.join(base, "termix");
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), "config.json");
}

/** Read the stored config file, or null when absent/invalid. */
export function loadStoredConfig(
  env: NodeJS.ProcessEnv = process.env,
): StoredConfig | null {
  try {
    const raw = fs.readFileSync(configFilePath(env), "utf8");
    const parsed = storedConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Persist the config file with owner-only permissions (0600). */
export function saveStoredConfig(
  config: StoredConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configFilePath(env);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  // mkdir/write modes are ignored when the file already exists — enforce.
  fs.chmodSync(file, 0o600);
  return file;
}

/** Delete the stored config file. Returns true when a file was removed. */
export function deleteStoredConfig(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    fs.unlinkSync(configFilePath(env));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective configuration (env > stored file). Throws a readable
 * error when no server URL can be determined.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const stored = loadStoredConfig(env);

  const url = env.TERMIX_URL || stored?.url;
  if (!url) {
    throw new Error(
      "No Termix server configured. Run `termix login` or set TERMIX_URL.",
    );
  }

  const timeoutMs = env.TERMIX_REQUEST_TIMEOUT_MS
    ? Number(env.TERMIX_REQUEST_TIMEOUT_MS)
    : 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("TERMIX_REQUEST_TIMEOUT_MS must be a positive number.");
  }

  // Auth precedence: if either auth credential is set in the environment, the
  // environment wins as a unit — the stored file token is NOT used as a
  // fallback. Otherwise an explicit TERMIX_API_KEY would be silently overridden
  // by a leftover token in the config file (the caller thinks they scoped down
  // to a read-only key but keep full token access).
  const envToken = env.TERMIX_TOKEN || undefined;
  const envApiKey = env.TERMIX_API_KEY || undefined;
  const hasEnvAuth = Boolean(envToken || envApiKey);

  return {
    url: url.replace(/\/+$/, ""),
    token: envToken || (hasEnvAuth ? undefined : stored?.token),
    apiKey: envApiKey,
    username: stored?.username,
    insecureTls: env.TERMIX_INSECURE_TLS === "true",
    requestTimeoutMs: timeoutMs,
  };
}
