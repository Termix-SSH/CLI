import fs from "node:fs";
import type { Command } from "commander";

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
    .option("--password <password>", "Password (authType=password)")
    .option("--key-file <path>", "Path to a private key file (authType=key)")
    .option("--key-password <passphrase>", "Passphrase for the private key")
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
 * Build the request body from the shared options. Only provided fields are
 * included, so `hosts update` performs a partial update (thin pass-through).
 * `connectionType: "ssh"` is always set, mirroring the web UI and MCP server.
 */
export function buildHostPayload(opts: HostFieldOpts): Record<string, unknown> {
  const body: Record<string, unknown> = { connectionType: "ssh" };

  if (opts.name !== undefined) body.name = opts.name;
  if (opts.ip !== undefined) body.ip = opts.ip;
  if (opts.port !== undefined) body.port = parsePort(opts.port);
  if (opts.username !== undefined) body.username = opts.username;
  if (opts.authType !== undefined)
    body.authType = validateAuthType(opts.authType);
  if (opts.password !== undefined) body.password = opts.password;
  if (opts.keyFile !== undefined) body.key = readKeyFile(opts.keyFile);
  if (opts.keyPassword !== undefined) body.keyPassword = opts.keyPassword;
  if (opts.credentialId !== undefined) {
    const id = Number(opts.credentialId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid --credential-id: "${opts.credentialId}".`);
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
    throw new Error(`Invalid port: "${value}".`);
  }
  return port;
}

function validateAuthType(value: string): string {
  if (value !== "password" && value !== "key") {
    throw new Error(`Invalid --auth-type: "${value}" (expected password|key).`);
  }
  return value;
}

function readKeyFile(path: string): string {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    throw new Error(`Could not read key file: ${path}`);
  }
}

function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
