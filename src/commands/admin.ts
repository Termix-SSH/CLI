import type { Command } from "commander";
import { resolveConfig } from "../core/config.js";
import { TermixClient } from "../core/http.js";
import { printJson, run } from "../core/output.js";
import { parseId } from "./hosts.js";

/**
 * Admin/read commands. These endpoints are gated server-side to admin accounts;
 * a non-admin account receives a clean permission error (HTTP 403).
 */
export function registerAdminCommands(program: Command): void {
  program
    .command("audit-logs")
    .description(
      "Fetch audit-log entries (admin only; non-admin accounts get a 403).",
    )
    .option("--limit <n>", "Maximum number of entries")
    .option("--action <action>", "Filter by action")
    .option("--user <userId>", "Filter by user id")
    .action(async (opts: { limit?: string; action?: string; user?: string }) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const params: Record<string, unknown> = {};
        if (opts.limit) params.limit = parseId(opts.limit, "--limit");
        if (opts.action) params.action = opts.action;
        if (opts.user) params.userId = opts.user;
        const data = await client.request({
          method: "GET",
          path: "/audit-logs",
          params: Object.keys(params).length ? params : undefined,
        });
        printJson(data);
      }),
    );

  const users = program
    .command("users")
    .description("Inspect Termix user accounts.");

  users
    .command("list", { isDefault: true })
    .description("List user accounts (admin).")
    .action(async () =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const data = await client.request({
          method: "GET",
          path: "/users/list",
        });
        printJson(data);
      }),
    );
}
