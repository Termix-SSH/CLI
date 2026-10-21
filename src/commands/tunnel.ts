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
import { registerGatewayCommands } from "./gateway.js";

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

/** Tunnels saved before plugin 1.2.0 sit in the host's plugin settings. */
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

function parseIndex(value: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    throw new UsageError(
      `Invalid tunnel index: "${value}" (expected a non-negative integer).`,
    );
  }
  return index;
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

/**
 * A host's saved tunnels. Tunnels plugin 1.2.0 keeps them in its own table
 * and serves them at /saved; older plugins keep them in the host settings.
 */
async function loadConnections(
  client: TermixClient,
  host: HostRecord,
): Promise<TunnelConnection[]> {
  try {
    const saved = await client.request<
      Array<{ hostId: number; connections?: TunnelConnection[] }>
    >({ method: "GET", path: pluginPath("tunnels", "/saved") });
    if (Array.isArray(saved)) {
      return saved.find((entry) => entry.hostId === host.id)?.connections ?? [];
    }
  } catch (error) {
    if (!(error instanceof TermixApiError && error.status === 404)) throw error;
  }
  return parseConnections(host);
}

/** Replaces a host's saved tunnels. Needs tunnels plugin 1.2.0 or newer. */
async function saveConnections(
  client: TermixClient,
  hostId: number,
  connections: TunnelConnection[],
): Promise<void> {
  try {
    await client.request({
      method: "PUT",
      path: pluginPath("tunnels", `/saved/${hostId}`),
      data: { connections },
    });
  } catch (error) {
    if (error instanceof TermixApiError && error.status === 404) {
      throw new Error(
        "This server's Tunnels plugin is older than 1.2.0, so tunnels can't be changed from the CLI. Update the plugin.",
      );
    }
    throw error;
  }
}

export interface TunnelOptions {
  mode?: string;
  sourcePort?: string;
  endpointHost?: string;
  endpointPort?: string;
  bindHost?: string;
  maxRetries?: string;
  retryInterval?: string;
  autoStart?: boolean;
}

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`Invalid ${flag}: "${value}" (expected 1-65535).`);
  }
  return port;
}

function parseCount(value: string, flag: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new UsageError(
      `Invalid ${flag}: "${value}" (expected a whole number).`,
    );
  }
  return count;
}

/**
 * A saved tunnel from the command's options. With a base (an edit), only the
 * given options change.
 */
export function buildConnection(
  opts: TunnelOptions,
  base?: TunnelConnection,
): TunnelConnection {
  const next: TunnelConnection = base
    ? { ...base }
    : {
        scope: "s2s",
        mode: "local",
        bindHost: "127.0.0.1",
        maxRetries: 3,
        retryInterval: 10,
        autoStart: false,
      };

  if (opts.mode !== undefined) {
    if (!["local", "remote", "dynamic"].includes(opts.mode)) {
      throw new UsageError(
        `Invalid --mode: "${opts.mode}" (expected local, remote or dynamic).`,
      );
    }
    next.mode = opts.mode;
    next.tunnelType = opts.mode === "remote" ? "remote" : "local";
  }
  if (opts.sourcePort !== undefined) {
    next.sourcePort = parsePort(opts.sourcePort, "--source-port");
  }
  if (opts.endpointHost !== undefined) next.endpointHost = opts.endpointHost;
  if (opts.endpointPort !== undefined) {
    next.endpointPort = parsePort(opts.endpointPort, "--endpoint-port");
  }
  if (opts.bindHost !== undefined) next.bindHost = opts.bindHost;
  if (opts.maxRetries !== undefined) {
    next.maxRetries = parseCount(opts.maxRetries, "--max-retries");
  }
  if (opts.retryInterval !== undefined) {
    next.retryInterval = parseCount(opts.retryInterval, "--retry-interval");
  }
  if (opts.autoStart !== undefined) next.autoStart = opts.autoStart;

  if (next.sourcePort === undefined) {
    throw new UsageError("A tunnel needs --source-port.");
  }
  if (tunnelMode(next) !== "dynamic" && next.endpointPort === undefined) {
    throw new UsageError(
      "A tunnel needs --endpoint-port unless it is dynamic.",
    );
  }
  return next;
}

