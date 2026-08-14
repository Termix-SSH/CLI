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
  { header: "name", value: (r) => r.name },
  { header: "status", value: (r) => r.status },
  { header: "checked", value: (r) => r.lastChecked ?? r.updatedAt },
];

/**
 * The status endpoint returns a map keyed by host id rather than an array,
 * so turn it into rows. An array is still accepted in case that changes.
 */
export function toStatusRows(data: unknown): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (!data || typeof data !== "object") return [];
  return Object.entries(data as Record<string, Row>).map(([id, value]) => ({
    id,
    ...value,
  }));
}

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

        // A single host returns one record.
        if (hostId) {
          printRecord({ id: Number(hostId), ...(data as Row) });
          return;
        }

        // Listing every host returns a map keyed by host id, not an array.
        const rows = toStatusRows(data);

        // The map carries only ids, so pair them with names to make the table
        // readable. A failure here must not lose the status output.
        const names = await client
          .request<Array<{ id?: number; name?: string }>>({
            method: "GET",
            path: "/host/db/host",
          })
          .then((hosts) => new Map(hosts.map((h) => [h.id, h.name])))
          .catch(() => new Map<number | undefined, string | undefined>());

        printList(
          rows.map((row) => ({ ...row, name: names.get(Number(row.id)) })),
          STATUS_COLUMNS,
        );
      });
    });
}
