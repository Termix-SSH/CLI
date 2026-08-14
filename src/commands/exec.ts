import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { resolveConfig } from "../core/config.js";
import { TermixClient } from "../core/http.js";
import { fail } from "../core/output.js";
import { parseId } from "./hosts.js";

const EXIT_MARKER = "__TERMIX_EXIT=";

export interface SnippetExecuteResponse {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Wrap a command so its real exit code survives the snippet-execution API,
 * whose `success` flag only reflects "nothing was written to stderr". The
 * command runs in a subshell so an explicit `exit N` cannot skip the marker.
 */
export function wrapCommand(command: string): string {
  return `(\n${command}\n)\nprintf '\\n${EXIT_MARKER}%d\\n' "$?"`;
}

/** Matches the trailing exit marker; built from EXIT_MARKER so they can't diverge. */
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

  try {
    return await client.request<SnippetExecuteResponse>({
      method: "POST",
      path: "/snippets/execute",
      data: { snippetId: created.id, hostId },
    });
  } finally {
    await client
      .request({ method: "DELETE", path: `/snippets/${created.id}` })
      .catch(() => {
        process.stderr.write(
          `termix: warning: could not delete ephemeral snippet ${created.id}\n`,
        );
      });
  }
}

export function registerExecCommands(program: Command): void {
  program
    .command("exec <hostId> <command...>")
    .description(
      "Run a shell command on a host over SSH. Prints the remote stdout/stderr and exits with the remote exit code (255 on CLI/API errors). Server-side execution timeout: 30s.",
    )
    .action(async (hostIdArg: string, commandParts: string[]) => {
      try {
        const hostId = parseId(hostIdArg);
        const command = commandParts.join(" ");
        const client = new TermixClient(resolveConfig());

        const result = await executeOnHost(
          client,
          hostId,
          wrapCommand(command),
          `cli-exec-${randomUUID()}`,
        );

        const { output, exitCode } = parseExecOutput(result.output ?? "");
        if (output) process.stdout.write(output);
        if (result.error) process.stderr.write(result.error);

        // Marker missing means the wrapper never ran (e.g. server timeout):
        // fall back to the API's stderr-based success flag. Set exitCode
        // instead of calling process.exit() so a piped stdout fully drains
        // before the process terminates.
        process.exitCode = exitCode ?? (result.success ? 0 : 1);
      } catch (error) {
        fail(error, 255);
      }
    });
}
