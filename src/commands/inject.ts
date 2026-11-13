import { spawn, type ChildProcess } from "node:child_process";
import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { UsageError, ExitCode } from "../core/errors.js";
import { fail } from "../core/output/index.js";

/** Normalize name for env variable: 'Database_Prod#1' -> 'DATABASE_PROD_1' */
export function normalizeEnvName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Replace sensitive secrets in text with a redacted placeholder */
export function maskSecrets(
  chunk: Buffer | string,
  sortedSecrets: string[],
): string {
  let str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  for (const s of sortedSecrets) {
    if (s) {
      str = str.replaceAll(s, "[REDACTED_BY_TERMIX]");
    }
  }
  return str;
}

/**
 * Handles output stream masking across chunk boundaries by retaining up to
 * (maxSecretLength - 1) bytes at the end of each chunk.
 */
export class StreamMasker {
  private remainder = "";
  private readonly keepLen: number;
  private readonly sortedSecrets: string[];

  constructor(sortedSecrets: string[]) {
    this.sortedSecrets = sortedSecrets.filter((s) => Boolean(s));
    const maxLen = this.sortedSecrets.reduce(
      (max, s) => Math.max(max, s.length),
      0,
    );
    this.keepLen = maxLen > 1 ? maxLen - 1 : 0;
  }

  process(chunk: Buffer | string): string {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const full = this.remainder + text;
    const masked = maskSecrets(full, this.sortedSecrets);
    if (this.keepLen === 0) {
      this.remainder = "";
      return masked;
    }
    if (masked.length <= this.keepLen) {
      this.remainder = masked;
      return "";
    }
    const safeLen = masked.length - this.keepLen;
    const toEmit = masked.slice(0, safeLen);
    this.remainder = masked.slice(safeLen);
    return toEmit;
  }

  flush(): string {
    const rem = this.remainder;
    this.remainder = "";
    return rem ? maskSecrets(rem, this.sortedSecrets) : "";
  }
}

export interface TermixCredentialRaw {
  id: number;
  name: string;
  username?: string | null;
  password?: string | null;
  authType?: string;
  publicKey?: string | null;
  key?: string | null;
  privateKey?: string | null;
}

export function buildInjectedEnv(
  credentials: TermixCredentialRaw[],
  options: { names?: boolean } = {},
): Record<string, string> {
  const injectedEnv: Record<string, string> = {};

  for (const cred of credentials) {
    const cid = cred.id;
    const username = cred.username || "";
    const password = cred.password || "";
    const privateKey = cred.key || cred.privateKey || "";

    if (cred.authType === "key" && !privateKey) {
      throw new UsageError(
        `Credential ${cid} ("${cred.name}") is of type "key" but contains no private key.`,
      );
    }

    // 1. By ID: strictly TERMIX_<ID>_USERNAME, TERMIX_<ID>_PASSWORD, TERMIX_<ID>_KEY
    if (username) {
      injectedEnv[`TERMIX_${cid}_USERNAME`] = username;
    }
    if (password) {
      injectedEnv[`TERMIX_${cid}_PASSWORD`] = password;
    }
    if (privateKey) {
      injectedEnv[`TERMIX_${cid}_KEY`] = privateKey;
    }

    // 2. By Normalized Name (only when --names is enabled)
    if (options.names) {
      const baseName = normalizeEnvName(cred.name || `CREDENTIAL_${cid}`);
      const nameCandidates: Record<string, string> = {};

      if (username) {
        nameCandidates[`${baseName}_USERNAME`] = username;
      }
      if (password) {
        nameCandidates[`${baseName}_PASSWORD`] = password;
        nameCandidates[baseName] = password;
      }
      if (privateKey) {
        nameCandidates[`${baseName}_KEY`] = privateKey;
        if (!password) {
          nameCandidates[baseName] = privateKey;
        }
      }

      for (const [key, val] of Object.entries(nameCandidates)) {
        if (key in process.env) {
          throw new UsageError(
            `Refusing to overwrite existing environment variable "${key}" from credential "${cred.name}".`,
          );
        }
        if (key in injectedEnv) {
          throw new UsageError(
            `Duplicate environment variable "${key}" from credential "${cred.name}".`,
          );
        }
        injectedEnv[key] = val;
      }
    }
  }

  return injectedEnv;
}

