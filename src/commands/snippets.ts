import fs from "node:fs";
import type { Command } from "commander";
import { resolveConfig } from "../core/config.js";
import { TermixClient } from "../core/http.js";
import { fail, printJson, run } from "../core/output.js";
import { parseId } from "./hosts.js";
import type { SnippetExecuteResponse } from "./exec.js";

/** Resolve snippet content from --content or --content-file (mutually exclusive). */
function resolveContent(opts: {
  content?: string;
  contentFile?: string;
}): string | undefined {
  if (opts.content !== undefined && opts.contentFile !== undefined) {
    throw new Error("Pass only one of --content or --content-file.");
  }
  if (opts.contentFile !== undefined) {
    try {
      return fs.readFileSync(opts.contentFile, "utf8");
    } catch {
      throw new Error(`Could not read content file: ${opts.contentFile}`);
    }
  }
  return opts.content;
}

export function registerSnippetCommands(program: Command): void {
  const snippets = program
    .command("snippets")
    .description("Manage and run the command snippets saved in Termix.");

  snippets
    .command("list")
    .description("List saved snippets (id, name, description, folder).")
    .action(async () =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const all = await client.request<Array<Record<string, unknown>>>({
          method: "GET",
          path: "/snippets",
        });
        const summaries = all.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description ?? null,
          folder: s.folder ?? null,
        }));
        printJson({ count: summaries.length, snippets: summaries });
      }),
    );

  snippets
    .command("create")
    .description("Create a saved snippet.")
    .requiredOption("--name <name>", "Snippet name")
    .option("--content <content>", "Snippet content (the command to run)")
    .option("--content-file <path>", "Read snippet content from a file")
    .option("--description <text>", "Description")
    .option("--folder <folder>", "Folder")
    .action(
      async (opts: {
        name: string;
        content?: string;
        contentFile?: string;
        description?: string;
        folder?: string;
      }) =>
        run(async () => {
          const content = resolveContent(opts);
          if (!content) {
            throw new Error("Provide --content or --content-file.");
          }
          const client = new TermixClient(resolveConfig());
          const created = await client.request<Record<string, unknown>>({
            method: "POST",
            path: "/snippets",
            data: {
              name: opts.name,
              content,
              description: opts.description,
              folder: opts.folder,
            },
          });
          printJson({ id: created.id, name: created.name });
        }),
    );

  snippets
    .command("update <snippetId>")
    .description("Update fields of a saved snippet (only the ones you pass).")
    .option("--name <name>", "Snippet name")
    .option("--content <content>", "Snippet content")
    .option("--content-file <path>", "Read snippet content from a file")
    .option("--description <text>", "Description")
    .option("--folder <folder>", "Folder")
    .action(
      async (
        snippetId: string,
        opts: {
          name?: string;
          content?: string;
          contentFile?: string;
          description?: string;
          folder?: string;
        },
      ) =>
        run(async () => {
          const body: Record<string, unknown> = {};
          if (opts.name !== undefined) body.name = opts.name;
          const content = resolveContent(opts);
          if (content !== undefined) body.content = content;
          if (opts.description !== undefined)
            body.description = opts.description;
          if (opts.folder !== undefined) body.folder = opts.folder;

          const client = new TermixClient(resolveConfig());
          const updated = await client.request<Record<string, unknown>>({
            method: "PUT",
            path: `/snippets/${parseId(snippetId)}`,
            data: body,
          });
          printJson(updated);
        }),
    );

  snippets
    .command("delete <snippetId>")
    .description("Delete a saved snippet by id.")
    .action(async (snippetId: string) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const data = await client.request({
          method: "DELETE",
          path: `/snippets/${parseId(snippetId)}`,
        });
        printJson(data);
      }),
    );

  snippets
    .command("run <snippetId>")
    .description(
      "Execute a saved snippet on a host. Prints remote stdout/stderr; exits 0 when the snippet produced no stderr, 1 otherwise (the API does not expose the exit code).",
    )
    .requiredOption("--host <hostId>", "Host id to run the snippet on")
    .action(async (snippetIdArg: string, opts: { host: string }) => {
      try {
        const snippetId = parseId(snippetIdArg);
        const hostId = parseId(opts.host);
        const client = new TermixClient(resolveConfig());

        const result = await client.request<SnippetExecuteResponse>({
          method: "POST",
          path: "/snippets/execute",
          data: { snippetId, hostId },
        });

        if (result.output) process.stdout.write(result.output);
        if (result.error) process.stderr.write(result.error);
        // Set exitCode instead of calling process.exit() so a piped stdout
        // fully drains before the process terminates.
        process.exitCode = result.success ? 0 : 1;
      } catch (error) {
        fail(error, 255);
      }
    });
}
