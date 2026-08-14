import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { UsageError } from "../core/errors.js";
import {
  printList,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";
import { parseId } from "./hosts.js";

type StatusRow = Record<string, unknown>;

const TUNNEL_COLUMNS: Column<StatusRow>[] = [
  { header: "name", value: (t) => t.displayName ?? t.name },
  { header: "status", value: (t) => t.status },
  { header: "source", value: (t) => t.sourcePort },
  { header: "endpoint", value: (t) => joinEndpoint(t) },
  { header: "host", value: (t) => t.sourceHostId, align: "right" },
];

interface TunnelConnection {
  sourcePort?: number | string;
  endpointPort?: number | string;
  endpointHost?: string;
  endpointIP?: string;
  name?: string;
  [key: string]: unknown;
}

interface HostRecord {
  id?: number;
  name?: string;
  ip?: string;
  port?: number;
  username?: string;
  authType?: string;
  credentialId?: number;
  tunnelConnections?: TunnelConnection[] | string;
}

/**
 * Tunnel names encode their own configuration as
 * `hostId::index::name::sourcePort::endpointHost::endpointPort`, and the
 * server rejects a config that disagrees with its name. Building it here keeps
 * the two in step.
 */
function buildTunnelName(
  hostId: number,
  index: number,
  displayName: string,
  sourcePort: string | number,
  endpointHost: string,
  endpointPort: string | number,
): string {
  return [
    hostId,
    index,
    displayName,
    sourcePort,
    endpointHost,
    endpointPort,
  ].join("::");
}

/** tunnelConnections is stored as JSON, and may arrive as a string. */
function parseConnections(host: HostRecord): TunnelConnection[] {
  const raw = host.tunnelConnections;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function registerTunnelCommands(program: Command): void {
  const tunnel = program
    .command("tunnel")
    .description("Manage SSH tunnels configured on your hosts.");

  tunnel
    .command("list", { isDefault: true })
    .description("Show the status of every tunnel.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const data = await client.request<Record<string, StatusRow>>({
          method: "GET",
          path: "/ssh/tunnel/status",
          service: "tunnel",
        });

        // The API returns a map keyed by tunnel name, not an array.
        const rows = Object.entries(data ?? {}).map(([name, value]) => ({
          name,
          ...value,
        }));
        printList(rows, TUNNEL_COLUMNS, { quietField: "name" });
      });
    });

  tunnel
    .command("show <hostId>")
    .description("List the tunnels configured on a host, with their indexes.")
    .action(async function (this: Command, hostIdArg: string) {
      await run(async () => {
        const hostId = parseId(hostIdArg);
        const { client } = await createContext(this);
        const host = await client.request<HostRecord>({
          method: "GET",
          path: `/host/db/host/${hostId}`,
        });

        const rows = parseConnections(host).map((connection, index) => ({
          index,
          name: connection.name ?? `tunnel-${index}`,
          sourcePort: connection.sourcePort,
          endpointHost: connection.endpointHost ?? connection.endpointIP,
          endpointPort: connection.endpointPort,
        }));

        printList(
          rows,
          [
            { header: "index", value: (r) => r.index, align: "right" },
            { header: "name", value: (r) => r.name },
            { header: "source", value: (r) => r.sourcePort, align: "right" },
            { header: "endpoint host", value: (r) => r.endpointHost },
            {
              header: "endpoint port",
              value: (r) => r.endpointPort,
              align: "right",
            },
          ],
          { quietField: "index" },
        );
      });
    });

  tunnel
    .command("start <hostId> <index>")
    .description(
      "Start a tunnel configured on a host. Use `tunnel show` for the index.",
    )
    .action(async function (
      this: Command,
      hostIdArg: string,
      indexArg: string,
    ) {
      await run(async () => {
        const hostId = parseId(hostIdArg);
        const index = Number(indexArg);
        if (!Number.isInteger(index) || index < 0) {
          throw new UsageError(
            `Invalid tunnel index: "${indexArg}" (expected a non-negative integer).`,
          );
        }

        const { client } = await createContext(this);
        const host = await client.request<HostRecord>({
          method: "GET",
          path: `/host/db/host/${hostId}`,
        });

        const connections = parseConnections(host);
        const connection = connections[index];
        if (!connection) {
          throw new UsageError(
            `Host ${hostId} has no tunnel at index ${index}. Run \`termix tunnel show ${hostId}\`.`,
          );
        }
        if (!host.ip || !host.username) {
          throw new UsageError(
            `Host ${hostId} is missing an address or username.`,
          );
        }

        const endpointHost =
          connection.endpointHost ?? connection.endpointIP ?? "";
        const displayName = connection.name ?? `tunnel-${index}`;
        const name = buildTunnelName(
          hostId,
          index,
          displayName,
          connection.sourcePort ?? "",
          endpointHost,
          connection.endpointPort ?? "",
        );

        await client.request({
          method: "POST",
          path: "/ssh/tunnel/connect",
          service: "tunnel",
          data: {
            ...connection,
            name,
            sourceHostId: hostId,
            tunnelIndex: index,
            hostName: host.name,
            sourceIP: host.ip,
            sourceSSHPort: host.port ?? 22,
            sourceUsername: host.username,
            sourceAuthMethod: host.authType,
            sourceCredentialId: host.credentialId,
            endpointHost,
          },
        });

        printResult(`Started tunnel ${displayName}.`, { name, index });
      });
    });

  tunnel
    .command("stop <name>")
    .description("Stop a running tunnel by its full name (see `tunnel list`).")
    .action(async function (this: Command, name: string) {
      await run(async () => {
        const { client } = await createContext(this);
        await client.request({
          method: "POST",
          path: "/ssh/tunnel/disconnect",
          service: "tunnel",
          data: { tunnelName: name },
        });
        printResult(`Stopped tunnel ${name}.`, { name });
      });
    });
}

function joinEndpoint(row: StatusRow): string | undefined {
  const host = row.endpointHost ?? row.endpointIP;
  const port = row.endpointPort;
  if (!host && !port) return undefined;
  return `${String(host ?? "")}:${String(port ?? "")}`;
}
