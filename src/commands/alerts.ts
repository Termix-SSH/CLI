import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { UsageError } from "../core/errors.js";
import {
  printList,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";
import { pluginPath } from "../api/features.js";

type AlertRow = Record<string, unknown>;

const ALERT_COLUMNS: Column<AlertRow>[] = [
  { header: "id", value: (a) => a.id, align: "right" },
  { header: "severity", value: (a) => a.severity ?? a.level },
  { header: "source", value: (a) => a.source },
  { header: "title", value: (a) => a.title ?? a.message },
  { header: "created", value: (a) => a.createdAt },
  { header: "read", value: (a) => Boolean(a.readAt) },
];

/** The alerts inbox answers `{ items, unread }`. */
export function toAlertRows(data: unknown): AlertRow[] {
  if (Array.isArray(data)) return data as AlertRow[];
  if (!data || typeof data !== "object") return [];
  const record = data as { items?: unknown; alerts?: unknown };
  if (Array.isArray(record.items)) return record.items as AlertRow[];
  if (Array.isArray(record.alerts)) return record.alerts as AlertRow[];
  return [];
}

function parseAlertId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new UsageError(
      `Invalid alert id: "${value}" (expected a positive integer).`,
    );
  }
  return id;
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new UsageError(`Invalid --limit: "${value}".`);
  }
  return limit;
}

export function registerAlertCommands(program: Command): void {
  const alerts = program
    .command("alerts")
    .description("List and dismiss Termix alerts.");

  alerts
    .command("list", { isDefault: true })
    .description("List alerts in your inbox, newest first.")
    .option("--unread", "Only unread alerts")
    .option("--limit <n>", "How many to show (server default 50)", parseLimit)
    .action(async function (
      this: Command,
      opts: { unread?: boolean; limit?: number },
    ) {
      await run(async () => {
        const { client, requireFeature } = await createContext(this);
        await requireFeature("alerts");
        const data = await client.request<unknown>({
          method: "GET",
          path: pluginPath("alerts", "/items"),
          params: {
            ...(opts.unread ? { unread: true } : {}),
            ...(opts.limit ? { limit: opts.limit } : {}),
          },
        });
        printList(toAlertRows(data), ALERT_COLUMNS);
      });
    });

  const markRead = (read: boolean) =>
    async function (this: Command, alertId: string) {
      await run(async () => {
        const id = parseAlertId(alertId);
        const { client, requireFeature } = await createContext(this);
        await requireFeature("alerts");
        await client.request({
          method: "POST",
          path: pluginPath("alerts", "/items/read"),
          data: { ids: [id], read },
        });
        printResult(read ? `Dismissed alert ${id}.` : `Restored alert ${id}.`, {
          id,
        });
      });
    };

  alerts
    .command("dismiss <alertId>")
    .description("Mark an alert as read.")
    .action(markRead(true));

  alerts
    .command("undismiss <alertId>")
    .description("Mark an alert as unread again.")
    .action(markRead(false));

  alerts
    .command("delete <alertId>")
    .description("Delete an alert from your inbox for good.")
    .action(async function (this: Command, alertId: string) {
      await run(async () => {
        const id = parseAlertId(alertId);
        const { client, requireFeature } = await createContext(this);
        await requireFeature("alerts");
        await client.request({
          method: "DELETE",
          path: pluginPath("alerts", `/items/${id}`),
        });
        printResult(`Deleted alert ${id}.`, { id });
      });
    });
}