function withTunnelOptions(command: Command): Command {
  return command
    .option("--mode <mode>", "local, remote or dynamic")
    .option("--source-port <port>", "Port the tunnel listens on")
    .option("--endpoint-host <host>", "Where the tunnel goes")
    .option("--endpoint-port <port>", "Port on the endpoint")
    .option("--bind-host <address>", "Address the tunnel listens on")
    .option("--max-retries <count>", "How many times to retry")
    .option("--retry-interval <seconds>", "Seconds between retries")
    .option("--auto-start", "Start the tunnel when Termix starts")
    .option("--no-auto-start", "Do not start it when Termix starts");
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

        const rows = (await loadConnections(client, host)).map(
          (connection, index) => ({
            index,
            name: buildTunnelName(host, index, connection),
            mode: tunnelMode(connection),
            sourcePort: connection.sourcePort,
            endpointHost: endpointHostOf(connection),
            endpointPort: connection.endpointPort,
          }),
        );

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

        const connection = (await loadConnections(client, host))[index];
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

  withTunnelOptions(
    tunnel
      .command("add <hostId>")
      .description(
        "Add a tunnel to a host. Tunnels must be turned on for the host.",
      ),
  ).action(async function (
    this: Command,
    hostIdArg: string,
    opts: TunnelOptions,
  ) {
    await run(async () => {
      const hostId = parseId(hostIdArg);
      const connection = buildConnection(opts);
      const { client, requireFeature } = await createContext(this);
      await requireFeature("tunnels");
      const host = await loadHost(client, hostId);
      if (host.pluginSettings?.tunnels?.enableTunnel !== true) {
        throw new UsageError(
          `Tunnels are off for host ${hostId}. Turn on Enable Tunneling for it first.`,
        );
      }
      const connections = await loadConnections(client, host);
      await saveConnections(client, hostId, [...connections, connection]);
      const index = connections.length;
      printResult(`Added tunnel ${index} to host ${hostId}.`, {
        hostId,
        index,
      });
    });
  });

  withTunnelOptions(
    tunnel
      .command("edit <hostId> <index>")
      .description("Change a tunnel. Only the options you give are changed."),
  ).action(async function (
    this: Command,
    hostIdArg: string,
    indexArg: string,
    opts: TunnelOptions,
  ) {
    await run(async () => {
      const hostId = parseId(hostIdArg);
      const index = parseIndex(indexArg);
      const { client, requireFeature } = await createContext(this);
      await requireFeature("tunnels");
      const host = await loadHost(client, hostId);
      const connections = await loadConnections(client, host);
      const current = connections[index];
      if (!current) {
        throw new UsageError(
          `Host ${hostId} has no tunnel at index ${index}. Run \`termix tunnel show ${hostId}\`.`,
        );
      }
      const next = connections.map((c, i) =>
        i === index ? buildConnection(opts, current) : c,
      );
      await saveConnections(client, hostId, next);
      printResult(`Changed tunnel ${index} on host ${hostId}.`, {
        hostId,
        index,
      });
    });
  });

  tunnel
    .command("remove <hostId> <index>")
    .description("Delete a tunnel from a host.")
    .action(async function (
      this: Command,
      hostIdArg: string,
      indexArg: string,
    ) {
      await run(async () => {
        const hostId = parseId(hostIdArg);
        const index = parseIndex(indexArg);
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        const host = await loadHost(client, hostId);
        const connections = await loadConnections(client, host);
        if (!connections[index]) {
          throw new UsageError(
            `Host ${hostId} has no tunnel at index ${index}. Run \`termix tunnel show ${hostId}\`.`,
          );
        }
        await saveConnections(
          client,
          hostId,
          connections.filter((_, i) => i !== index),
        );
        printResult(`Removed tunnel ${index} from host ${hostId}.`, {
          hostId,
          index,
        });
      });
    });

  registerGatewayCommands(tunnel);

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
