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
import { pluginPath } from "../api/features.js";

interface GatewayPort extends Record<string, unknown> {
  id: number;
  proto: string;
  publicPort: number;
  targetHost: string;
  targetPort: number;
  label: string;
  source: string;
  enabled: boolean;
}

interface Gateway extends Record<string, unknown> {
  id: number;
  name: string;
  privateHostId: number;
  publicHostId: number;
  endpoint: string;
  listenPort: number;
  scanEnabled: boolean;
  privateIp: string;
  ports: GatewayPort[];
  status: {
    state: string;
    message: string | null;
    handshakeAge: number | null;
  };
}

const GATEWAY_COLUMNS: Column<Gateway>[] = [
  { header: "id", value: (g) => g.id, align: "right" },
  { header: "name", value: (g) => g.name },
  { header: "state", value: (g) => g.status.state },
  { header: "private host", value: (g) => g.privateHostId, align: "right" },
  { header: "public host", value: (g) => g.publicHostId, align: "right" },
  {
    header: "ports on",
    value: (g) => g.ports.filter((p) => p.enabled).length,
    align: "right",
  },
];

const PORT_COLUMNS: Column<GatewayPort>[] = [
  { header: "id", value: (p) => p.id, align: "right" },
  { header: "public", value: (p) => `${p.proto} ${p.publicPort}` },
  { header: "target", value: (p) => `${p.targetHost || "-"}:${p.targetPort}` },
  { header: "on", value: (p) => (p.enabled ? "yes" : "no") },
  { header: "from", value: (p) => p.source },
  { header: "label", value: (p) => p.label },
];

function gatewayPath(id: number, sub = ""): string {
  return pluginPath("tunnels", `/gateways/${id}${sub}`);
}

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`Invalid ${flag}: "${value}" (expected 1-65535).`);
  }
  return port;
}

export interface PortOptions {
  publicPort?: string;
  targetPort?: string;
  proto?: string;
  targetHost?: string;
  label?: string;
  force?: boolean;
}

/** The body for adding a gateway port. The target port defaults to the public one. */
export function buildPortBody(opts: PortOptions): Record<string, unknown> {
  if (opts.publicPort === undefined) {
    throw new UsageError("A port needs --public-port.");
  }
  const publicPort = parsePort(opts.publicPort, "--public-port");
  const proto = opts.proto ?? "tcp";
  if (!["tcp", "udp", "both"].includes(proto)) {
    throw new UsageError(
      `Invalid --proto: "${proto}" (expected tcp, udp or both).`,
    );
  }
  return {
    proto,
    publicPort,
    targetPort:
      opts.targetPort === undefined
        ? publicPort
        : parsePort(opts.targetPort, "--target-port"),
    targetHost: opts.targetHost ?? "",
    label: opts.label ?? "",
    force: opts.force === true ? true : undefined,
  };
}

