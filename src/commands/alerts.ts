import type { Command } from "commander";
import { resolveConfig } from "../core/config.js";
import { TermixClient } from "../core/http.js";
import { printJson, run } from "../core/output.js";

export function registerAlertCommands(program: Command): void {
  const alerts = program
    .command("alerts")
    .description("List and dismiss Termix alerts.");

  alerts
    .command("list", { isDefault: true })
    .description("List active alerts and notifications.")
    .action(async () =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const data = await client.request({ method: "GET", path: "/alerts" });
        printJson(data);
      }),
    );

  alerts
    .command("dismiss <alertId>")
    .description("Dismiss an alert by id.")
    .action(async (alertId: string) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const data = await client.request({
          method: "POST",
          path: "/alerts/dismiss",
          data: { alertId },
        });
        printJson(data);
      }),
    );

  alerts
    .command("undismiss <alertId>")
    .description("Restore a previously dismissed alert.")
    .action(async (alertId: string) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const data = await client.request({
          method: "DELETE",
          path: "/alerts/dismiss",
          params: { alertId },
        });
        printJson(data);
      }),
    );
}
