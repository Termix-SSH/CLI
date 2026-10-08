import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { Command } from "commander";
import { createContext } from "../core/context.js";
import type { TermixClient } from "../core/http.js";
import { TermixApiError, UsageError } from "../core/errors.js";
import { openSshSession } from "../core/ssh-connect.js";
import { pluginPath } from "../api/features.js";
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

/** Upload body for a local file: text as-is, anything else as base64. */
export function encodeUpload(data: Buffer): {
  content: string;
  encoding?: "base64";
} {
  if (isUtf8(data) && !data.includes(0))
    return { content: data.toString("utf8") };
  return { content: data.toString("base64"), encoding: "base64" };
}

/** The file manager sends binary files as base64 and says so. */
export function decodeDownload(
  data: { content?: string; encoding?: string } | string | undefined,
): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  const content = data?.content ?? "";
  return data?.encoding === "base64"
    ? Buffer.from(content, "base64")
    : Buffer.from(content, "utf8");
}

/**
 * An SFTP session on a host, through the file-manager plugin.
 *
 * The API is session-oriented: connect once, operate against the session id,
 * then disconnect. The id is generated client-side, and the server ties it to
 * the authenticated user.
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
    await openSshSession({
      client,
      hostId,
      sessionId,
      connectPath: pluginPath("files", "/connect"),
      totpPath: pluginPath("files", "/connect-totp"),
      passphraseField: "keyPassword",
      body: {
        sessionId,
        hostId,
        ip: host.ip,
        port: host.port ?? 22,
        username: host.username,
        authType: host.authType,
        credentialId: host.credentialId,
      },
    });

    return new SftpSession(client, sessionId);
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const data = await this.client.request<
      FileEntry[] | { files?: FileEntry[] }
    >({
      method: "GET",
      path: pluginPath("files", "/listFiles"),
      params: { sessionId: this.sessionId, path: remotePath },
    });
    if (Array.isArray(data)) return data;
    return data?.files ?? [];
  }

  async read(remotePath: string): Promise<Buffer> {
    const data = await this.client.request<
      { content?: string; encoding?: string } | string
    >({
      method: "GET",
      path: pluginPath("files", "/readFile"),
      params: { sessionId: this.sessionId, path: remotePath },
    });
    return decodeDownload(data);
  }

  async write(remotePath: string, data: Buffer): Promise<void> {
    await this.client.request({
      method: "POST",
      path: pluginPath("files", "/writeFile"),
      data: {
        sessionId: this.sessionId,
        path: remotePath,
        ...encodeUpload(data),
      },
    });
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.client.request({
      method: "POST",
      path: pluginPath("files", "/createFolder"),
      data: {
        sessionId: this.sessionId,
        path: path.posix.dirname(remotePath),
        folderName: path.posix.basename(remotePath),
      },
    });
  }

  async remove(
    remotePath: string,
    isDirectory: boolean,
    toTrash: boolean,
  ): Promise<void> {
    try {
      await this.client.request({
        method: "DELETE",
        path: pluginPath("files", "/deleteItem"),
        data: {
          sessionId: this.sessionId,
          path: remotePath,
          isDirectory,
          permanent: !toTrash,
        },
      });
    } catch (error) {
      if (toTrash && error instanceof TermixApiError && error.status === 409) {
        throw new Error(
          `Could not move ${remotePath} to the trash (${error.message}), so it was not deleted. Run without --trash to delete it for good.`,
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.request({
        method: "POST",
        path: pluginPath("files", "/disconnect"),
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
        const { client, requireFeature } = await createContext(this);
        await requireFeature("files");
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
        const { client, requireFeature } = await createContext(this);
        await requireFeature("files");
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
        const { client, requireFeature } = await createContext(this);
        await requireFeature("files");
        const content = await withSession(client, hostId, (session) =>
          session.read(remotePath),
        );

        const target = resolveLocalTarget(localPath, remotePath);
        fs.writeFileSync(target, content);
        printResult(`Downloaded ${remotePath} to ${target}.`, { path: target });
      });
    });

  files
    .command("put <localPath> <remote>")
    .description("Upload a local file to HOST_ID:/path.")
    .action(async function (this: Command, localPath: string, remote: string) {
      await run(async () => {
        const { hostId, path: remotePath } = parseRemote(remote);
        let content: Buffer;
        try {
          content = fs.readFileSync(localPath);
        } catch {
          throw new UsageError(`Could not read local file: ${localPath}`);
        }

        const { client, requireFeature } = await createContext(this);
        await requireFeature("files");
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
        const { client, requireFeature } = await createContext(this);
        await requireFeature("files");
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
    .option("--trash", "Move it to the server's trash instead of deleting it")
    .action(async function (
      this: Command,
      remote: string,
      opts: { recursive?: boolean; trash?: boolean },
    ) {
      await run(async () => {
        const { hostId, path: remotePath } = parseRemote(remote);
        const { client, requireFeature } = await createContext(this);
        await requireFeature("files");
        await withSession(client, hostId, (session) =>
          session.remove(
            remotePath,
            opts.recursive === true,
            opts.trash === true,
          ),
        );
        printResult(
          opts.trash
            ? `Moved ${remotePath} to the trash.`
            : `Deleted ${remotePath}.`,
          { path: remotePath, trashed: opts.trash === true },
        );
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
