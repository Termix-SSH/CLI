import fs from "node:fs";
import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { UsageError } from "../core/errors.js";
import {
  printList,
  printRecord,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";
import { parseId } from "./hosts.js";

/**
 * Non-secret credential fields safe to print.
 *
 * This is load-bearing, not defence in depth: unlike the host endpoints,
 * GET /credentials/:id returns the plaintext password, key and keyPassword,
 * so anything outside this allowlist would print a secret to stdout.
 */
const SAFE_CREDENTIAL_FIELDS = [
  "id",
  "name",
  "description",
  "folder",
  "tags",
  "authType",
  "username",
  "publicKey",
  "hasCertPublicKey",
  "keyType",
  "detectedKeyType",
  "usageCount",
  "lastUsed",
  "createdAt",
  "updatedAt",
  "hasKey",
  "hasKeyPassword",
] as const;

export function sanitiseCredential(
  cred: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SAFE_CREDENTIAL_FIELDS) {
    if (key in cred) out[key] = cred[key];
  }
  return out;
}

type CredentialRow = Record<string, unknown>;

const CREDENTIAL_COLUMNS: Column<CredentialRow>[] = [
  { header: "id", value: (c) => c.id, align: "right" },
  { header: "name", value: (c) => c.name },
  { header: "auth", value: (c) => c.authType },
  { header: "username", value: (c) => c.username },
  { header: "folder", value: (c) => c.folder },
  { header: "used", value: (c) => c.usageCount, align: "right" },
];

interface CredentialOpts {
  name?: string;
  description?: string;
  folder?: string;
  tags?: string;
  authType?: string;
  username?: string;
  password?: string;
  keyFile?: string;
  keyPassword?: string;
}

function addCredentialOptions(cmd: Command): Command {
  return cmd
    .option("--name <name>", "Credential name")
    .option("--description <text>", "Description")
    .option("--folder <folder>", "Folder")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--auth-type <type>", "Authentication type: password | key")
    .option("--username <username>", "SSH username")
    .option("--key-file <path>", "Path to a private key file (authType=key)")
    .option(
      "--password <password>",
      "Password. Prefer TERMIX_CREDENTIAL_PASSWORD: argv is visible to other processes",
    )
    .option(
      "--key-password <passphrase>",
      "Key passphrase. Prefer TERMIX_CREDENTIAL_KEY_PASSWORD",
    );
}

/**
 * Read a secret, preferring the environment over argv.
 *
 * Command-line arguments show up in `ps` output and shell history, so the env
 * var is the documented path and passing the flag warns.
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

function buildCredentialPayload(opts: CredentialOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.folder !== undefined) body.folder = opts.folder;
  if (opts.tags !== undefined) {
    body.tags = opts.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  if (opts.authType !== undefined) {
    if (opts.authType !== "password" && opts.authType !== "key") {
      throw new UsageError(
        `Invalid --auth-type: "${opts.authType}" (expected password or key).`,
      );
    }
    body.authType = opts.authType;
  }
  if (opts.username !== undefined) body.username = opts.username;

  const password = resolveSecret(
    opts.password,
    "TERMIX_CREDENTIAL_PASSWORD",
    "--password",
  );
  if (password !== undefined) body.password = password;

  const keyPassword = resolveSecret(
    opts.keyPassword,
    "TERMIX_CREDENTIAL_KEY_PASSWORD",
    "--key-password",
  );
  if (keyPassword !== undefined) body.keyPassword = keyPassword;

  if (opts.keyFile !== undefined) {
    try {
      body.key = fs.readFileSync(opts.keyFile, "utf8");
    } catch {
      throw new UsageError(`Could not read key file: ${opts.keyFile}`);
    }
  }
  return body;
}

export function registerCredentialCommands(program: Command): void {
  const credentials = program
    .command("credentials")
    .description("Manage saved SSH credentials. Secrets are never printed.");

  credentials
    .command("list", { isDefault: true })
    .description("List saved credentials.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const creds = await client.request<CredentialRow[]>({
          method: "GET",
          path: "/credentials",
        });
        printList(creds.map(sanitiseCredential), CREDENTIAL_COLUMNS);
      });
    });

  credentials
    .command("get <credentialId>")
    .description("Show one credential's metadata.")
    .action(async function (this: Command, credentialId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        const cred = await client.request<CredentialRow>({
          method: "GET",
          path: `/credentials/${parseId(credentialId)}`,
        });
        printRecord(sanitiseCredential(cred));
      });
    });

  addCredentialOptions(
    credentials
      .command("create")
      .description(
        "Create a saved credential. --name, --auth-type and --username are required.",
      ),
  ).action(async function (this: Command, opts: CredentialOpts) {
    await run(async () => {
      if (!opts.name || !opts.authType || !opts.username) {
        throw new UsageError(
          "`credentials create` requires --name, --auth-type and --username.",
        );
      }
      const { client } = await createContext(this);
      const created = await client.request<CredentialRow>({
        method: "POST",
        path: "/credentials",
        data: buildCredentialPayload(opts),
      });
      printResult(`Created credential ${created.id}.`, {
        id: created.id,
        name: created.name,
      });
    });
  });

  addCredentialOptions(
    credentials
      .command("update <credentialId>")
      .description(
        "Update a saved credential. Only the fields you pass change.",
      ),
  ).action(async function (
    this: Command,
    credentialId: string,
    opts: CredentialOpts,
  ) {
    await run(async () => {
      const id = parseId(credentialId);
      const payload = buildCredentialPayload(opts);
      if (Object.keys(payload).length === 0) {
        throw new UsageError(
          "`credentials update` needs at least one field to change.",
        );
      }
      const { client } = await createContext(this);
      const updated = await client.request<CredentialRow>({
        method: "PUT",
        path: `/credentials/${id}`,
        data: payload,
      });
      printResult(`Updated credential ${id}.`, {
        id: updated.id ?? id,
        name: updated.name ?? payload.name,
      });
    });
  });

  credentials
    .command("delete <credentialId>")
    .description("Delete a saved credential.")
    .action(async function (this: Command, credentialId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        const id = parseId(credentialId);
        await client.request({
          method: "DELETE",
          path: `/credentials/${id}`,
        });
        printResult(`Deleted credential ${id}.`, { id });
      });
    });
}
