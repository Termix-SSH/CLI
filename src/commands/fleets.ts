import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { ExitCode, UsageError } from "../core/errors.js";
import {
  fail,
  isJsonMode,
  printJson,
  printList,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";
import { parseId } from "./hosts.js";

type Row = Record<string, unknown>;

const FLEET_COLUMNS: Column<Row>[] = [
  { header: "id", value: (f) => f.id, align: "right" },
  { header: "name", value: (f) => f.name },
  { header: "description", value: (f) => f.description },
  {
    header: "members",
    value: (f) => f.memberCount ?? f.members,
    align: "right",
  },
];

const MEMBER_COLUMNS: Column<Row>[] = [
  { header: "id", value: (h) => h.id ?? h.hostId, align: "right" },
  { header: "name", value: (h) => h.name },
  { header: "address", value: (h) => h.ip },
];

interface ExecuteResult {
  hostId?: number;
  hostName?: string;
  success?: boolean;
  output?: string;
  error?: string;
}

export function registerFleetCommands(program: Command): void {
  const fleets = program
    .command("fleets")
    .description("Manage fleets, and run a command across every host in one.");

  fleets
    .command("list", { isDefault: true })
    .description("List fleets.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const data = await client.request<Row[] | { fleets?: Row[] }>({
          method: "GET",
          path: "/fleets",
        });
        printList(toRows(data, "fleets"), FLEET_COLUMNS);
      });
    });

  fleets
    .command("members <fleetId>")
    .description("List the hosts in a fleet.")
    .action(async function (this: Command, fleetId: string) {
      await run(async () => {
        const id = parseId(fleetId, "fleet id");
        const { client } = await createContext(this);
        const data = await client.request<Row[] | { members?: Row[] }>({
          method: "GET",
          path: `/fleets/${id}/members`,
        });
        printList(toRows(data, "members"), MEMBER_COLUMNS);
      });
    });

  fleets
    .command("create")
    .description("Create a fleet.")
    .requiredOption("--name <name>", "Fleet name")
    .option("--description <text>", "Description")
    .action(async function (
      this: Command,
      opts: { name: string; description?: string },
    ) {
      await run(async () => {
        const { client } = await createContext(this);
        const created = await client.request<Row>({
          method: "POST",
          path: "/fleets",
          data: { name: opts.name, description: opts.description },
        });
        printResult(`Created fleet ${created.id}.`, {
          id: created.id,
          name: created.name,
        });
      });
    });

  fleets
    .command("delete <fleetId>")
    .description("Delete a fleet.")
    .action(async function (this: Command, fleetId: string) {
      await run(async () => {
        const id = parseId(fleetId, "fleet id");
        const { client } = await createContext(this);
        await client.request({ method: "DELETE", path: `/fleets/${id}` });
        printResult(`Deleted fleet ${id}.`, { id });
      });
    });

  fleets
    .command("add-host <fleetId> <hostId>")
    .description("Add a host to a fleet.")
    .action(async function (this: Command, fleetId: string, hostId: string) {
      await run(async () => {
        const fleet = parseId(fleetId, "fleet id");
        const host = parseId(hostId, "host id");
        const { client } = await createContext(this);
        await client.request({
          method: "POST",
          path: `/fleets/${fleet}/members`,
          data: { hostId: host },
        });
        printResult(`Added host ${host} to fleet ${fleet}.`, { id: host });
      });
    });

  fleets
    .command("remove-host <fleetId> <hostId>")
    .description("Remove a host from a fleet.")
    .action(async function (this: Command, fleetId: string, hostId: string) {
      await run(async () => {
        const fleet = parseId(fleetId, "fleet id");
        const host = parseId(hostId, "host id");
        const { client } = await createContext(this);
        await client.request({
          method: "DELETE",
          path: `/fleets/${fleet}/members/${host}`,
        });
        printResult(`Removed host ${host} from fleet ${fleet}.`, { id: host });
      });
    });

  fleets
    .command("exec <fleetId> <command...>")
    .description(
      "Run a command on every host in a fleet. Exits non-zero if any host failed.",
    )
    .action(async function (
      this: Command,
      fleetId: string,
      commandParts: string[],
    ) {
      try {
        const id = parseId(fleetId, "fleet id");
        const command = commandParts.join(" ");
        if (!command.trim()) {
          throw new UsageError("A command is required.");
        }

        const { client } = await createContext(this);
        const data = await client.request<{ results?: ExecuteResult[] }>({
          method: "POST",
          path: `/fleets/${id}/execute`,
          data: { command },
        });

        const results = data?.results ?? [];
        if (isJsonMode()) {
          printJson({ count: results.length, results });
        } else {
          // Label each host's output, since several are interleaved here in a
          // way a single-host run never is.
          for (const result of results) {
            const label = result.hostName ?? `host ${result.hostId}`;
            process.stdout.write(`=== ${label} ===\n`);
            if (result.output) process.stdout.write(result.output);
            if (result.error) process.stderr.write(result.error);
          }
        }

        const failed = results.filter((r) => r.success === false).length;
        process.exitCode = failed > 0 ? ExitCode.FAILURE : ExitCode.OK;
      } catch (error) {
        fail(error, ExitCode.INTERNAL);
      }
    });
}

/** Accept either a bare array or an envelope like `{ fleets: [...] }`. */
function toRows(data: unknown, key: string): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    const inner = (data as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as Row[];
  }
  return [];
}
