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

/** Replace sensitive secrets in stdout/stderr with a redacted placeholder */
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

interface TermixCredentialRaw {
  id: number;
  name: string;
  username?: string | null;
  password?: string | null;
  authType?: string;
  publicKey?: string | null;
  key?: string | null;
  privateKey?: string | null;
}

export function registerInjectCommands(program: Command): void {
  program
    .command("inject [args...]")
    .description(
      "Fetch credentials from Termix and inject them as environment variables into a command in memory.\n" +
        "Usage: termix inject credential <ids...> -- <command...>\n" +
        "   or: termix inject <ids...> -- <command...>",
    )
    .allowUnknownOption()
    .action(async function (this: Command) {
      try {
        const rawArgs = process.argv;
        const injectIdx = rawArgs.indexOf("inject");
        if (injectIdx === -1) {
          throw new UsageError("Invalid command invocation.");
        }

        const argsAfterInject = rawArgs.slice(injectIdx + 1);
        const dashDashIdx = argsAfterInject.indexOf("--");

        if (dashDashIdx === -1) {
          throw new UsageError(
            "Missing '--' separator before the command to run.\n" +
              "Example: termix inject credential 1 2 -- python script.py",
          );
        }

        const targetTokens = argsAfterInject.slice(0, dashDashIdx);
        const commandParts = argsAfterInject.slice(dashDashIdx + 1);

        if (commandParts.length === 0) {
          throw new UsageError("No command specified after '--'.");
        }

        // Filter out keyword 'credential' or 'credentials' if user passed it
        const idStrings = targetTokens.filter(
          (t) =>
            t.toLowerCase() !== "credential" &&
            t.toLowerCase() !== "credentials" &&
            !t.startsWith("-"),
        );

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
        const injectedEnv: Record<string, string> = {};
        const secretsToMask: Set<string> = new Set();

        // Fetch each credential from Termix
        let exportedHostsCache: Array<Record<string, unknown>> | null = null;

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

          const baseName = normalizeEnvName(cred.name || `CREDENTIAL_${cid}`);
          const username = cred.username || "";
          const password = cred.password || "";
          let privateKey = cred.key || cred.privateKey || "";

          // If authType is key and privateKey is not directly present, try resolving from export
          if (cred.authType === "key" && !privateKey) {
            if (exportedHostsCache === null) {
              try {
                const exp = await client.request<{
                  hosts?: Array<Record<string, unknown>>;
                }>({
                  method: "GET",
                  path: "/plugin-api/import-export/export",
                });
                exportedHostsCache = exp.hosts || [];
              } catch {
                exportedHostsCache = [];
              }
            }
            const match = exportedHostsCache.find(
              (h) =>
                h.credentialId === cid && typeof h.key === "string" && h.key,
            );
            if (match && typeof match.key === "string") {
              privateKey = match.key;
            }
          }

          // Register secrets to mask from stdout/stderr output (min 4 chars to prevent accidental false positives)
          if (password && password.length >= 4) {
            secretsToMask.add(password);
          }
          if (privateKey && privateKey.length >= 10) {
            secretsToMask.add(privateKey.trim());
            // Also mask individual base64 lines of the key if split
            for (const line of privateKey.split("\n")) {
              const trimmed = line.trim();
              if (trimmed.length >= 16 && !trimmed.startsWith("-----")) {
                secretsToMask.add(trimmed);
              }
            }
          }

          // Inject into environment:
          // 1. By ID
          if (username) {
            injectedEnv[`TERMIX_${cid}_USER`] = username;
            injectedEnv[`TERMIX_CREDENTIAL_${cid}_USERNAME`] = username;
          }
          if (password) {
            injectedEnv[`TERMIX_${cid}_PASS`] = password;
            injectedEnv[`TERMIX_${cid}_PASSWORD`] = password;
            injectedEnv[`TERMIX_CREDENTIAL_${cid}_PASSWORD`] = password;
          }
          if (privateKey) {
            injectedEnv[`TERMIX_${cid}_KEY`] = privateKey;
            injectedEnv[`TERMIX_CREDENTIAL_${cid}_PRIVATE_KEY`] = privateKey;
          }

          // 2. By Normalized Name
          if (username) {
            injectedEnv[`${baseName}_USER`] = username;
            injectedEnv[`${baseName}_USERNAME`] = username;
          }
          if (password) {
            injectedEnv[`${baseName}_PASS`] = password;
            injectedEnv[`${baseName}_PASSWORD`] = password;
            injectedEnv[baseName] = password;
          }
          if (privateKey) {
            injectedEnv[`${baseName}_KEY`] = privateKey;
            injectedEnv[`${baseName}_PRIVATE_KEY`] = privateKey;
            if (!password) {
              injectedEnv[baseName] = privateKey;
            }
          }
        }

        // Sort secrets by length descending so longer substrings are masked first
        const sortedSecrets = Array.from(secretsToMask).sort(
          (a, b) => b.length - a.length,
        );

        const bin = commandParts[0];
        if (!bin) {
          throw new UsageError("No executable binary specified.");
        }
        const cmdArgs = commandParts.slice(1);

        // Spawn child process with piped output for real-time redaction/masking
        const child: ChildProcess = spawn(bin, cmdArgs, {
          stdio: ["inherit", "pipe", "pipe"],
          env: {
            ...process.env,
            ...injectedEnv,
          },
        });

        child.stdout?.on("data", (chunk: Buffer) => {
          process.stdout.write(maskSecrets(chunk, sortedSecrets));
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          process.stderr.write(maskSecrets(chunk, sortedSecrets));
        });

        const forwardSignal = (sig: NodeJS.Signals): void => {
          child.kill(sig);
        };
        process.once("SIGINT", forwardSignal);
        process.once("SIGTERM", forwardSignal);

        child.on("close", (code: number | null) => {
          process.off("SIGINT", forwardSignal);
          process.off("SIGTERM", forwardSignal);
          process.exit(code ?? ExitCode.OK);
        });

        child.on("error", (err: Error) => {
          process.off("SIGINT", forwardSignal);
          process.off("SIGTERM", forwardSignal);
          fail(err, ExitCode.INTERNAL);
        });
      } catch (error) {
        fail(error, ExitCode.INTERNAL);
      }
    });
}
