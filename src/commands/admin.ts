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
  { header: "state", value: (u) => userState(u) },
];

const INVITE_COLUMNS: Column<Row>[] = [
  { header: "id", value: (r) => r.id },
  { header: "note", value: (r) => r.note },
  { header: "state", value: (r) => r.state },
  { header: "uses", value: (r) => `${r.uses}/${r.maxUses}` },
  { header: "admin", value: (r) => r.makeAdmin },
  { header: "expires", value: (r) => r.expiresAt },
];

const ACCESS_COLUMNS: Column<Row>[] = [
  { header: "kind", value: (r) => r.kind },
  { header: "target", value: (r) => r.targetName },
  {
    header: "to",
    value: (r) => r.granteeUsername ?? `role:${r.granteeRoleName}`,
  },
  { header: "level", value: (r) => r.permissionLevel },
  { header: "owner", value: (r) => r.ownerUsername },
  { header: "by", value: (r) => r.grantedByUsername },
  { header: "expires", value: (r) => r.expiresAt },
];

const USER_STATES = ["active", "disabled", "pending"];
const ACCESS_KINDS = ["host", "folder", "credential"];

export function userState(u: Row): string {
  if (!u.disabled) return "active";
  return u.disabled_reason === "pending_approval" ? "pending" : "disabled";
}

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
    .option("--status <state>", "Only active, disabled or pending accounts")
    .action(async function (this: Command, opts: { status?: string }) {
      await run(async () => {
        if (opts.status && !USER_STATES.includes(opts.status)) {
          throw new UsageError(
            `Invalid --status: "${opts.status}" (expected ${USER_STATES.join(", ")}).`,
          );
        }
        const { client } = await createContext(this);
        const data = await client.request<Row[] | { users?: Row[] }>({
          method: "GET",
          path: "/users/list",
          params: opts.status ? { status: opts.status } : undefined,
        });
        printList(toRows(data, "users"), USER_COLUMNS, {
          quietField: "userId",
        });
      });
    });

  users
    .command("disable <userId>")
    .description(
      "Turn an account off: sign it out everywhere and block its logins and API keys.",
    )
    .action(async function (this: Command, userId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        await client.request({
          method: "POST",
          path: `/users/admin/${encodeURIComponent(userId)}/disable`,
        });
        printResult(`Turned off ${userId}`, { id: userId });
      });
    });

  users
    .command("enable <userId>")
    .description(
      "Turn an account back on, or approve one waiting for approval.",
    )
    .action(async function (this: Command, userId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        await client.request({
          method: "POST",
          path: `/users/admin/${encodeURIComponent(userId)}/enable`,
        });
        printResult(`Turned on ${userId}`, { id: userId });
      });
    });

  const invites = users
    .command("invites")
    .description("Invite links that let someone make an account.");

  invites
    .command("list", { isDefault: true })
    .description("List invite links.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const data = await client.request<{ invites?: Row[] }>({
          method: "GET",
          path: "/users/invites",
        });
        printList(toRows(data, "invites"), INVITE_COLUMNS, {
          quietField: "id",
        });
      });
    });

  invites
    .command("create")
    .description("Make an invite link. The token is shown only once.")
    .option("--note <text>", "Who the link is for")
    .option("--role <roleId>", "Role id the new account gets", collect, [])
    .option("--uses <n>", "How many accounts the link can make", "1")
    .option("--hours <n>", "Hours until the link ends", "72")
    .option("--admin", "Make the new account an admin")
    .action(async function (
      this: Command,
      opts: {
        note?: string;
        role: string[];
        uses: string;
        hours: string;
        admin?: boolean;
      },
    ) {
      await run(async () => {
        const { client } = await createContext(this);
        const created = await client.request<Row>({
          method: "POST",
          path: "/users/invites",
          data: {
            note: opts.note,
            roleIds: opts.role.map((id) => parsePositive(id, "--role")),
            maxUses: parsePositive(opts.uses, "--uses"),
            expiresInHours: parsePositive(opts.hours, "--hours"),
            makeAdmin: !!opts.admin,
          },
        });
        printRecord(created, { quietField: "token" });
      });
    });

  invites
    .command("revoke <id>")
    .description("Revoke an invite link.")
    .action(async function (this: Command, id: string) {
      await run(async () => {
        const { client } = await createContext(this);
        await client.request({
          method: "DELETE",
          path: `/users/invites/${encodeURIComponent(id)}`,
        });
        printResult(`Revoked invite ${id}`, { id });
      });
    });

  program
    .command("access-review")
    .description("List every host, folder and credential share (admin only).")
    .option("--kind <kind>", "Only host, folder or credential shares")
    .option("--user <userId>", "Shares this user has or owns")
    .option("--role <roleId>", "Shares given to this role")
    .option("--csv", "Print the whole list as CSV")
    .action(async function (
      this: Command,
      opts: { kind?: string; user?: string; role?: string; csv?: boolean },
    ) {
      await run(async () => {
        if (opts.kind && !ACCESS_KINDS.includes(opts.kind)) {
          throw new UsageError(
            `Invalid --kind: "${opts.kind}" (expected ${ACCESS_KINDS.join(", ")}).`,
          );
        }
        const { client } = await createContext(this);
        const params: Record<string, unknown> = { limit: 500 };
        if (opts.kind) params.kind = opts.kind;
        if (opts.user) params.userId = opts.user;
        if (opts.role) params.roleId = parsePositive(opts.role, "--role");
        if (opts.csv) {
          const text = await client.request<string>({
            method: "GET",
            path: "/rbac/access-review",
            params: { ...params, format: "csv" },
            responseType: "text",
          });
          process.stdout.write(`${String(text)}\n`);
          return;
        }
        const data = await client.request<{ shares?: Row[] }>({
          method: "GET",
          path: "/rbac/access-review",
          params,
        });
        printList(toRows(data, "shares"), ACCESS_COLUMNS, {
          quietField: "accessId",
        });
      });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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