/** `termix tunnel gateway ...`: WireGuard gateways from the Tunnels plugin. */
export function registerGatewayCommands(tunnel: Command): void {
  const gateway = tunnel
    .command("gateway")
    .description(
      "Publish services on a private host through a public host over WireGuard.",
    );

  gateway
    .command("list", { isDefault: true })
    .description("List gateways.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        const rows = await client.request<Gateway[]>({
          method: "GET",
          path: pluginPath("tunnels", "/gateways"),
        });
        printList(rows ?? [], GATEWAY_COLUMNS, {
          quietField: "id",
          jsonWrapper: (list) => ({ count: list.length, gateways: list }),
        });
      });
    });

  gateway
    .command("show <gatewayId>")
    .description("Show a gateway's state and ports.")
    .action(async function (this: Command, idArg: string) {
      await run(async () => {
        const id = parseId(idArg);
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        const found = await client.request<Gateway>({
          method: "GET",
          path: gatewayPath(id),
        });
        printList(found.ports ?? [], PORT_COLUMNS, {
          quietField: "id",
          jsonWrapper: () => found,
        });
      });
    });

  gateway
    .command("create")
    .description("Create a gateway and set it up on both hosts.")
    .requiredOption("--name <name>", "Gateway name")
    .requiredOption("--private-host <id>", "Host with the services")
    .requiredOption("--public-host <id>", "Host with a public address")
    .requiredOption(
      "--endpoint <address>",
      "Public address of the public host (an IP or domain)",
    )
    .option("--port <port>", "WireGuard UDP port (picked for you by default)")
    .action(async function (
      this: Command,
      opts: {
        name: string;
        privateHost: string;
        publicHost: string;
        endpoint: string;
        port?: string;
      },
    ) {
      await run(async () => {
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        const created = await client.request<Gateway>({
          method: "POST",
          path: pluginPath("tunnels", "/gateways"),
          data: {
            name: opts.name,
            privateHostId: parseId(opts.privateHost),
            publicHostId: parseId(opts.publicHost),
            endpoint: opts.endpoint,
            listenPort:
              opts.port === undefined
                ? undefined
                : parsePort(opts.port, "--port"),
          },
        });
        printResult(`Created gateway ${created.id}.`, {
          id: created.id,
          name: created.name,
        });
      });
    });

  for (const [name, sub, verb] of [
    ["apply", "/apply", "Applied"],
    ["check", "/check", "Checked"],
  ] as const) {
    gateway
      .command(`${name} <gatewayId>`)
      .description(
        name === "apply"
          ? "Write the tunnel and rules to both hosts again."
          : "Read the tunnel and rule state from both hosts.",
      )
      .action(async function (this: Command, idArg: string) {
        await run(async () => {
          const id = parseId(idArg);
          const { client, requireFeature } = await createContext(this);
          await requireFeature("tunnels");
          const result = await client.request<Gateway>({
            method: "POST",
            path: gatewayPath(id, sub),
          });
          printResult(`${verb} gateway ${id}: ${result.status.state}.`, {
            id,
            state: result.status.state,
            message: result.status.message,
          });
        });
      });
  }

  gateway
    .command("scan <gatewayId>")
    .description("Look for new listening ports now.")
    .action(async function (this: Command, idArg: string) {
      await run(async () => {
        const id = parseId(idArg);
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        const result = await client.request<{ found: number }>({
          method: "POST",
          path: gatewayPath(id, "/scan"),
        });
        printResult(`Found ${result.found} new port(s).`, {
          id,
          found: result.found,
        });
      });
    });

  gateway
    .command("remove <gatewayId>")
    .description("Take a gateway off both hosts and delete it.")
    .action(async function (this: Command, idArg: string) {
      await run(async () => {
        const id = parseId(idArg);
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        await client.request({ method: "DELETE", path: gatewayPath(id) });
        printResult(`Removed gateway ${id}.`, { id });
      });
    });

  const port = gateway.command("port").description("Manage a gateway's ports.");

  port
    .command("add <gatewayId>")
    .description("Forward a public port. It starts on.")
    .option("--public-port <port>", "Port on the public host")
    .option("--target-port <port>", "Port on the target (default: same)")
    .option("--proto <proto>", "tcp, udp or both (default: tcp)")
    .option(
      "--target-host <ip>",
      "IPv4 address of the target (default: the private host)",
    )
    .option("--label <text>", "A note for the port")
    .option("--force", "Use the port even if the public host listens on it")
    .action(async function (this: Command, idArg: string, opts: PortOptions) {
      await run(async () => {
        const id = parseId(idArg);
        const body = buildPortBody(opts);
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        const created = await client.request<GatewayPort>({
          method: "POST",
          path: gatewayPath(id, "/ports"),
          data: body,
        });
        printResult(`Added port ${created.id} to gateway ${id}.`, {
          id: created.id,
          gatewayId: id,
        });
      });
    });

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    port
      .command(`${name} <gatewayId> <portId>`)
      .description(`Turn a forwarded port ${enabled ? "on" : "off"}.`)
      .option("--force", "Use the port even if the public host listens on it")
      .action(async function (
        this: Command,
        idArg: string,
        portArg: string,
        opts: { force?: boolean },
      ) {
        await run(async () => {
          const id = parseId(idArg);
          const portId = parseId(portArg);
          const { client, requireFeature } = await createContext(this);
          await requireFeature("tunnels");
          await client.request({
            method: "PATCH",
            path: gatewayPath(id, `/ports/${portId}`),
            data: { enabled, force: opts.force === true ? true : undefined },
          });
          printResult(
            `Turned port ${portId} ${enabled ? "on" : "off"} on gateway ${id}.`,
            { id: portId, gatewayId: id, enabled },
          );
        });
      });
  }

  port
    .command("remove <gatewayId> <portId>")
    .description("Delete a forwarded port.")
    .action(async function (this: Command, idArg: string, portArg: string) {
      await run(async () => {
        const id = parseId(idArg);
        const portId = parseId(portArg);
        const { client, requireFeature } = await createContext(this);
        await requireFeature("tunnels");
        await client.request({
          method: "DELETE",
          path: gatewayPath(id, `/ports/${portId}`),
        });
        printResult(`Removed port ${portId} from gateway ${id}.`, {
          id: portId,
          gatewayId: id,
        });
      });
    });
}
