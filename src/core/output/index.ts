import { renderTable, type Column } from "./table.js";
import { dim, green, yellow } from "./color.js";
import {
  exitCodeFor,
  messageFor,
  remediationFor,
  ExitCode,
  type ExitCodeValue,
} from "../errors.js";

export type { Column } from "./table.js";

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
  color?: boolean;
}

let options: Required<OutputOptions> = {
  json: false,
  quiet: false,
  color: true,
};

/**
 * Resolve global output flags once, at startup.
 *
 * JSON turns itself on when stdout is not a TTY so that pipes and command
 * substitution get machine-readable output without the caller remembering a
 * flag. An explicit --json / --no-json always wins.
 */
export function configureOutput(
  flags: { json?: boolean; quiet?: boolean; color?: boolean },
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = process.stdout.isTTY === true,
): void {
  options = {
    json: flags.json ?? !isTty,
    quiet: flags.quiet ?? false,
    color: flags.color ?? (isTty && !env.NO_COLOR && env.TERM !== "dumb"),
  };
}

export function outputOptions(): Required<OutputOptions> {
  return options;
}

export function isJsonMode(): boolean {
  return options.json;
}

/** Print a value as pretty JSON on stdout. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Render a list of records.
 *
 * `json` carries the full objects, while the table shows only `columns` - so
 * the human view stays readable without withholding anything from scripts.
 * `quiet` emits one id per line for xargs.
 */
export function printList<T extends Record<string, unknown>>(
  rows: T[],
  columns: Column<T>[],
  opts: { quietField?: keyof T; jsonWrapper?: (rows: T[]) => unknown } = {},
): void {
  if (options.json) {
    printJson(opts.jsonWrapper ? opts.jsonWrapper(rows) : rows);
    return;
  }
  if (options.quiet) {
    const field = opts.quietField ?? ("id" as keyof T);
    for (const row of rows) process.stdout.write(`${String(row[field])}\n`);
    return;
  }
  if (rows.length === 0) {
    printInfo("No results.");
    return;
  }
  process.stdout.write(renderTable(rows, columns, options.color));
}

/** Render a single record as key/value pairs, or JSON in machine mode. */
export function printRecord(
  record: Record<string, unknown>,
  opts: { quietField?: string } = {},
): void {
  if (options.json) {
    printJson(record);
    return;
  }
  if (options.quiet) {
    const field = opts.quietField ?? "id";
    process.stdout.write(`${String(record[field])}\n`);
    return;
  }

  const keys = Object.keys(record).filter((k) => record[k] !== undefined);
  const width = Math.max(0, ...keys.map((k) => k.length));
  for (const key of keys) {
    const label = dim(`${key.padEnd(width)}`, options.color);
    process.stdout.write(`${label}  ${formatValue(record[key])}\n`);
  }
}

/**
 * Confirmation for a mutation. Silent in quiet mode, JSON in machine mode, so
 * `termix hosts delete 3 --json` still yields a parseable result.
 */
export function printResult(
  message: string,
  data: Record<string, unknown> = {},
): void {
  if (options.json) {
    printJson({ success: true, ...data });
    return;
  }
  if (options.quiet) {
    if (data.id !== undefined) process.stdout.write(`${String(data.id)}\n`);
    return;
  }
  process.stdout.write(`${green("✓", options.color)} ${message}\n`);
}

/** Informational text. Always stderr so stdout stays pipe-safe. */
export function printInfo(message: string): void {
  if (options.quiet || options.json) return;
  process.stderr.write(`${message}\n`);
}

/** Warning text. Always stderr, and never suppressed by --json. */
export function printWarning(message: string): void {
  process.stderr.write(`${yellow("warning:", options.color)} ${message}\n`);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return dim("-", options.color);
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : dim("-", options.color);
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Print an error on stderr and exit with the mapped code. */
export function fail(error: unknown, exitCode?: ExitCodeValue): never {
  const remediation = remediationFor(error);
  process.stderr.write(`termix: ${messageFor(error)}\n`);
  if (remediation) process.stderr.write(`  ${remediation}\n`);
  process.exit(exitCode ?? exitCodeFor(error));
}

/** Run a command action, mapping any thrown error to a clean CLI failure. */
export async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    fail(error);
  }
}

export { ExitCode };
