import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { CLI_VERSION } from "../version.js";
import {
  printList,
  printRecord,
  run,
  type Column,
} from "../core/output/index.js";
import { parseId } from "./hosts.js";

type Row = Record<string, unknown>;

const STATUS_COLUMNS: Column<Row>[] = [
  { header: "id", value: (r) => r.id ?? r.hostId, align: "right" },
  { header: "status", value: (r) => r.status },
  { header: "reachable", value: (r) => r.online ?? r.reachable },
  { header: "checked", value: (r) => r.lastChecked ?? r.updatedAt },
];

export function registerMiscCommands(program: Command): void {
  program
    .command("version")
    .description("Show the CLI version and the server's health and version.")
    .action(async function (this: Command) {
      await run(async () => {
        const { config, client } = await createContext(this);

        // /health is unauthenticated, so it is the honest reachability probe.
        // A failure here is fatal: reporting "ok" for a server we cannot reach
        // would make `termix version` useless in a health check.
        const health = await client.request<{ status?: string }>({
          method: "GET",
          path: "/health",
          noAuth: true,
        });

        // /version requires auth, so treat it as optional: an unauthenticated
        // caller should still get a useful answer from `termix version`.
        const server = await client
          .request<Row>({
            method: "GET",
            path: "/version",
            params: { checkRemote: false },
          })
          .catch(() => null);

        printRecord({
          cli: CLI_VERSION,
          url: config.url,
          health: health?.status ?? "unknown",
          server: server?.localVersion ?? null,
          serverStatus: server?.status ?? null,
        });
      });
    });

  program
    .command("status [hostId]")
    .description("Show online/offline status for all hosts, or one host.")
    .action(async function (this: Command, hostId?: string) {
      await run(async () => {
        const { client } = await createContext(this);
        const path = hostId ? `/status/${parseId(hostId)}` : "/status";
        const data = await client.request<Row[] | Row>({
          method: "GET",
          path,
          // Host status is served by the metrics app, which sits behind the
          // same origin in a normal deployment but on its own port otherwise.
          service: "metrics",
        });

        if (Array.isArray(data)) {
          printList(data, STATUS_COLUMNS);
        } else {
          printRecord(data);
        }
      });
    });
}
