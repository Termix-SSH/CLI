import fs from "node:fs";
import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { ExitCode, UsageError } from "../core/errors.js";
import {
  fail,
  printList,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";
import { parseId } from "./hosts.js";
import { parseExecOutput, type SnippetExecuteResponse } from "./exec.js";

type SnippetRow = Record<string, unknown>;

const SNIPPET_COLUMNS: Column<SnippetRow>[] = [
  { header: "id", value: (s) => s.id, align: "right" },
  { header: "name", value: (s) => s.name },
  { header: "folder", value: (s) => s.folder },
  { header: "description", value: (s) => s.description },
];

/** Resolve snippet content from --content or --content-file (mutually exclusive). */
function resolveContent(opts: {
  content?: string;
  contentFile?: string;
}): string | undefined {
  if (opts.content !== undefined && opts.contentFile !== undefined) {
    throw new UsageError("Pass only one of --content or --content-file.");
  }
  if (opts.contentFile !== undefined) {
    try {
      return fs.readFileSync(opts.contentFile, "utf8");
    } catch {
      throw new UsageError(`Could not read content file: ${opts.contentFile}`);
    }
  }
  return opts.content;
}

/** Parse repeated --input NAME=VALUE pairs for snippet variables. */
function collectInput(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const index = value.indexOf("=");
  if (index <= 0) {
    throw new UsageError(
      `Invalid --input "${value}" (expected NAME=VALUE, e.g. INPUT_1=production).`,
    );
  }
  return {
    ...previous,
    [value.slice(0, index)]: value.slice(index + 1),
  };
}

export function registerSnippetCommands(program: Command): void {
  const snippets = program
    .command("snippets")
    .description("Manage and run the command snippets saved in Termix.");

  snippets
    .command("list", { isDefault: true })
    .description("List saved snippets.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const all = await client.request<SnippetRow[]>({
          method: "GET",
          path: "/snippets",
        });
        printList(all, SNIPPET_COLUMNS, {
          jsonWrapper: (rows) => ({ count: rows.length, snippets: rows }),
        });
      });
    });

  snippets
    .command("create")
    .description("Create a saved snippet.")
    .requiredOption("--name <name>", "Snippet name")
    .option("--content <content>", "Snippet content (the command to run)")
    .option("--content-file <path>", "Read snippet content from a file")
    .option("--description <text>", "Description")
    .option("--folder <folder>", "Folder")
    .action(async function (
      this: Command,
      opts: {
        name: string;
        content?: string;
        contentFile?: string;
        description?: string;
        folder?: string;
      },
    ) {
      await run(async () => {
        const content = resolveContent(opts);
        if (!content) {
          throw new UsageError("Provide --content or --content-file.");
        }
        const { client } = await createContext(this);
        const created = await client.request<SnippetRow>({
          method: "POST",
          path: "/snippets",
          data: {
            name: opts.name,
            content,
            description: opts.description,
            folder: opts.folder,
          },
        });
        printResult(`Created snippet ${created.id}.`, {
          id: created.id,
          name: created.name,
        });
      });
    });

  snippets
    .command("update <snippetId>")
    .description("Update a saved snippet. Only the fields you pass change.")
    .option("--name <name>", "Snippet name")
    .option("--content <content>", "Snippet content")
    .option("--content-file <path>", "Read snippet content from a file")
    .option("--description <text>", "Description")
    .option("--folder <folder>", "Folder")
    .action(async function (
      this: Command,
      snippetId: string,
      opts: {
        name?: string;
        content?: string;
        contentFile?: string;
        description?: string;
        folder?: string;
      },
    ) {
      await run(async () => {
        const body: Record<string, unknown> = {};
        if (opts.name !== undefined) body.name = opts.name;
        const content = resolveContent(opts);
        if (content !== undefined) body.content = content;
        if (opts.description !== undefined) body.description = opts.description;
        if (opts.folder !== undefined) body.folder = opts.folder;

        if (Object.keys(body).length === 0) {
          throw new UsageError(
            "`snippets update` needs at least one field to change.",
          );
        }

        const id = parseId(snippetId);
        const { client } = await createContext(this);
        await client.request({
          method: "PUT",
          path: `/snippets/${id}`,
          data: body,
        });
        printResult(`Updated snippet ${id}.`, { id });
      });
    });

  snippets
    .command("delete <snippetId>")
    .description("Delete a saved snippet.")
    .action(async function (this: Command, snippetId: string) {
      await run(async () => {
        const id = parseId(snippetId);
        const { client } = await createContext(this);
        await client.request({ method: "DELETE", path: `/snippets/${id}` });
        printResult(`Deleted snippet ${id}.`, { id });
      });
    });

  snippets
    .command("run <snippetId>")
    .description(
      "Execute a saved snippet on a host. Exits with the remote exit code " +
        "when the snippet reports one, otherwise 0 on success (255 on CLI or API errors).",
    )
    .requiredOption("--host <hostId>", "Host id to run the snippet on")
    .option(
      "--input <NAME=VALUE>",
      "Value for a snippet variable; repeatable",
      collectInput,
      {} as Record<string, string>,
    )
    .action(async function (
      this: Command,
      snippetIdArg: string,
      opts: { host: string; input: Record<string, string> },
    ) {
      try {
        const snippetId = parseId(snippetIdArg);
        const hostId = parseId(opts.host, "--host");
        const { client } = await createContext(this);

        const result = await client.request<SnippetExecuteResponse>({
          method: "POST",
          path: "/snippets/execute",
          data: {
            snippetId,
            hostId,
            ...(Object.keys(opts.input).length
              ? { inputValues: opts.input }
              : {}),
          },
        });

        // A snippet written by hand will not carry the exec marker, but one
        // might, so honour it when present.
        const { output, exitCode } = parseExecOutput(result.output ?? "");
        if (output) process.stdout.write(output);
        if (result.error) process.stderr.write(result.error);
        process.exitCode = exitCode ?? (result.success ? 0 : 1);
      } catch (error) {
        fail(error, ExitCode.INTERNAL);
      }
    });
}
