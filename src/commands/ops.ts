import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { UsageError } from "../core/errors.js";
import {
  printJson,
  printList,
  printRecord,
  run,
  type Column,
} from "../core/output/index.js";
import { parseApiBody } from "./api.js";
import { parseId } from "./hosts.js";

interface CatalogField {
  key: string;
  type: string;
  label: string;
  required?: boolean;
}

interface CatalogAction {
  id: string;
  title: string;
  pluginName: string;
  scope: "host" | "resource" | "server";
  risk: string;
  inputs: CatalogField[];
  available: boolean;
  surfaces?: Record<string, boolean>;
}

interface Outcome {
  runId: string | null;
  status: string;
  summary?: string;
  error?: string;
  data?: unknown;
  approvalId?: string;
}

/** Exit codes for an action that ran but did not finish cleanly. */
export const OPS_EXIT = {
  FAILED: 1,
  NEEDS_APPROVAL: 9,
  PARTIAL: 10,
} as const;

/** `--input key=value`, repeatable. Values that look like JSON are parsed. */
export function collectInput(
  value: string,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const index = value.indexOf("=");
  if (index <= 0) {
    throw new UsageError(`Invalid --input "${value}" (expected KEY=VALUE).`);
  }
  const raw = value.slice(index + 1);
  let parsed: unknown = raw;
  if (/^(true|false|null|-?\d+(\.\d+)?|\{.*\}|\[.*\])$/s.test(raw)) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  return { ...previous, [value.slice(0, index)]: parsed };
}

export function collectHosts(value: string, previous: number[]): number[] {
  return [
    ...previous,
    ...value.split(",").map((part) => parseId(part.trim(), "host id")),
  ];
}

/** The exit code a set of outcomes should end with. */
export function exitFor(outcomes: Outcome[]): number {
  if (outcomes.length === 0) return 0;
  const failed = outcomes.filter(
    (outcome) =>
      outcome.status !== "success" && outcome.status !== "pending_approval",
  ).length;
  const waiting = outcomes.filter(
    (outcome) => outcome.status === "pending_approval",
  ).length;
  if (failed === outcomes.length) return OPS_EXIT.FAILED;
  if (failed > 0) return OPS_EXIT.PARTIAL;
  if (waiting > 0) return OPS_EXIT.NEEDS_APPROVAL;
  return 0;
}

const ACTION_COLUMNS: Column<CatalogAction & Record<string, unknown>>[] = [
  { header: "id", value: (a) => a.id },
  { header: "title", value: (a) => a.title },
  { header: "plugin", value: (a) => a.pluginName },
  { header: "on", value: (a) => a.scope },
  { header: "risk", value: (a) => a.risk },
];

const RUN_COLUMNS: Column<Record<string, unknown>>[] = [
  { header: "id", value: (r) => String(r.id).slice(0, 8) },
  { header: "action", value: (r) => r.actionId },
  { header: "host", value: (r) => r.hostName },
  { header: "status", value: (r) => r.status },
  { header: "by", value: (r) => r.username },
  { header: "when", value: (r) => r.createdAt },
];

const POLL_MS = 1500;

