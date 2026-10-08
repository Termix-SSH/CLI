import fs from "node:fs";
import type { Command } from "commander";
import type { Method } from "axios";
import { createContext } from "../core/context.js";
import { UsageError } from "../core/errors.js";
import { printJson, run } from "../core/output/index.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function parseApiMethod(value: string): Method {
  const method = value.toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) {
    throw new UsageError(
      `Unknown method "${value}" (expected one of ${METHODS.join(", ")}).`,
    );
  }
  return method as Method;
}

/**
 * The route to call. The leading slash is optional, because Git Bash on
 * Windows rewrites an argument like /plugins into C:/Program Files/Git/plugins
 * before the CLI sees it.
 */
export function parseApiPath(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    throw new UsageError(
      `"${value}" is a local file path. Git Bash rewrites arguments that start with "/", so leave the slash off (plugins, not /plugins) or set MSYS_NO_PATHCONV=1.`,
    );
  }
  if (/^[a-z]+:\/\//i.test(value) || value.startsWith("//")) {
    throw new UsageError(
      `Pass a path on the server, like /plugins, not a full URL. Use --url to pick the server.`,
    );
  }
  return value.startsWith("/") ? value : `/${value}`;
}

export function collectQuery(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const index = value.indexOf("=");
  if (index <= 0) {
    throw new UsageError(`Invalid --query "${value}" (expected NAME=VALUE).`);
  }
  return { ...previous, [value.slice(0, index)]: value.slice(index + 1) };
}

/** Read the request body from --data or --data-file (`-` is stdin). */
export function parseApiBody(opts: {
  data?: string;
  dataFile?: string;
}): unknown {
  if (opts.data !== undefined && opts.dataFile !== undefined) {
    throw new UsageError("Pass only one of --data or --data-file.");
  }
  let raw = opts.data;
  if (opts.dataFile !== undefined) {
    try {
      raw = fs.readFileSync(opts.dataFile === "-" ? 0 : opts.dataFile, "utf8");
    } catch {
      throw new UsageError(`Could not read --data-file: ${opts.dataFile}`);
    }
  }
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError("The request body is not valid JSON.");
  }
}

export function registerApiCommands(program: Command): void {
  program
    .command("api <method> <path>")
    .description(
      "Send an authenticated request to any Termix route, including plugin routes " +
        "under /plugin-api/<id>/. Prints the JSON response.",
    )
    .option("-d, --data <json>", "JSON request body")
    .option(
      "--data-file <path>",
      "Read the JSON request body from a file, or - for stdin",
    )
    .option(
      "--query <NAME=VALUE>",
      "Query string parameter; repeatable",
      collectQuery,
      {} as Record<string, string>,
    )
    .option("--raw", "Print the response body as-is instead of as JSON")
    .action(async function (
      this: Command,
      methodArg: string,
      pathArg: string,
      opts: {
        data?: string;
        dataFile?: string;
        query: Record<string, string>;
        raw?: boolean;
      },
    ) {
      await run(async () => {
        const method = parseApiMethod(methodArg);
        const path = parseApiPath(pathArg);
        const data = parseApiBody(opts);

        const { client } = await createContext(this);
        const response = await client.request<unknown>({
          method,
          path,
          data,
          params: Object.keys(opts.query).length ? opts.query : undefined,
          responseType: opts.raw ? "text" : "json",
        });

        if (opts.raw) {
          process.stdout.write(
            typeof response === "string" ? response : JSON.stringify(response),
          );
          return;
        }
        printJson(response ?? null);
      });
    });
}
