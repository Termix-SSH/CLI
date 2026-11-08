import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { UsageError } from "../core/errors.js";
import {
  isJsonMode,
  printJson,
  printList,
  printResult,
  printWarning,
  run,
  type Column,
} from "../core/output/index.js";

type KeyRow = Record<string, unknown>;

const KEY_COLUMNS: Column<KeyRow>[] = [
  { header: "id", value: (k) => k.id },
  { header: "name", value: (k) => k.name },
  { header: "user", value: (k) => k.username ?? k.userId },
  { header: "prefix", value: (k) => k.tokenPrefix },
  { header: "active", value: (k) => k.isActive },
  { header: "last used", value: (k) => k.lastUsedAt },
  { header: "expires", value: (k) => k.expiresAt },
];

/**
 * API-key management. Every endpoint here is admin-gated server-side, and keys
 * are scoped to a target user rather than to the admin creating them.
 */
export function registerApiKeyCommands(program: Command): void {
  const keys = program
    .command("api-keys")
    .description("Manage API keys for scripts and automation (admin only).");

  keys
    .command("list", { isDefault: true })
    .description("List API keys.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const data = await client.request<{ apiKeys?: KeyRow[] }>({
          method: "GET",
          path: "/users/api-keys",
        });
        printList(data.apiKeys ?? [], KEY_COLUMNS);
      });
    });

  keys
    .command("create")
    .description(
      "Create an API key for a user. The token is shown once and cannot be retrieved again.",
    )
    .requiredOption("--name <name>", "Human-readable name for the key")
    .requiredOption("--user <userId>", "Id of the user the key acts as")
    .option("--expires-at <date>", "Expiry as an ISO date; omit for no expiry")
    .option(
      "--scope <scope>",
      "Limit the key to actions: actions-read or actions-run. Omit for full access",
    )
    .action(async function (
      this: Command,
      opts: { name: string; user: string; expiresAt?: string; scope?: string },
    ) {
      await run(async () => {
        if (opts.expiresAt && Number.isNaN(Date.parse(opts.expiresAt))) {
          throw new UsageError(
            `Invalid --expires-at: "${opts.expiresAt}" (expected an ISO date).`,
          );
        }

        const scopes = opts.scope ? [scopeOf(opts.scope)] : undefined;
        const { client } = await createContext(this);
        const created = await client.request<KeyRow>({
          method: "POST",
          path: "/users/api-keys",
          data: {
            name: opts.name,
            userId: opts.user,
            ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
            ...(scopes ? { scopes } : {}),
          },
        });

        // The token is only ever returned here, so it goes to stdout as data
        // rather than through printResult, which would hide it in quiet mode.
        if (isJsonMode()) {
          printJson(created);
          return;
        }

        printResult(`Created API key "${created.name}".`, { id: created.id });
        process.stdout.write(`${String(created.token ?? "")}\n`);
        printWarning("Store this token now. It cannot be shown again.");
      });
    });

  keys
    .command("revoke <keyId>")
    .description("Revoke an API key.")
    // Key ids are nanoids, which often start with "-" and would otherwise be
    // parsed as an unknown option.
    .allowUnknownOption()
    .action(async function (this: Command, keyId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        await client.request({
          method: "DELETE",
          path: `/users/api-keys/${encodeURIComponent(keyId)}`,
        });
        printResult(`Revoked API key ${keyId}.`, { id: keyId });
      });
    });
}

/** The scope name the server stores, from the short form the CLI takes. */
export function scopeOf(value: string): string {
  const scopes: Record<string, string> = {
    "actions-read": "operations:read",
    "actions-run": "operations:run",
    "operations:read": "operations:read",
    "operations:run": "operations:run",
  };
  const scope = scopes[value];
  if (!scope) {
    throw new UsageError(
      `Invalid --scope "${value}" (expected actions-read or actions-run).`,
    );
  }
  return scope;
}
