import fs from "node:fs";
import type { Command } from "commander";
import { TermixApiError, UsageError } from "../core/errors.js";
import type { TermixClient } from "../core/http.js";
import { printWarning } from "../core/output/index.js";
import { FEATURES } from "../api/features.js";

/** Options shared by `hosts create` and `hosts update`. */
export interface HostFieldOpts {
  name?: string;
  ip?: string;
  port?: string;
  username?: string;
  authType?: string;
  password?: string;
  keyFile?: string;
  keyPassword?: string;
  credentialId?: string;
  /** False when --no-credential is passed. */
  credential?: boolean;
  folder?: string;
  tags?: string;
  enableTerminal?: boolean;
  enableFileManager?: boolean;
  enableDocker?: boolean;
  enableTunnel?: boolean;
}

/** The SSH auth types Termix core can connect with. */
const AUTH_TYPES = ["password", "key", "credential", "agent", "none"];

/** Attach the shared host field options to a command. */
export function addHostFieldOptions(cmd: Command): Command {
  return cmd
    .option("--name <name>", "Display name (defaults to user@ip)")
    .option("--ip <ip>", "Hostname or IP address")
    .option("--port <port>", "SSH port (default 22)")
    .option("--username <username>", "SSH username")
    .option(
      "--auth-type <type>",
      `Authentication type: ${AUTH_TYPES.join(" | ")}. --credential-id implies credential`,
    )
    .option("--key-file <path>", "Path to a private key file (authType=key)")
    .option(
      "--password <password>",
      "Password. Prefer TERMIX_HOST_PASSWORD: argv is visible to other processes",
    )
    .option(
      "--key-password <passphrase>",
      "Key passphrase. Prefer TERMIX_HOST_KEY_PASSWORD",
    )
    .option(
      "--credential-id <id>",
      "Use a saved shared credential instead of inline secrets (authType=credential)",
    )
    .option(
      "--no-credential",
      "Unbind the saved credential. Pass --auth-type too, unless --password or --key-file implies it",
    )
    .option("--folder <folder>", "Folder to place the host in")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--enable-terminal", "Enable the terminal for this host")
    .option("--enable-file-manager", "Enable the file manager for this host")
    .option("--enable-docker", "Enable Docker for this host")
    .option("--enable-tunnel", "Enable tunneling for this host");
}

/**
 * Read a secret, preferring the environment over argv, since command-line
 * arguments are visible in `ps` output and shell history.
 */
function resolveSecret(
  flagValue: string | undefined,
  envName: string,
  flagName: string,
): string | undefined {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  if (flagValue !== undefined) {
    process.stderr.write(
      `termix: warning: ${flagName} is visible in the process list and shell history; use ${envName} instead\n`,
    );
  }
  return flagValue;
}

/**
 * Build the request body from the shared options. Only provided fields are
 * included. `connectionType: "ssh"` is always set, mirroring the web UI.
 */
