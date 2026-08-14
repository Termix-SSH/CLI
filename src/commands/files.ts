import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { createContext } from "../core/context.js";
import type { TermixClient } from "../core/http.js";
import { UsageError } from "../core/errors.js";
import {
  printList,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";
import { parseId } from "./hosts.js";

interface HostRecord {
  ip?: string;
  port?: number;
  username?: string;
  authType?: string;
  credentialId?: number;
}

interface FileEntry extends Record<string, unknown> {
  name?: string;
  type?: string;
  size?: number;
  modified?: string;
  permissions?: string;
}

const FILE_COLUMNS: Column<FileEntry>[] = [
  { header: "name", value: (f) => f.name },
  { header: "type", value: (f) => f.type },
  { header: "size", value: (f) => f.size, align: "right" },
  { header: "modified", value: (f) => f.modified },
  { header: "permissions", value: (f) => f.permissions },
];

/**
 * An SFTP session on a host.
 *
 * The file-manager API is session-oriented: connect once, operate against the
 * session id, then disconnect. The id is generated client-side, and the server
 * ties it to the authenticated user.
 */
class SftpSession {
  private constructor(
    private readonly client: TermixClient,
    readonly sessionId: string,
  ) {}

  static async open(
    client: TermixClient,
    hostId: number,
  ): Promise<SftpSession> {
    const host = await client.request<HostRecord>({
      method: "GET",
      path: `/host/db/host/${hostId}`,
    });
    if (!host.ip || !host.username) {
      throw new UsageError(
        `Host ${hostId} is missing an address or username, so files cannot be browsed.`,
      );
    }

    const sessionId = `cli-${randomUUID()}`;
    const result = await client.request<{ requiresTOTP?: boolean }>({
      method: "POST",
      path: "/ssh/file_manager/ssh/connect",
      service: "files",
      data: {
        sessionId,
        hostId,
        ip: host.ip,
        port: host.port ?? 22,
        username: host.username,
        authType: host.authType,
        credentialId: host.credentialId,
      },
    });

    if (result?.requiresTOTP) {
      throw new UsageError(
        "This host needs two-factor confirmation, which the file commands cannot prompt for. Use the web UI or `termix ssh`.",
      );
    }

    return new SftpSession(client, sessionId);
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const data = await this.client.request<
      FileEntry[] | { files?: FileEntry[] }
    >({
      method: "GET",
      path: "/ssh/file_manager/ssh/listFiles",
      service: "files",
      params: { sessionId: this.sessionId, path: remotePath },
    });
    if (Array.isArray(data)) return data;
    return data?.files ?? [];
  }

  async read(remotePath: string): Promise<string> {
    const data = await this.client.request<{ content?: string } | string>({
      method: "GET",
      path: "/ssh/file_manager/ssh/readFile",
      service: "files",
      params: { sessionId: this.sessionId, path: remotePath },
    });
    if (typeof data === "string") return data;
    return data?.content ?? "";
  }

  async write(remotePath: string, content: string): Promise<void> {
    await this.client.request({
      method: "POST",
      path: "/ssh/file_manager/ssh/writeFile",
      service: "files",
      data: { sessionId: this.sessionId, path: remotePath, content },
    });
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.client.request({
      method: "POST",
      path: "/ssh/file_manager/ssh/createFolder",
      service: "files",
      data: {
        sessionId: this.sessionId,
        path: path.posix.dirname(remotePath),
        folderName: path.posix.basename(remotePath),
      },
    });
  }

  async remove(remotePath: string, isDirectory: boolean): Promise<void> {
    await this.client.request({
      method: "DELETE",
      path: "/ssh/file_manager/ssh/deleteItem",
      service: "files",
      data: {
        sessionId: this.sessionId,
        path: remotePath,
        isDirectory,
      },
    });
  }

  async close(): Promise<void> {
    try {
      await this.client.request({
        method: "POST",
        path: "/ssh/file_manager/ssh/disconnect",
        service: "files",
        data: { sessionId: this.sessionId },
      });
    } catch {
      // The session times out server-side anyway; a failed disconnect must
      // not mask the result of the command the user actually ran.
    }
  }
}

/**
 * Run `fn` against a session, always disconnecting afterwards - including on
 * Ctrl-C, which would otherwise strand an SFTP connection on the server.
 */
async function withSession<T>(
  client: TermixClient,
  hostId: number,
  fn: (session: SftpSession) => Promise<T>,
): Promise<T> {
  const session = await SftpSession.open(client, hostId);

  const onSignal = (): void => {
    void session.close().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    return await fn(session);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await session.close();
  }
}

/** Split `host:/path` into its parts. */
export function parseRemote(value: string): { hostId: number; path: string } {
  const index = value.indexOf(":");
  if (index <= 0) {
    throw new UsageError(
      `Invalid remote path "${value}" (expected HOST_ID:/path, e.g. 3:/etc/hosts).`,
    );
  }
  const remotePath = value.slice(index + 1);
  if (!remotePath) {
    throw new UsageError(`Invalid remote path "${value}" (no path after ":").`);
  }
  return {
    hostId: parseId(value.slice(0, index), "host id"),
    path: remotePath,
  };
}

export function registerFileCommands(program: Command): void {
  const files = program
    .command("files")
    .description("Browse and transfer files on a host over SFTP.");

  files
    .command("ls <remote>")
    .description("List a remote directory, given as HOST_ID:/path.")
    .action(async function (this: Command, remote: string) {
      await run(async () => {
        const { hostId, path: remotePath } = parseRemote(remote);
        const { client } = await createContext(this);
        const entries = await withSession(client, hostId, (session) =>
          session.list(remotePath),
        );
        printList(entries, FILE_COLUMNS, { quietField: "name" });
      });
    });

  files
    .command("cat <remote>")
    .description("Print a remote file, given as HOST_ID:/path.")
    .action(async function (this: Command, remote: string) {
      await run(async () => {
        const { hostId, path: remotePath } = parseRemote(remote);
        const { client } = await createContext(this);
        const content = await withSession(client, hostId, (session) =>
          session.read(remotePath),
        );
        // File contents are the result, so they go to stdout unchanged.
        process.stdout.write(content);
      });
    });

  files
    .command("get <remote> [localPath]")
    .description("Download a remote file. Defaults to the basename in the CWD.")
    .action(async function (this: Command, remote: string, localPath?: string) {
      await run(async () => {
        const { hostId, path: remotePath } = parseRemote(remote);
        const { client } = await createContext(this);
        const content = await withSession(client, hostId, (session) =>
          session.read(remotePath),
        );

        const target = resolveLocalTarget(localPath, remotePath);
        fs.writeFileSync(target, content, "utf8");
        printResult(`Downloaded ${remotePath} to ${target}.`, { path: target });
      });
    });

  files
    .command("put <localPath> <remote>")
    .description("Upload a local file to HOST_ID:/path.")
    .action(async function (this: Command, localPath: string, remote: string) {
      await run(async () => {
        const { hostId, path: remotePath } = parseRemote(remote);
        let content: string;
        try {
          content = fs.readFileSync(localPath, "utf8");
        } catch {
          throw new UsageError(`Could not read local file: ${localPath}`);
        }

        const { client } = await createContext(this);
        await withSession(client, hostId, (session) =>
          session.write(remotePath, content),
        );
        printResult(`Uploaded ${localPath} to ${remotePath}.`, {
          path: remotePath,
        });
      });
    });

  files
    .command("mkdir <remote>")
    .description("Create a remote directory.")
    .action(async function (this: Command, remote: string) {
      await run(async () => {
        const { hostId, path: remotePath } = parseRemote(remote);
        const { client } = await createContext(this);
        await withSession(client, hostId, (session) =>
          session.mkdir(remotePath),
        );
        printResult(`Created ${remotePath}.`, { path: remotePath });
      });
    });

  files
    .command("rm <remote>")
    .description("Delete a remote file, or a directory with --recursive.")
    .option("-r, --recursive", "Delete a directory and its contents")
    .action(async function (
      this: Command,
      remote: string,
      opts: { recursive?: boolean },
    ) {
      await run(async () => {
        const { hostId, path: remotePath } = parseRemote(remote);
        const { client } = await createContext(this);
        await withSession(client, hostId, (session) =>
          session.remove(remotePath, opts.recursive === true),
        );
        printResult(`Deleted ${remotePath}.`, { path: remotePath });
      });
    });
}

/** Resolve the local destination, treating an existing directory as a parent. */
function resolveLocalTarget(
  localPath: string | undefined,
  remotePath: string,
): string {
  const basename = path.posix.basename(remotePath);
  if (!localPath) return basename;
  try {
    if (fs.statSync(localPath).isDirectory()) {
      return path.join(localPath, basename);
    }
  } catch {
    // Does not exist yet: treat it as the target filename.
  }
  return localPath;
}
