import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { UsageError } from "./errors.js";

/**
 * Interactive prompts. Everything is written to stderr so that a command's
 * real output on stdout stays pipe-safe even when it had to ask a question.
 */
export async function prompt(question: string): Promise<string> {
  requireTty(question);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Prompt without echoing the typed characters.
 *
 * The muting stream is installed before the question is asked, and the prompt
 * text is written separately, so no keystroke can slip through in the gap.
 */
export async function promptHidden(question: string): Promise<string> {
  requireTty(question);
  process.stderr.write(question);

  const output = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });

  try {
    const answer = await rl.question("");
    process.stderr.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Read a secret from stdin, for `--password-stdin` and friends. */
export async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (!value) {
    throw new UsageError("No input received on stdin.");
  }
  return value;
}

/** Yes/no confirmation. Non-interactive callers must pass --yes instead. */
export async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}

function requireTty(question: string): void {
  if (process.stdin.isTTY) return;
  throw new UsageError(
    `Cannot prompt for input ("${question.trim()}") because stdin is not a terminal. ` +
      "Pass the value as a flag, use --password-stdin, or set TERMIX_API_KEY.",
  );
}
