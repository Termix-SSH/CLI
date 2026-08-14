import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { createContext } from "../core/context.js";
import type { TermixClient } from "../core/http.js";
import {
  printList,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";
import { parseId } from "./hosts.js";

type ContainerRow = Record<string, unknown>;

const CONTAINER_COLUMNS: Column<ContainerRow>[] = [
  { header: "id", value: (c) => shortId(c.id ?? c.Id) },
  { header: "name", value: (c) => c.name ?? c.Names },
  { header: "image", value: (c) => c.image ?? c.Image },
  { header: "state", value: (c) => c.state ?? c.State },
  { header: "status", value: (c) => c.status ?? c.Status },
];

/**
 * The Docker API is session-oriented like the file manager: connect over SSH
 * to get a session id, then act against it.
 */
async function withDockerSession<T>(
  client: TermixClient,
  hostId: number,
  fn: (sessionId: string) => Promise<T>,
): Promise<T> {
  const sessionId = `cli-${randomUUID()}`;
  await client.request({
    method: "POST",
    path: "/docker/ssh/connect",
    service: "docker",
    data: { sessionId, hostId },
  });

  const disconnect = async (): Promise<void> => {
    try {
      await client.request({
        method: "POST",
        path: "/docker/ssh/disconnect",
        service: "docker",
        data: { sessionId },
      });
    } catch {
      // The session expires server-side; a failed disconnect must not mask
      // the result of the command the user ran.
    }
  };

  const onSignal = (): void => {
    void disconnect().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    return await fn(sessionId);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await disconnect();
  }
}

export function registerDockerCommands(program: Command): void {
  const docker = program
    .command("docker")
    .description("Inspect and control Docker containers on a host.");

  docker
    .command("ps <hostId>")
    .description("List containers on a host.")
    .action(async function (this: Command, hostIdArg: string) {
      await run(async () => {
        const hostId = parseId(hostIdArg);
        const { client } = await createContext(this);

        const containers = await withDockerSession(
          client,
          hostId,
          (sessionId) =>
            client.request<ContainerRow[] | { containers?: ContainerRow[] }>({
              method: "GET",
              path: `/docker/containers/${sessionId}`,
              service: "docker",
            }),
        );

        const rows = Array.isArray(containers)
          ? containers
          : (containers?.containers ?? []);
        printList(rows, CONTAINER_COLUMNS);
      });
    });

  docker
    .command("logs <hostId> <containerId>")
    .description("Print a container's logs.")
    .option("--tail <n>", "Number of lines from the end")
    .action(async function (
      this: Command,
      hostIdArg: string,
      containerId: string,
      opts: { tail?: string },
    ) {
      await run(async () => {
        const hostId = parseId(hostIdArg);
        const { client } = await createContext(this);

        const logs = await withDockerSession(client, hostId, (sessionId) =>
          client.request<{ logs?: string } | string>({
            method: "GET",
            path: `/docker/containers/${sessionId}/${encodeURIComponent(containerId)}/logs`,
            service: "docker",
            params: opts.tail ? { tail: opts.tail } : undefined,
          }),
        );

        // Logs are the result, so they go to stdout verbatim.
        process.stdout.write(
          typeof logs === "string" ? logs : (logs?.logs ?? ""),
        );
      });
    });

  for (const action of ["start", "stop", "restart", "pause", "unpause"]) {
    docker
      .command(`${action} <hostId> <containerId>`)
      .description(`${capitalise(action)} a container.`)
      .action(async function (
        this: Command,
        hostIdArg: string,
        containerId: string,
      ) {
        await run(async () => {
          const hostId = parseId(hostIdArg);
          const { client } = await createContext(this);

          await withDockerSession(client, hostId, (sessionId) =>
            client.request({
              method: "POST",
              path: `/docker/containers/${sessionId}/${encodeURIComponent(containerId)}/${action}`,
              service: "docker",
            }),
          );
          printResult(`Sent ${action} to ${containerId}.`, {
            id: containerId,
            action,
          });
        });
      });
  }
}

function shortId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Docker ids are 64 hex chars; the first 12 are what people actually use.
  return value.length > 12 ? value.slice(0, 12) : value;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
