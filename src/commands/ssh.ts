import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { requireSessionToken } from "../core/auth.js";
import { ExitCode, UsageError } from "../core/errors.js";
import { fail, printInfo } from "../core/output/index.js";
import { confirm, prompt, promptHidden } from "../core/prompt.js";
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
    .option(
      "--trust-host-key",
      "Trust a host key seen for the first time without asking. A changed key is never trusted this way",
    )
    .action(async function (
      this: Command,
      hostIdArg: string,
      opts: {
        command?: string;
        path?: string;
        tmux?: string;
        trustHostKey?: boolean;
      },
    ) {
      let tty: { restore: () => void } | undefined;
      try {
        const id = parseId(hostIdArg);
        const { config, client, requireFeature } = await createContext(this);
        const token = requireSessionToken(config, "`termix ssh`");
        await requireFeature("terminal");

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
        await socket.waitUntilReady();

        const exitCode = await runSession(socket, {
          hostConfig,
          interactive,
          command: opts.command,
          path: opts.path,
          tmux: opts.tmux,
          trustHostKey: opts.trustHostKey === true,
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

const READY = ["connected", "sessionAttached"];
const AUTH_STEPS = [
  "host_key_verification_required",
  "host_key_changed",
  "passphrase_required",
  "totp_required",
  "totp_retry",
  "password_required",
  "auth_method_not_available",
  "*_auth_required",
];
const MAX_AUTH_ROUNDS = 10;

interface HostKeyData {
  fingerprint?: string;
  keyType?: string;
  oldFingerprint?: string;
  oldKeyType?: string;
}

/**
 * Ask whether to trust a host key, like ssh does. A new key can be trusted up
 * front with --trust-host-key; a changed one always needs a person.
 */
export async function decideHostKey(
  changed: boolean,
  data: HostKeyData,
  hostLabel: string,
  trustNew: boolean,
): Promise<boolean> {
  if (!changed && trustNew) return true;
  if (changed) {
    process.stderr.write(
      `WARNING: the host key for ${hostLabel} has changed. Someone may be intercepting the connection.\n` +
        `  Old: ${data.oldKeyType ?? "?"} ${data.oldFingerprint ?? "?"}\n` +
        `  New: ${data.keyType ?? "?"} ${data.fingerprint ?? "?"}\n`,
    );
  } else {
    process.stderr.write(
      `The host key for ${hostLabel} has not been seen before.\n` +
        `  ${data.keyType ?? "?"} ${data.fingerprint ?? "?"}\n`,
    );
  }
  return confirm(changed ? "Trust the new key anyway?" : "Trust this key?");
}

/**
 * Answer whatever the host asks before the shell opens: its host key, a key
 * passphrase, a verification code or a keyboard-interactive password. A
 * browser sign-in cannot happen in a terminal, so that fails straight away.
 */
export async function completeAuth(
  socket: TerminalSocket,
  connect: { cols: number; rows: number; hostConfig: HostConfig },
  trustHostKey: boolean,
): Promise<void> {
  const label = `${connect.hostConfig.username}@${connect.hostConfig.ip}:${connect.hostConfig.port}`;
  for (let round = 0; round < MAX_AUTH_ROUNDS; round++) {
    const message = await socket.waitFor([...READY, ...AUTH_STEPS]);
    if (READY.includes(message.type)) return;

    switch (message.type) {
      case "host_key_verification_required":
      case "host_key_changed": {
        const accept = await decideHostKey(
          message.type === "host_key_changed",
          (message.data ?? {}) as HostKeyData,
          label,
          trustHostKey,
        );
        socket.send("host_key_verification_response", {
          action: accept ? "accept" : "reject",
        });
        if (!accept)
          throw new Error(
            "Host key not trusted, so the connection was closed.",
          );
        break;
      }
      case "auth_method_not_available": {
        // The host has no saved login the server can use, so ask for one.
        const password = await promptHidden("Password: ");
        socket.send("reconnect_with_credentials", { ...connect, password });
        break;
      }
      case "passphrase_required": {
        const keyPassword = await promptHidden("Key passphrase: ");
        socket.send("reconnect_with_credentials", { ...connect, keyPassword });
        break;
      }
      case "totp_required":
      case "totp_retry": {
        const label =
          message.type === "totp_retry"
            ? "That code did not work. Verification code:"
            : message.prompt?.trim() || "Verification code:";
        socket.send("totp_response", { code: await promptHidden(`${label} `) });
        break;
      }
      case "password_required": {
        const label = message.isPush
          ? "Approve the sign-in on your device, then press Enter:"
          : message.prompt?.trim() || "Password:";
        const code =
          message.echo || message.isPush
            ? await prompt(`${label} `)
            : await promptHidden(`${label} `);
        socket.send("password_response", { code });
        break;
      }
      default:
        throw new Error(
          `Host ${connect.hostConfig.id} needs a browser sign-in, which the CLI cannot do. Use the web UI.`,
        );
    }
  }
  throw new Error("The host kept asking for more sign-in steps.");
}

interface SessionOptions {
  hostConfig: HostConfig;
  interactive: boolean;
  command?: string;
  path?: string;
  tmux?: string;
  trustHostKey: boolean;
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

  await completeAuth(
    socket,
    { cols, rows, hostConfig: opts.hostConfig },
    opts.trustHostKey,
  );

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

    // The server types executeCommand into the shell on a timer, so the
    // command has not run yet when the session reports connected. Wait until
    // its output stops arriving before asking the shell to exit, rather than
    // racing a fixed delay.
    let idleTimer: NodeJS.Timeout | undefined;
    const scheduleExit = (): void => {
      if (opts.interactive || !opts.command) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => socket.input("exit\n"), 1500);
      idleTimer.unref?.();
    };

    socket.onMessage((message) => {
      switch (message.type) {
        case "data":
          // Remote output is the command's output, so it belongs on stdout.
          process.stdout.write(String(message.data ?? ""));
          scheduleExit();
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
      return;
    }

    // Nothing has arrived yet, so start the idle countdown: a command that
    // produces no output still needs the session to end.
    scheduleExit();
  });
}