export function buildHostPayload(opts: HostFieldOpts): Record<string, unknown> {
  const body: Record<string, unknown> = { connectionType: "ssh" };

  if (opts.name !== undefined) body.name = opts.name;
  if (opts.ip !== undefined) body.ip = opts.ip;
  if (opts.port !== undefined) body.port = parsePort(opts.port);
  if (opts.username !== undefined) body.username = opts.username;

  const password = resolveSecret(
    opts.password,
    "TERMIX_HOST_PASSWORD",
    "--password",
  );
  if (password !== undefined) body.password = password;

  const keyPassword = resolveSecret(
    opts.keyPassword,
    "TERMIX_HOST_KEY_PASSWORD",
    "--key-password",
  );
  if (keyPassword !== undefined) body.keyPassword = keyPassword;

  if (opts.keyFile !== undefined) body.key = readKeyFile(opts.keyFile);
  if (opts.credentialId !== undefined) {
    if (opts.credential === false) {
      throw new UsageError(
        "Pass either --credential-id or --no-credential, not both.",
      );
    }
    const id = Number(opts.credentialId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new UsageError(
        `Invalid --credential-id: "${opts.credentialId}" (use --no-credential to unbind one).`,
      );
    }
    body.credentialId = id;
  }
  if (opts.credential === false) body.credentialId = null;

  // The server resolves a bound credential whatever the auth type says, so a
  // host that does not sign in with a credential must not keep one bound.
  if (opts.authType !== undefined) {
    body.authType = validateAuthType(opts.authType);
    if (body.authType !== "credential") {
      if (body.credentialId) {
        throw new UsageError(
          "--credential-id needs --auth-type credential (or leave --auth-type out).",
        );
      }
      body.credentialId = null;
    }
    // Core keeps a password next to a key, but drops the key for password.
    if (body.authType === "password" && body.key !== undefined) {
      throw new UsageError(
        "--key-file would be dropped with --auth-type password. Use --auth-type key, which keeps the password too.",
      );
    }
  } else if (body.credentialId) {
    body.authType = "credential";
  }
  if (opts.folder !== undefined) body.folder = opts.folder;
  if (opts.tags !== undefined) body.tags = splitTags(opts.tags);
  if (opts.enableTerminal !== undefined)
    body.enableTerminal = opts.enableTerminal;
  if (opts.enableFileManager !== undefined)
    body.enableFileManager = opts.enableFileManager;
  if (opts.enableDocker !== undefined) body.enableDocker = opts.enableDocker;
  if (opts.enableTunnel !== undefined) body.enableTunnel = opts.enableTunnel;

  return body;
}

/**
 * Since Termix 2.9 these per-host switches are each plugin's own host
 * settings, which the host routes ignore.
 */
const HOST_TOGGLES = [
  { flag: "enableTerminal", feature: "terminal" },
  { flag: "enableFileManager", feature: "files" },
  { flag: "enableDocker", feature: "docker" },
  { flag: "enableTunnel", feature: "tunnels" },
] as const;

/** The plugin host settings to write for the --enable-* flags passed. */
export function hostToggleSettings(
  opts: HostFieldOpts,
): Array<{ pluginId: string; settings: Record<string, boolean> }> {
  return HOST_TOGGLES.filter(({ flag }) => opts[flag] !== undefined).map(
    ({ flag, feature }) => ({
      pluginId: FEATURES[feature].pluginId,
      settings: { [flag]: opts[flag] as boolean },
    }),
  );
}

/** Write the --enable-* flags to their plugins' settings for a host. */
export async function applyHostToggles(
  client: TermixClient,
  hostId: number,
  opts: HostFieldOpts,
): Promise<void> {
  for (const { pluginId, settings } of hostToggleSettings(opts)) {
    try {
      await client.request({
        method: "PUT",
        path: `/plugins/${pluginId}/settings/host/${hostId}`,
        data: settings,
      });
    } catch (error) {
      if (error instanceof TermixApiError && error.status === 404) {
        printWarning(
          `Skipped ${Object.keys(settings)[0]}: the "${pluginId}" plugin is not installed on this server.`,
        );
        continue;
      }
      throw error;
    }
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new UsageError(`Invalid port: "${value}".`);
  }
  return port;
}

/**
 * The auth type implied by the secret that was passed, if any. A key wins
 * over a password: core keeps the password next to a key, but drops the key
 * for password auth.
 */
export function inferAuthType(
  body: Record<string, unknown>,
): string | undefined {
  if (body.key !== undefined) return "key";
  if (body.password !== undefined) return "password";
  return undefined;
}

/**
 * Core stores authType credential without a credentialId, but such a host
 * cannot connect, so refuse to send one.
 */
export function assertCredentialBound(body: Record<string, unknown>): void {
  if (body.authType === "credential" && !body.credentialId) {
    throw new UsageError(
      "--auth-type credential needs a saved credential: pass --credential-id <id>.",
    );
  }
}

function validateAuthType(value: string): string {
  if (!AUTH_TYPES.includes(value)) {
    throw new UsageError(
      `Invalid --auth-type: "${value}" (expected ${AUTH_TYPES.join(", ")}).`,
    );
  }
  return value;
}

function readKeyFile(path: string): string {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    throw new UsageError(`Could not read key file: ${path}`);
  }
}

function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
