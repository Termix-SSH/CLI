import fs from "node:fs";
import type { Command } from "commander";
import { UsageError } from "../core/errors.js";

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
  folder?: string;
  tags?: string;
  enableTerminal?: boolean;
  enableFileManager?: boolean;
  enableDocker?: boolean;
  enableTunnel?: boolean;
}

/** Attach the shared host field options to a command. */
export function addHostFieldOptions(cmd: Command): Command {
  return cmd
    .option("--name <name>", "Display name (defaults to user@ip)")
    .option("--ip <ip>", "Hostname or IP address")
    .option("--port <port>", "SSH port (default 22)")
    .option("--username <username>", "SSH username")
    .option("--auth-type <type>", "Authentication type: password | key")
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
      "Use a saved shared credential instead of inline secrets",
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
  if (opts.authType !== undefined)
    body.authType = validateAuthType(opts.authType);

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
    const id = Number(opts.credentialId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new UsageError(`Invalid --credential-id: "${opts.credentialId}".`);
    }
    body.credentialId = id;
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

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new UsageError(`Invalid port: "${value}".`);
  }
  return port;
}

function validateAuthType(value: string): string {
  if (value !== "password" && value !== "key") {
    throw new UsageError(
      `Invalid --auth-type: "${value}" (expected password or key).`,
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
