import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { createContext } from "../core/context.js";
import type { TermixClient } from "../core/http.js";
import { ExitCode } from "../core/errors.js";
import { fail } from "../core/output/index.js";
import { parseId } from "./hosts.js";

const EXIT_MARKER = "__TERMIX_EXIT=";

export interface SnippetExecuteResponse {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Wrap a command so its real exit code survives the snippet-execution API,
 * which reports only a boolean. The command runs in a subshell so an explicit
 * `exit N` cannot skip the marker.
 */
export function wrapCommand(command: string): string {
  return `(\n${command}\n)\nprintf '\\n${EXIT_MARKER}%d\\n' "$?"`;
}

/** Matches the trailing marker; built from EXIT_MARKER so they cannot diverge. */
const EXIT_MARKER_RE = new RegExp(`\\n?${EXIT_MARKER}(\\d+)\\s*$`);

/** Split the marker out of the captured stdout. */
export function parseExecOutput(raw: string): {
  output: string;
  exitCode: number | null;
} {
  const match = raw.match(EXIT_MARKER_RE);
  if (!match) {
    return { output: raw, exitCode: null };
  }
  return {
    output: raw.slice(0, match.index),
    exitCode: Number(match[1]),
  };
}

/**
 * Run a command by creating a throwaway snippet, executing it, and deleting it.
 *
 * Termix has no "run this string on a host" endpoint, so the snippet API is
 * the only non-interactive path. The snippet is deleted on the way out,
 * including when the process is interrupted mid-run.
 */
async function executeOnHost(
  client: TermixClient,
  hostId: number,
  content: string,
  name: string,
): Promise<SnippetExecuteResponse> {
  const created = await client.request<{ id: number }>({
    method: "POST",
    path: "/snippets",
    data: {
      name,
      content,
      description: "Ephemeral snippet created by termix-cli (safe to delete).",
    },
  });

  const cleanup = async (): Promise<void> => {
    try {
      await client.request({
        method: "DELETE",
        path: `/snippets/${created.id}`,
      });
    } catch {
      process.stderr.write(
        `termix: warning: could not delete temporary snippet ${created.id}\n`,
      );
    }
  };

  // Without this, Ctrl-C between create and delete leaks a snippet server-side.
  const onSignal = (): void => {
    void cleanup().finally(() => process.exit(ExitCode.INTERNAL));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    return await client.request<SnippetExecuteResponse>({
      method: "POST",
      path: "/snippets/execute",
      data: { snippetId: created.id, hostId },
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}

export function registerExecCommands(program: Command): void {
  program
    .command("exec <hostId> <command...>")
    .description(
      "Run a shell command on a host over SSH. Prints the remote stdout and stderr, " +
        "and exits with the remote exit code (255 on CLI or API errors).",
    )
    .action(async function (
      this: Command,
      hostIdArg: string,
      commandParts: string[],
    ) {
      try {
        const hostId = parseId(hostIdArg);
        const command = commandParts.join(" ");
        const { client } = await createContext(this);

        const result = await executeOnHost(
          client,
          hostId,
          wrapCommand(command),
          `cli-exec-${randomUUID()}`,
        );

        const { output, exitCode } = parseExecOutput(result.output ?? "");
        if (output) process.stdout.write(output);
        if (result.error) process.stderr.write(result.error);

        // A missing marker means the wrapper never ran (server-side timeout,
        // or a shell without printf), so fall back to the API's own flag.
        // Setting exitCode rather than calling process.exit() lets a piped
        // stdout drain first.
        process.exitCode = exitCode ?? (result.success ? 0 : 1);
      } catch (error) {
        // The remote exit code owns the normal range, so CLI-level failures
        // use 255 to stay distinguishable from anything the command returned.
        fail(error, ExitCode.INTERNAL);
      }
    });
}
