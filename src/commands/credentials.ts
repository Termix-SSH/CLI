import fs from "node:fs";
import type { Command } from "commander";
import { resolveConfig } from "../core/config.js";
import { TermixClient } from "../core/http.js";
import { printJson, run } from "../core/output.js";
import { parseId } from "./hosts.js";

/**
 * Non-secret credential fields safe to print, mirroring the allowlist approach
 * used for hosts. This is load-bearing: unlike the hosts endpoints, the
 * backend's GET /credentials/:id returns the plaintext password/key/keyPassword,
 * so printing anything outside this list could leak a secret.
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
    .option("--password <password>", "Password (authType=password)")
    .option("--key-file <path>", "Path to a private key file (authType=key)")
    .option("--key-password <passphrase>", "Passphrase for the private key");
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
      throw new Error(
        `Invalid --auth-type: "${opts.authType}" (expected password|key).`,
      );
    }
    body.authType = opts.authType;
  }
  if (opts.username !== undefined) body.username = opts.username;
  if (opts.password !== undefined) body.password = opts.password;
  if (opts.keyFile !== undefined) {
    try {
      body.key = fs.readFileSync(opts.keyFile, "utf8");
    } catch {
      throw new Error(`Could not read key file: ${opts.keyFile}`);
    }
  }
  if (opts.keyPassword !== undefined) body.keyPassword = opts.keyPassword;
  return body;
}

export function registerCredentialCommands(program: Command): void {
  const credentials = program
    .command("credentials")
    .description(
      "Manage saved SSH credentials. Listing returns metadata only — secrets are never printed.",
    );

  credentials
    .command("list")
    .description("List saved credentials (metadata only).")
    .action(async () =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const creds = await client.request<Array<Record<string, unknown>>>({
          method: "GET",
          path: "/credentials",
        });
        printJson(creds.map(sanitiseCredential));
      }),
    );

  credentials
    .command("get <credentialId>")
    .description("Show one credential's metadata (secrets are not printed).")
    .action(async (credentialId: string) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const cred = await client.request<Record<string, unknown>>({
          method: "GET",
          path: `/credentials/${parseId(credentialId)}`,
        });
        printJson(sanitiseCredential(cred));
      }),
    );

  addCredentialOptions(
    credentials
      .command("create")
      .description(
        "Create a saved SSH credential. --name, --auth-type and --username are required.",
      ),
  ).action(async (opts: CredentialOpts) =>
    run(async () => {
      if (!opts.name || !opts.authType || !opts.username) {
        throw new Error(
          "`credentials create` requires --name, --auth-type and --username.",
        );
      }
      const client = new TermixClient(resolveConfig());
      const created = await client.request<Record<string, unknown>>({
        method: "POST",
        path: "/credentials",
        data: buildCredentialPayload(opts),
      });
      printJson({ id: created.id, name: created.name });
    }),
  );

  addCredentialOptions(
    credentials
      .command("update <credentialId>")
      .description("Update a saved credential (only the fields you pass)."),
  ).action(async (credentialId: string, opts: CredentialOpts) =>
    run(async () => {
      const client = new TermixClient(resolveConfig());
      const updated = await client.request<Record<string, unknown>>({
        method: "PUT",
        path: `/credentials/${parseId(credentialId)}`,
        data: buildCredentialPayload(opts),
      });
      printJson({
        id: updated.id ?? parseId(credentialId),
        name: updated.name,
      });
    }),
  );

  credentials
    .command("delete <credentialId>")
    .description("Delete a saved credential by id.")
    .action(async (credentialId: string) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const data = await client.request({
          method: "DELETE",
          path: `/credentials/${parseId(credentialId)}`,
        });
        printJson(data);
      }),
    );
}
