import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { UsageError } from "../core/errors.js";
import { printList, run, type Column } from "../core/output/index.js";

type Row = Record<string, unknown>;

const AUDIT_COLUMNS: Column<Row>[] = [
  { header: "time", value: (r) => r.createdAt ?? r.timestamp },
  { header: "user", value: (r) => r.username ?? r.userId },
  { header: "action", value: (r) => r.action },
  { header: "resource", value: (r) => r.resourceName ?? r.resourceType },
  { header: "ok", value: (r) => r.success },
];

const USER_COLUMNS: Column<Row>[] = [
  // The users endpoint returns userId rather than id.
  { header: "id", value: (u) => u.userId ?? u.id },
  { header: "username", value: (u) => u.username },
  { header: "admin", value: (u) => u.is_admin ?? u.isAdmin },
  { header: "oidc", value: (u) => u.is_oidc ?? u.isOidc },
  { header: "totp", value: (u) => u.totp_enabled ?? u.totpEnabled },
  { header: "unlocked", value: (u) => u.data_unlocked },
];

/**
 * Admin and audit commands. These endpoints are gated server-side, so a
 * non-admin account receives a clean permission error (exit code 4).
 */
export function registerAdminCommands(program: Command): void {
  program
    .command("audit-logs")
    .description("Fetch audit-log entries (admin only).")
    .option("--limit <n>", "Maximum number of entries")
    .option("--action <action>", "Filter by action")
    .option("--user <userId>", "Filter by user id")
    .action(async function (
      this: Command,
      opts: { limit?: string; action?: string; user?: string },
    ) {
      await run(async () => {
        const { client } = await createContext(this);
        const params: Record<string, unknown> = {};
        if (opts.limit) params.limit = parsePositive(opts.limit, "--limit");
        if (opts.action) params.action = opts.action;
        if (opts.user) params.userId = opts.user;

        const data = await client.request<Row[] | { logs?: Row[] }>({
          method: "GET",
          path: "/audit-logs",
          params: Object.keys(params).length ? params : undefined,
        });
        printList(toRows(data, "logs"), AUDIT_COLUMNS, { quietField: "id" });
      });
    });

  const users = program
    .command("users")
    .description("Inspect Termix user accounts.");

  users
    .command("list", { isDefault: true })
    .description("List user accounts (admin only).")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const data = await client.request<Row[] | { users?: Row[] }>({
          method: "GET",
          path: "/users/list",
        });
        printList(toRows(data, "users"), USER_COLUMNS, {
          quietField: "userId",
        });
      });
    });
}

/** Accept either a bare array or an envelope like `{ logs: [...] }`. */
function toRows(data: unknown, key: string): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    const inner = (data as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as Row[];
  }
  return [];
}

function parsePositive(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(
      `Invalid ${label}: "${value}" (expected a positive integer).`,
    );
  }
  return n;
}
