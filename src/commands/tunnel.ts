import type { Command } from "commander";
import { setTimeout as sleep } from "node:timers/promises";
import { createContext } from "../core/context.js";
import type { TermixClient } from "../core/http.js";
import { TermixApiError, UsageError } from "../core/errors.js";
import {
  printList,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";
import { parseId } from "./hosts.js";
import { pluginPath } from "../api/features.js";

type StatusRow = Record<string, unknown>;

const TUNNEL_COLUMNS: Column<StatusRow>[] = [
  { header: "name", value: (t) => t.displayName ?? t.name },
  { header: "status", value: (t) => t.status },
  { header: "source", value: (t) => t.sourcePort },
  { header: "endpoint", value: (t) => joinEndpoint(t) },
  { header: "host", value: (t) => t.sourceHostId, align: "right" },
];

export interface TunnelConnection {
  sourcePort?: number | string;
  endpointPort?: number | string;
  endpointHost?: string;
  endpointIP?: string;
  scope?: string;
  mode?: string;
  tunnelType?: string;
  bindHost?: string;
  targetHost?: string;
  maxRetries?: number;
  retryInterval?: number;
  autoStart?: boolean;
  [key: string]: unknown;
}

export interface HostRecord {
  id: number;
  name?: string;
  ip?: string;
  username?: string;
  pluginSettings?: Record<string, Record<string, unknown> | undefined>;
  /** Where Termix kept tunnels before they became a plugin. */
  tunnelConnections?: TunnelConnection[] | string;
}

/**
 * A saved tunnel's name encodes its own configuration as
 * `hostId::index::hostLabel::sourcePort::endpointHost::endpointPort`, and the
 * server rejects a config that disagrees with its name. The label is the
 * host's name (or user@ip), the same as the web UI, so a tunnel started here
 * shows up as the same tunnel there.
 */
export function buildTunnelName(
  host: HostRecord,
  index: number,
  connection: TunnelConnection,
): string {
  const label = host.name || `${host.username ?? ""}@${host.ip ?? ""}`;
  return [
    host.id,
    index,
    label,
    connection.sourcePort ?? "",
    endpointHostOf(connection),
    connection.endpointPort ?? 0,
  ].join("::");
}

/** Split a saved tunnel's name back into its parts, for `tunnel list`. */
export function parseTunnelName(name: string): Record<string, unknown> {
  const parts = name.split("::");
  if (parts.length !== 6) return {};
  const [hostId, index, label, sourcePort, endpointHost, endpointPort] = parts;
  return {
    sourceHostId: Number(hostId),
    tunnelIndex: Number(index),
    hostLabel: label,
    sourcePort,
    endpointHost,
    endpointPort,
  };
}

function endpointHostOf(connection: TunnelConnection): string {
  return (connection.endpointHost ?? connection.endpointIP ?? "").trim();
}

/** Saved tunnels live in the tunnels plugin's host settings. */
export function parseConnections(
  host: Omit<HostRecord, "id">,
): TunnelConnection[] {
  const raw =
    host.pluginSettings?.tunnels?.tunnelConnections ?? host.tunnelConnections;
  if (Array.isArray(raw)) return raw as TunnelConnection[];
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

function tunnelMode(connection: TunnelConnection): string {
  return connection.mode ?? connection.tunnelType ?? "local";
}

/** What POST /connect takes for a host's saved tunnel, matching the web UI. */
export function connectRequestFor(
  host: HostRecord,
  index: number,
  connection: TunnelConnection,
): Record<string, unknown> {
  const mode = tunnelMode(connection);
  return {
    name: buildTunnelName(host, index, connection),
    sourceHostId: host.id,
    tunnelIndex: index,
    scope: connection.scope ?? "s2s",
    mode,
    tunnelType: mode === "remote" ? "remote" : "local",
    bindHost: connection.bindHost,
    targetHost: connection.targetHost,
    endpointHost: endpointHostOf(connection),
    sourcePort: connection.sourcePort,
    endpointPort: connection.endpointPort ?? 0,
    maxRetries: connection.maxRetries,
    retryInterval: connection.retryInterval,
    autoStart: connection.autoStart,
  };
}

const SETTLED = new Set(["connected", "failed", "disconnected"]);
const START_WAIT_MS = 15_000;

/**
 * POST /connect answers before the tunnel is up, so poll its status for a
 * short while to report how it went.
 */
async function waitForTunnel(
  client: TermixClient,
  name: string,
): Promise<StatusRow | null> {
  const deadline = Date.now() + START_WAIT_MS;
  let last: StatusRow | null = null;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const data = await client.request<{ status?: StatusRow }>({
        method: "GET",
        path: pluginPath("tunnels", `/status/${encodeURIComponent(name)}`),
      });
      last = data?.status ?? null;
    } catch (error) {
      if (error instanceof TermixApiError && error.status === 404) continue;
      throw error;
    }
    if (last && SETTLED.has(String(last.status))) return last;
  }
  return last;
}

async function loadHost(
  client: TermixClient,
  hostId: number,
): Promise<HostRecord> {
  const host = await client.request<Omit<HostRecord, "id">>({
    method: "GET",
    path: `/host/db/host/${hostId}`,
  });
  return { ...host, id: hostId };
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
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        const data = await client.request<Record<string, StatusRow>>({
          method: "GET",
          path: pluginPath("tunnels", "/status"),
        });

        // A map keyed by tunnel name, and the name carries the ports.
        const rows = Object.entries(data ?? {}).map(([name, value]) => ({
          name,
          ...parseTunnelName(name),
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
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        const host = await loadHost(client, hostId);

        const rows = parseConnections(host).map((connection, index) => ({
          index,
          name: buildTunnelName(host, index, connection),
          mode: tunnelMode(connection),
          sourcePort: connection.sourcePort,
          endpointHost: endpointHostOf(connection),
          endpointPort: connection.endpointPort,
        }));

        printList(
          rows,
          [
            { header: "index", value: (r) => r.index, align: "right" },
            { header: "mode", value: (r) => r.mode },
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

        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        const host = await loadHost(client, hostId);

        const connection = parseConnections(host)[index];
        if (!connection) {
          throw new UsageError(
            `Host ${hostId} has no tunnel at index ${index}. Run \`termix tunnel show ${hostId}\`.`,
          );
        }

        const request = connectRequestFor(host, index, connection);
        const name = String(request.name);
        await client.request({
          method: "POST",
          path: pluginPath("tunnels", "/connect"),
          data: request,
        });

        const status = await waitForTunnel(client, name);
        const state = status?.status ? String(status.status) : "connecting";
        if (state === "failed") {
          const reason = status?.reason ? `: ${String(status.reason)}` : ".";
          throw new Error(`Tunnel ${name} failed to start${reason}`);
        }
        printResult(
          state === "connected"
            ? `Started tunnel ${name}.`
            : `Tunnel ${name} is ${state}. Check \`termix tunnel list\`.`,
          { name, index, status: state },
        );
      });
    });

  tunnel
    .command("stop <name>")
    .description("Stop a running tunnel by its full name (see `tunnel list`).")
    .action(async function (this: Command, name: string) {
      await run(async () => {
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        await client.request({
          method: "POST",
          path: pluginPath("tunnels", "/disconnect"),
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