export function registerInjectCommands(program: Command): void {
  program
    .command("inject [targets...]")
    .description(
      "Fetch credentials from Termix and inject them as environment variables into a command in memory.\n" +
        "Usage: termix inject credential <ids...> -- <command...>\n" +
        "   or: termix inject [options] <ids...> -- <command...>",
    )
    .option(
      "--names",
      "Inject credentials as named variables (e.g. STRIPE_API_KEY) in addition to IDs",
    )
    .option(
      "--mask",
      "Redact secrets from stdout and stderr output in real time",
    )
    .allowUnknownOption()
    .action(async function (
      this: Command,
      targets: string[] = [],
      options: { names?: boolean; mask?: boolean },
    ) {
      try {
        const dashDashIdx = process.argv.indexOf("--");
        if (dashDashIdx === -1) {
          throw new UsageError(
            "Missing '--' separator before the command to run.\n" +
              "Example: termix inject 1 2 -- python script.py",
          );
        }

        const injectIdx = process.argv.indexOf("inject");
        const targetTokens =
          injectIdx !== -1 && injectIdx < dashDashIdx
            ? process.argv.slice(injectIdx + 1, dashDashIdx)
            : targets;
        const commandParts = process.argv.slice(dashDashIdx + 1);

        if (commandParts.length === 0) {
          throw new UsageError("No command specified after '--'.");
        }

        let useNames = Boolean(options.names);
        let useMask = Boolean(options.mask);

        // Filter out keyword 'credential'/'credentials' or options placed before '--'
        const idStrings: string[] = [];
        for (const t of targetTokens) {
          const lower = t.toLowerCase();
          if (lower === "credential" || lower === "credentials") continue;
          if (lower === "--names") {
            useNames = true;
            continue;
          }
          if (lower === "--mask") {
            useMask = true;
            continue;
          }
          idStrings.push(t);
        }

        if (idStrings.length === 0) {
          throw new UsageError(
            "No credential IDs provided.\n" +
              "Example: termix inject credential 1 2 -- python script.py",
          );
        }

        const credentialIds: number[] = [];
        for (const str of idStrings) {
          const num = Number(str);
          if (!Number.isInteger(num) || num <= 0) {
            throw new UsageError(
              `Invalid credential ID: "${str}". Must be a positive integer.`,
            );
          }
          credentialIds.push(num);
        }

        const { client } = await createContext(this);
        const credentials: TermixCredentialRaw[] = [];
        const secretsToMask: Set<string> = new Set();

        for (const cid of credentialIds) {
          let cred: TermixCredentialRaw;
          try {
            cred = await client.request<TermixCredentialRaw>({
              method: "GET",
              path: `/credentials/${cid}`,
            });
          } catch (err) {
            throw new UsageError(
              `Failed to fetch credential ${cid} from Termix: ${(err as Error).message}`,
            );
          }

          credentials.push(cred);

          const password = cred.password || "";
          const privateKey = cred.key || cred.privateKey || "";

          if (useMask) {
            if (password && password.length >= 4) {
              secretsToMask.add(password);
            }
            if (privateKey && privateKey.length >= 10) {
              secretsToMask.add(privateKey.trim());
              for (const line of privateKey.split("\n")) {
                const trimmed = line.trim();
                if (trimmed.length >= 16 && !trimmed.startsWith("-----")) {
                  secretsToMask.add(trimmed);
                }
              }
            }
          }
        }

        const injectedEnv = buildInjectedEnv(credentials, { names: useNames });

        const bin = commandParts[0];
        if (!bin) {
          throw new UsageError("No executable binary specified.");
        }
        const cmdArgs = commandParts.slice(1);

        const sortedSecrets = Array.from(secretsToMask).sort(
          (a, b) => b.length - a.length,
        );

        const stdoutMasker = new StreamMasker(sortedSecrets);
        const stderrMasker = new StreamMasker(sortedSecrets);

        const child: ChildProcess = spawn(bin, cmdArgs, {
          stdio: useMask ? ["inherit", "pipe", "pipe"] : "inherit",
          env: {
            ...process.env,
            ...injectedEnv,
          },
        });

        if (useMask) {
          child.stdout?.on("data", (chunk: Buffer) => {
            const out = stdoutMasker.process(chunk);
            if (out) process.stdout.write(out);
          });

          child.stderr?.on("data", (chunk: Buffer) => {
            const err = stderrMasker.process(chunk);
            if (err) process.stderr.write(err);
          });
        }

        const forwardSignal = (sig: NodeJS.Signals): void => {
          if (child.pid && !child.killed) {
            child.kill(sig);
          }
        };

        const onSigInt = () => forwardSignal("SIGINT");
        const onSigTerm = () => forwardSignal("SIGTERM");

        process.on("SIGINT", onSigInt);
        process.on("SIGTERM", onSigTerm);

        child.on(
          "close",
          (code: number | null, signal: NodeJS.Signals | null) => {
            process.off("SIGINT", onSigInt);
            process.off("SIGTERM", onSigTerm);

            if (useMask) {
              const remOut = stdoutMasker.flush();
              if (remOut) process.stdout.write(remOut);
              const remErr = stderrMasker.flush();
              if (remErr) process.stderr.write(remErr);
            }

            if (code !== null) {
              process.exit(code);
            } else if (signal === "SIGINT") {
              process.exit(130);
            } else if (signal === "SIGTERM") {
              process.exit(143);
            } else {
              process.exit(ExitCode.OK);
            }
          },
        );

        child.on("error", (err: Error) => {
          process.off("SIGINT", onSigInt);
          process.off("SIGTERM", onSigTerm);
          fail(err, ExitCode.INTERNAL);
        });
      } catch (error) {
        if (error instanceof UsageError) {
          fail(error, ExitCode.USAGE);
        } else {
          fail(error, ExitCode.INTERNAL);
        }
      }
    });
}
