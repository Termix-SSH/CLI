import type { Command } from "commander";
import { createContext } from "../core/context.js";
import {
  printList,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";

type AlertRow = Record<string, unknown>;

const ALERT_COLUMNS: Column<AlertRow>[] = [
  { header: "id", value: (a) => a.id },
  { header: "severity", value: (a) => a.severity ?? a.level },
  { header: "title", value: (a) => a.title ?? a.message },
  { header: "created", value: (a) => a.createdAt },
];

/**
 * The alerts endpoint answers with an envelope, and has been seen wrapped in
 * an array as well, so unwrap either shape down to the alert records.
 */
export function toAlertRows(data: unknown): AlertRow[] {
  const unwrapped = Array.isArray(data) ? data[0] : data;
  if (!unwrapped || typeof unwrapped !== "object") return [];

  const alerts = (unwrapped as { alerts?: unknown }).alerts;
  if (Array.isArray(alerts)) return alerts as AlertRow[];

  // A bare array of alerts, with no envelope.
  if (Array.isArray(data) && data.every((d) => d && !("alerts" in d))) {
    return data as AlertRow[];
  }
  return [];
}

export function registerAlertCommands(program: Command): void {
  const alerts = program
    .command("alerts")
    .description("List and dismiss Termix alerts.");

  alerts
    .command("list", { isDefault: true })
    .description("List active alerts and notifications.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const data = await client.request<unknown>({
          method: "GET",
          path: "/alerts",
        });
        printList(toAlertRows(data), ALERT_COLUMNS);
      });
    });

  alerts
    .command("dismiss <alertId>")
    .description("Dismiss an alert.")
    // Alert ids can start with "-", which would parse as an unknown option.
    .allowUnknownOption()
    .action(async function (this: Command, alertId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        await client.request({
          method: "POST",
          path: "/alerts/dismiss",
          data: { alertId },
        });
        printResult(`Dismissed alert ${alertId}.`, { id: alertId });
      });
    });

  alerts
    .command("undismiss <alertId>")
    .description("Restore a previously dismissed alert.")
    .allowUnknownOption()
    .action(async function (this: Command, alertId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        await client.request({
          method: "DELETE",
          path: "/alerts/dismiss",
          params: { alertId },
        });
        printResult(`Restored alert ${alertId}.`, { id: alertId });
      });
    });
}
