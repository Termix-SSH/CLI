import { TermixApiError } from "./http.js";

/** Print a value as pretty JSON on stdout (the CLI's uniform output format). */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Print an error on stderr and exit. */
export function fail(error: unknown, exitCode = 1): never {
  const message =
    error instanceof TermixApiError
      ? `${error.message}${error.status ? ` (HTTP ${error.status})` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`termix: ${message}\n`);
  process.exit(exitCode);
}

/** Run a command action, mapping any thrown error to a clean CLI failure. */
export async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    fail(error);
  }
}
