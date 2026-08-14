import type { Command } from "commander";
import { resolveConfig } from "../core/config.js";
import { TermixClient } from "../core/http.js";
import { printJson, run } from "../core/output.js";

export function registerMiscCommands(
  program: Command,
  cliVersion: string,
): void {
  program
    .command("version")
    .description("Show the CLI version and the server's health and version.")
    .action(async () =>
      run(async () => {
        const config = resolveConfig();
        const client = new TermixClient(config);

        const health = await client
          .request<{ status?: string }>({
            method: "GET",
            path: "/health",
            noAuth: true,
          })
          .catch((e) => ({ status: `unreachable (${message(e)})` }));

        const server = await client
          .request<Record<string, unknown>>({
            method: "GET",
            path: "/version",
            params: { checkRemote: false },
          })
          .catch(() => null);

        printJson({
          cli: cliVersion,
          url: config.url,
          health: health?.status ?? null,
          server: server
            ? { version: server.localVersion, status: server.status }
            : null,
        });
      }),
    );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