export function registerOpsCommands(program: Command): void {
  const ops = program
    .command("ops")
    .alias("actions")
    .description(
      "Run and track the actions plugins offer, such as restarting a container, on one host or many.",
    );

  ops
    .command("list")
    .description("List the actions you can run")
    .option("--search <text>", "Only actions whose id, title or plugin match")
    .action(async function (this: Command, opts: { search?: string }) {
      await run(async () => {
        const { client } = await createContext(this);
        const catalog = await client.request<{ actions: CatalogAction[] }>({
          method: "GET",
          path: "/operations/catalog",
          params: { surface: "cli" },
        });
        const text = opts.search?.toLowerCase() ?? "";
        const rows = catalog.actions.filter(
          (action) =>
            action.available &&
            (!text ||
              `${action.id} ${action.title} ${action.pluginName}`
                .toLowerCase()
                .includes(text)),
        );
        printList(
          rows as (CatalogAction & Record<string, unknown>)[],
          ACTION_COLUMNS,
          {
            quietField: "id",
            jsonWrapper: (actions) => ({ actions }),
          },
        );
      });
    });

  ops
    .command("describe <id>")
    .description("Show what an action needs")
    .action(async function (this: Command, id: string) {
      await run(async () => {
        const { client } = await createContext(this);
        const action = await client.request<Record<string, unknown>>({
          method: "GET",
          path: `/operations/catalog/${encodeURIComponent(id)}`,
        });
        printRecord(action);
      });
    });

  ops
    .command("run <id>")
    .description(
      "Run an action. Pick hosts with --host. Changes may wait for approval, which exits 9.",
    )
    .option(
      "--host <ids>",
      "Host id, or several separated by commas; repeatable",
      collectHosts,
      [] as number[],
    )
    .option("--target <key>", "The item on each host, such as a container name")
    .option(
      "--input <KEY=VALUE>",
      "An input value; repeatable",
      collectInput,
      {} as Record<string, unknown>,
    )
    .option("-d, --data <json>", "All inputs as a JSON object")
    .option("--data-file <path>", "Read the inputs from a file, or - for stdin")
    .option("--dry-run", "Report what would happen without changing anything")
    .option("--yes", "Confirm a destructive action")
    .action(async function (
      this: Command,
      id: string,
      opts: {
        host: number[];
        target?: string;
        input: Record<string, unknown>;
        data?: string;
        dataFile?: string;
        dryRun?: boolean;
        yes?: boolean;
      },
    ) {
      await run(async () => {
        const body = parseApiBody(opts);
        if (
          body !== undefined &&
          (typeof body !== "object" || Array.isArray(body))
        ) {
          throw new UsageError("The inputs must be a JSON object.");
        }
        const input = {
          ...((body as Record<string, unknown>) ?? {}),
          ...opts.input,
        };
        const { client } = await createContext(this);
        const hosts = opts.host.length > 0 ? opts.host : [undefined];
        const outcomes: (Outcome & { hostId?: number })[] = [];
        for (const hostId of hosts) {
          const outcome = await client.request<Outcome>({
            method: "POST",
            path: `/operations/${encodeURIComponent(id)}/run`,
            data: {
              hostId,
              resourceKey: opts.target,
              input,
              dryRun: opts.dryRun === true,
              confirmed: opts.yes === true,
            },
          });
          outcomes.push({ ...outcome, hostId });
        }
        if (hosts.length === 1) {
          printRecord(outcomes[0] as unknown as Record<string, unknown>, {
            quietField: "runId",
          });
        } else {
          printList(
            outcomes as unknown as Record<string, unknown>[],
            [
              { header: "host", value: (o) => o.hostId },
              { header: "status", value: (o) => o.status },
              { header: "result", value: (o) => o.summary ?? o.error },
            ],
            { jsonWrapper: (results) => ({ results }) },
          );
        }
        process.exitCode = exitFor(outcomes);
      });
    });

  ops
    .command("runs")
    .description("List recent runs")
    .option("--host <id>", "Only runs on this host")
    .option("--status <status>", "Only runs with this status")
    .option("--limit <n>", "How many", "50")
    .action(async function (
      this: Command,
      opts: { host?: string; status?: string; limit: string },
    ) {
      await run(async () => {
        const { client } = await createContext(this);
        const { runs } = await client.request<{
          runs: Record<string, unknown>[];
        }>({
          method: "GET",
          path: "/operations/runs",
          params: {
            hostId: opts.host ? parseId(opts.host, "host id") : undefined,
            status: opts.status,
            limit: opts.limit,
          },
        });
        printList(runs, RUN_COLUMNS, {
          quietField: "id",
          jsonWrapper: (rows) => ({ runs: rows }),
        });
      });
    });

  ops
    .command("status <runId>")
    .description("Show one run. --wait waits until it finishes.")
    .option("--wait", "Wait for the run to finish")
    .action(async function (
      this: Command,
      runId: string,
      opts: { wait?: boolean },
    ) {
      await run(async () => {
        const { client } = await createContext(this);
        const get = () =>
          client.request<Record<string, unknown>>({
            method: "GET",
            path: `/operations/runs/${encodeURIComponent(runId)}`,
          });
        let current = await get();
        while (
          opts.wait &&
          (current.status === "running" ||
            current.status === "pending_approval")
        ) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          current = await get();
        }
        printRecord(current);
        process.exitCode = exitFor([current as unknown as Outcome]);
      });
    });

  ops
    .command("approvals")
    .description("List requests waiting for approval")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const { approvals } = await client.request<{
          approvals: { id: string; run: Record<string, unknown> }[];
        }>({ method: "GET", path: "/operations/approvals" });
        printList(
          approvals.map(
            (approval) =>
              ({ ...approval.run, approvalId: approval.id }) as Record<
                string,
                unknown
              >,
          ),
          [
            { header: "approval", value: (r) => r.approvalId },
            { header: "action", value: (r) => r.actionId },
            { header: "host", value: (r) => r.hostName },
            { header: "by", value: (r) => r.username },
          ],
          {
            quietField: "approvalId",
            jsonWrapper: (rows) => ({ approvals: rows }),
          },
        );
      });
    });

  for (const [name, approve] of [
    ["approve", true],
    ["reject", false],
  ] as const) {
    ops
      .command(`${name} <approvalId>`)
      .description(
        approve
          ? "Approve a waiting request and run it. Needs a signed in session, not an API key."
          : "Reject a waiting request",
      )
      .option("--comment <text>", "A note kept with the decision")
      .action(async function (
        this: Command,
        approvalId: string,
        opts: { comment?: string },
      ) {
        await run(async () => {
          const { client } = await createContext(this);
          const outcome = await client.request<Outcome>({
            method: "POST",
            path: `/operations/approvals/${encodeURIComponent(approvalId)}`,
            data: { approve, comment: opts.comment },
          });
          printRecord(outcome as unknown as Record<string, unknown>);
          if (approve) process.exitCode = exitFor([outcome]);
        });
      });
  }

  ops
    .command("cancel <runId>")
    .description("Stop a running action, or withdraw one waiting for approval")
    .action(async function (this: Command, runId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        const result = await client.request<{ cancelled: boolean }>({
          method: "POST",
          path: `/operations/runs/${encodeURIComponent(runId)}/cancel`,
        });
        printJson(result);
      });
    });
}
