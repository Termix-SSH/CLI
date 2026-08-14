import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { requireSessionToken } from "../core/auth.js";
import { ExitCode, UsageError } from "../core/errors.js";
import { fail, printInfo } from "../core/output/index.js";
import { promptHidden } from "../core/prompt.js";
import { TerminalSocket, type HostConfig } from "../terminal/ws-client.js";
import { currentSize, isInteractive, startTty } from "../terminal/tty.js";
import { parseId } from "./hosts.js";

interface HostRecord {
  id?: number;
  ip?: string;
  port?: number;
  username?: string;
  authType?: string;
  credentialId?: number;
}

/**
 * The server resolves stored secrets from the host id, but still validates
 * ip, port and username from the payload, so they have to be sent explicitly.
 */
function toHostConfig(id: number, host: HostRecord): HostConfig {
  if (!host.ip || !host.username) {
    throw new UsageError(
      `Host ${id} is missing an address or username, so it cannot be connected to.`,
    );
  }
  return {
    id,
    ip: host.ip,
    port: host.port ?? 22,
    username: host.username,
    authType: host.authType,
    credentialId: host.credentialId,
  };
}

export function registerSshCommands(program: Command): void {
  program
    .command("ssh <hostId>")
    .description(
      "Open an interactive terminal on a host. Requires a session token: " +
        "API keys cannot open a WebSocket.",
    )
    .option(
      "--command <command>",
      "Run a command instead of an interactive shell",
    )
    .option("--path <path>", "Directory to start in")
    .option("--tmux <session>", "Attach to a tmux session by name")
    .action(async function (
      this: Command,
      hostIdArg: string,
      opts: { command?: string; path?: string; tmux?: string },
    ) {
      let tty: { restore: () => void } | undefined;
      try {
        const id = parseId(hostIdArg);
        const { config, client } = await createContext(this);
        const token = requireSessionToken(config, "`termix ssh`");

        const host = await client.request<HostRecord>({
          method: "GET",
          path: `/host/db/host/${id}`,
        });
        const hostConfig = toHostConfig(id, host);

        const interactive = isInteractive();
        if (!interactive && !opts.command) {
          throw new UsageError(
            "`termix ssh` needs a terminal. Use --command, or `termix exec` for scripts.",
          );
        }

        const socket = new TerminalSocket(config, token);
        await socket.open();

        const exitCode = await runSession(socket, {
          hostConfig,
          interactive,
          command: opts.command,
          path: opts.path,
          tmux: opts.tmux,
          onTty: (session) => {
            tty = session;
          },
        });

        process.exitCode = exitCode;
      } catch (error) {
        tty?.restore();
        // Matches `exec`: the remote side owns the normal exit-code range.
        fail(error, ExitCode.INTERNAL);
      }
    });
}

interface SessionOptions {
  hostConfig: HostConfig;
  interactive: boolean;
  command?: string;
  path?: string;
  tmux?: string;
  onTty: (session: { restore: () => void }) => void;
}

async function runSession(
  socket: TerminalSocket,
  opts: SessionOptions,
): Promise<number> {
  const { cols, rows } = currentSize();

  socket.connectToHost({
    cols,
    rows,
    hostConfig: opts.hostConfig,
    initialPath: opts.path,
    executeCommand: opts.command,
    tmuxAttachSession: opts.tmux,
  });

  // The server answers a connect with `connected`, or asks for a key
  // passphrase first when the stored key is encrypted.
  let ready = await socket.waitFor([
    "connected",
    "passphrase_required",
    "sessionAttached",
  ]);

  if (ready.type === "passphrase_required") {
    const passphrase = await promptHidden("Key passphrase: ");
    socket.send("password_response", { password: passphrase });
    ready = await socket.waitFor(["connected", "sessionAttached"]);
  }

  return new Promise<number>((resolve) => {
    let tty: { restore: () => void } | undefined;
    let settled = false;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      // Restore the local terminal before anything else, so an error path
      // cannot leave the user's shell in raw mode.
      tty?.restore();
      socket.close();
      resolve(code);
    };

    socket.onMessage((message) => {
      switch (message.type) {
        case "data":
          // Remote output is the command's output, so it belongs on stdout.
          process.stdout.write(String(message.data ?? ""));
          break;
        case "error":
          process.stderr.write(`termix: ${message.message ?? "error"}\n`);
          finish(ExitCode.FAILURE);
          break;
        case "disconnected":
        case "session_ended":
        case "sessionExpired":
          finish(ExitCode.OK);
          break;
        default:
          break;
      }
    });

    socket.onClose(() => finish(ExitCode.OK));

    if (opts.interactive) {
      tty = startTty({
        onInput: (data) => socket.input(data),
        onResize: (nextCols, nextRows) => socket.resize(nextCols, nextRows),
      });
      opts.onTty(tty);
      printInfo(
        `Connected to ${opts.hostConfig.username}@${opts.hostConfig.ip}.`,
      );
    }
  });
}
