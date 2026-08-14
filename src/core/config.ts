import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Resolved CLI configuration. Sources, in priority order:
 *   1. Explicit flags (--api-key, --url)
 *   2. Environment variables (TERMIX_URL, TERMIX_API_KEY, TERMIX_TOKEN, ...)
 *   3. The stored config file written by `termix login`
 *
 * The password is never stored anywhere: `termix login` exchanges it for a JWT
 * (30 days with rememberMe) and only the JWT is persisted.
 */
export interface CliConfig {
  url: string;
  /** JWT obtained via login. Required for WebSocket features (`termix ssh`). */
  token?: string;
  /** API key (tmx_...). Long-lived; full data access. Cannot open WebSockets. */
  apiKey?: string;
  /** Username recorded at login time (informational). */
  username?: string;
  insecureTls: boolean;
  requestTimeoutMs: number;
  /** Per-service base URL overrides for non-nginx (bare backend) deployments. */
  serviceUrls?: ServiceUrlOverrides;
}

export interface ServiceUrlOverrides {
  metrics?: string;
  docker?: string;
  files?: string;
  tunnel?: string;
  terminal?: string;
}

const storedConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().optional(),
  username: z.string().optional(),
});

export type StoredConfig = z.infer<typeof storedConfigSchema>;

/**
 * Platform-native config directory.
 *
 * XDG_CONFIG_HOME wins everywhere when set, so Linux conventions and CI
 * overrides keep working. Otherwise each platform gets its own location -
 * writing to ~/.config on Windows leaves the token in a directory nothing
 * else uses and that no OS mechanism protects.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, "termix");

  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = env.APPDATA?.trim();
    return path.join(
      appData || path.join(home, "AppData", "Roaming"),
      "termix",
    );
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "termix");
  }
  return path.join(home, ".config", "termix");
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), "config.json");
}

/** The pre-1.0 location, used on every platform. Migrated on first read. */
function legacyConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || path.join(os.homedir(), ".config");
  return path.join(base, "termix", "config.json");
}

/**
 * Move a pre-1.0 config to the platform-native path. Best effort: a failure
 * here must never block a command, it just means the user logs in again.
 */
function migrateLegacyConfig(env: NodeJS.ProcessEnv): void {
  const legacy = legacyConfigFilePath(env);
  const current = configFilePath(env);
  if (legacy === current) return;

  try {
    if (!fs.existsSync(legacy) || fs.existsSync(current)) return;
    const raw = fs.readFileSync(legacy, "utf8");
    if (!storedConfigSchema.safeParse(JSON.parse(raw)).success) return;

    fs.mkdirSync(path.dirname(current), { recursive: true, mode: 0o700 });
    fs.writeFileSync(current, raw, { mode: 0o600 });
    restrictPermissions(current);
    fs.unlinkSync(legacy);
    process.stderr.write(`termix: moved config to ${current}\n`);
  } catch {
    // Leave the legacy file alone; the user can re-login.
  }
}

/**
 * Owner-only permissions. chmod is a no-op on Windows (it cannot express
 * "owner only"), so the file there is protected by the user profile ACL and,
 * when available, by storing the token in the OS keychain instead.
 */
function restrictPermissions(file: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Non-fatal: the write already succeeded with mode 0600.
  }
}

/** Read the stored config file, or null when absent/invalid. */
export function loadStoredConfig(
  env: NodeJS.ProcessEnv = process.env,
): StoredConfig | null {
  migrateLegacyConfig(env);
  try {
    const raw = fs.readFileSync(configFilePath(env), "utf8");
    const parsed = storedConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Persist the config file with owner-only permissions where supported. */
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
  // Write modes are ignored when the file already exists - enforce.
  restrictPermissions(file);
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

export interface ResolveOptions {
  /** From --api-key; outranks every other credential source. */
  apiKey?: string;
  /** From --url. */
  url?: string;
}

/**
 * Resolve the effective configuration. Throws a readable error when no server
 * URL can be determined.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveOptions = {},
): CliConfig {
  const stored = loadStoredConfig(env);

  const url = opts.url || env.TERMIX_URL || stored?.url;
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

  // Auth precedence: an explicitly supplied credential wins as a unit, and the
  // stored file token is NOT used as a fallback beside it. Otherwise an
  // explicit TERMIX_API_KEY would be silently accompanied by a leftover token
  // in the config file - the caller thinks they scoped down to a key but keep
  // full session access.
  const flagApiKey = opts.apiKey || undefined;
  const envApiKey = env.TERMIX_API_KEY || undefined;
  const envToken = env.TERMIX_TOKEN || undefined;
  const apiKey = flagApiKey || envApiKey;
  const hasExplicitAuth = Boolean(apiKey || envToken);

  return {
    url: normaliseUrl(url),
    token: envToken || (hasExplicitAuth ? undefined : stored?.token),
    apiKey,
    username: stored?.username,
    insecureTls: env.TERMIX_INSECURE_TLS === "true",
    requestTimeoutMs: timeoutMs,
    serviceUrls: {
      metrics: normaliseOptionalUrl(env.TERMIX_METRICS_URL),
      docker: normaliseOptionalUrl(env.TERMIX_DOCKER_URL),
      files: normaliseOptionalUrl(env.TERMIX_FILES_URL),
      tunnel: normaliseOptionalUrl(env.TERMIX_TUNNEL_URL),
      terminal: normaliseOptionalUrl(env.TERMIX_TERMINAL_URL),
    },
  };
}

function normaliseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      `Invalid Termix URL: "${value}" (expected http:// or https://).`,
    );
  }
  return trimmed;
}

function normaliseOptionalUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? normaliseUrl(trimmed) : undefined;
}
