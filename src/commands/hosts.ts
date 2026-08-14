import fs from "node:fs";
import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { UsageError } from "../core/errors.js";
import {
  printList,
  printRecord,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";
import {
  addHostFieldOptions,
  buildHostPayload,
  type HostFieldOpts,
} from "./host-fields.js";

/**
 * Non-secret host fields safe to print. An allowlist (rather than deleting
 * known secret keys) guarantees that any future secret field added by the
 * backend cannot leak by default. The backend already strips secrets from
 * list/get responses, replacing them with `has*` flags; this is defence in
 * depth on top of that.
 */
const SAFE_HOST_FIELDS = [
  "id",
  "name",
  "ip",
  "port",
  "username",
  "connectionType",
  "authType",
  "folder",
  "tags",
  "pin",
  "credentialId",
  "enableTerminal",
  "enableTunnel",
  "enableFileManager",
  "enableDocker",
  "hasPassword",
  "hasKey",
  "createdAt",
  "updatedAt",
] as const;

export function sanitiseHost(
  host: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SAFE_HOST_FIELDS) {
    if (key in host) out[key] = host[key];
  }
  return out;
}

type HostRow = Record<string, unknown>;

const HOST_COLUMNS: Column<HostRow>[] = [
  { header: "id", value: (h) => h.id, align: "right" },
  { header: "name", value: (h) => h.name },
  {
    header: "address",
    value: (h) => `${h.username ?? ""}@${h.ip ?? ""}:${h.port ?? 22}`,
  },
  { header: "auth", value: (h) => h.authType },
  { header: "folder", value: (h) => h.folder },
  { header: "tags", value: (h) => h.tags },
];

export function registerHostCommands(program: Command): void {
  const hosts = program
    .command("hosts")
    .description("Manage the SSH hosts configured in Termix.");

  hosts
    .command("list", { isDefault: true })
    .description("List hosts.")
    .option("--folder <folder>", "Only hosts in this folder")
    .option("--tag <tag>", "Only hosts carrying this tag")
    .action(async function (
      this: Command,
      opts: { folder?: string; tag?: string },
    ) {
      await run(async () => {
        const { client } = await createContext(this);
        const all = await client.request<HostRow[]>({
          method: "GET",
          path: "/host/db/host",
        });

        let rows = all;
        if (opts.folder) rows = rows.filter((h) => h.folder === opts.folder);
        if (opts.tag) {
          rows = rows.filter((h) =>
            toTags(h.tags).includes(opts.tag as string),
          );
        }

        printList(rows.map(sanitiseHost), HOST_COLUMNS, {
          jsonWrapper: (r) => ({ count: r.length, hosts: r }),
        });
      });
    });

  hosts
    .command("get <hostId>")
    .description("Show one host's configuration. Secrets are never printed.")
    .action(async function (this: Command, hostId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        const host = await client.request<HostRow>({
          method: "GET",
          path: `/host/db/host/${parseId(hostId)}`,
        });
        printRecord(sanitiseHost(host));
      });
    });

  addHostFieldOptions(
    hosts
      .command("create")
      .description(
        "Create an SSH host. --ip and --username are required, plus one of --password, --key-file or --credential-id.",
      ),
  ).action(async function (this: Command, opts: HostFieldOpts) {
    await run(async () => {
      if (!opts.ip || !opts.username) {
        throw new UsageError("`hosts create` requires --ip and --username.");
      }
      // Require an auth method up front: without one the backend returns an
      // opaque 500, so fail here with something actionable instead.
      if (
        opts.password === undefined &&
        opts.keyFile === undefined &&
        opts.credentialId === undefined
      ) {
        throw new UsageError(
          "`hosts create` needs an auth method: pass --password, --key-file or --credential-id.",
        );
      }

      if (opts.port === undefined) opts.port = "22";
      if (opts.authType === undefined) {
        if (opts.password !== undefined) opts.authType = "password";
        else if (opts.keyFile !== undefined) opts.authType = "key";
      }

      const { client } = await createContext(this);
      const created = await client.request<HostRow>({
        method: "POST",
        path: "/host/db/host",
        data: buildHostPayload(opts),
      });
      printResult(`Created host ${created.id}.`, {
        id: created.id,
        name: created.name,
      });
    });
  });

  addHostFieldOptions(
    hosts
      .command("update <hostId>")
      .description("Update an existing host. Only the fields you pass change."),
  ).action(async function (this: Command, hostId: string, opts: HostFieldOpts) {
    await run(async () => {
      const { client } = await createContext(this);
      const id = parseId(hostId);
      const payload = buildHostPayload(opts);

      if (Object.keys(payload).length <= 1) {
        throw new UsageError(
          "`hosts update` needs at least one field to change.",
        );
      }

      // Termix's PUT replaces the whole host definition, and there is no PATCH
      // route, so this has to read-modify-write. Omitted secrets are preserved
      // server-side, and GET never returns them, so the merge cannot leak or
      // clobber a password.
      const current = await client.request<HostRow>({
        method: "GET",
        path: `/host/db/host/${id}`,
      });
      const merged = { ...stripServerManaged(current), ...payload };

      await client.request<HostRow>({
        method: "PUT",
        path: `/host/db/host/${id}`,
        data: merged,
      });

      // Re-read rather than trusting the request body: the server normalises
      // some fields, so echoing what we sent could report a name it rejected.
      const saved = await client.request<HostRow>({
        method: "GET",
        path: `/host/db/host/${id}`,
      });
      printResult(`Updated host ${id}.`, { id, name: saved.name });
    });
  });

  hosts
    .command("delete <hostId>")
    .description("Delete an SSH host.")
    .action(async function (this: Command, hostId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        const id = parseId(hostId);
        await client.request({
          method: "DELETE",
          path: `/host/db/host/${id}`,
        });
        printResult(`Deleted host ${id}.`, { id });
      });
    });

  hosts
    .command("export")
    .description(
      "Export every host as JSON. The export contains decrypted credentials, " +
        "so treat the output as a secret.",
    )
    .option("--output <path>", "Write to a file instead of stdout")
    .option("--share", "Strip personal fields for sharing")
    .action(async function (
      this: Command,
      opts: { output?: string; share?: boolean },
    ) {
      await run(async () => {
        const { client } = await createContext(this);
        const data = await client.request<unknown>({
          method: "GET",
          path: "/host/db/hosts/export",
          params: opts.share ? { share: "1" } : undefined,
        });

        const json = `${JSON.stringify(data, null, 2)}\n`;
        if (opts.output) {
          // 0600 because the export carries plaintext credentials.
          fs.writeFileSync(opts.output, json, { mode: 0o600 });
          printResult(`Exported hosts to ${opts.output}.`, {
            path: opts.output,
          });
          return;
        }
        process.stdout.write(json);
      });
    });

  hosts
    .command("import <file>")
    .description("Import hosts from a JSON export (up to 100 at a time).")
    .option("--overwrite", "Replace hosts that already exist")
    .action(async function (
      this: Command,
      file: string,
      opts: { overwrite?: boolean },
    ) {
      await run(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          throw new UsageError(`Could not read a JSON export from: ${file}`);
        }

        // Accept either a bare array or a full export envelope.
        const payload = parsed as {
          hosts?: unknown;
          credentials?: unknown;
        };
        const hostList = Array.isArray(parsed) ? parsed : payload.hosts;
        if (!Array.isArray(hostList) || hostList.length === 0) {
          throw new UsageError(`${file} contains no hosts to import.`);
        }
        if (hostList.length > 100) {
          throw new UsageError(
            `${file} contains ${hostList.length} hosts; the server accepts at most 100 per import.`,
          );
        }

        const { client } = await createContext(this);
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/host/bulk-import",
          data: {
            hosts: hostList,
            overwrite: opts.overwrite === true,
            ...(Array.isArray(payload.credentials)
              ? { credentials: payload.credentials }
              : {}),
          },
        });
        printResult(`Imported ${hostList.length} hosts.`, result);
      });
    });

  addHostFieldOptions(
    hosts
      .command("enroll")
      .description(
        "Register a host for automated provisioning. Requires an API key, and " +
          "defaults to port 22 with the terminal enabled.",
      ),
  ).action(async function (this: Command, opts: HostFieldOpts) {
    await run(async () => {
      const { config, client } = await createContext(this);

      // The server rejects a session token here with API_KEY_REQUIRED, so say
      // so before making a request that cannot succeed.
      if (!config.apiKey) {
        throw new UsageError(
          "`hosts enroll` requires an API key. Pass --api-key or set TERMIX_API_KEY.",
        );
      }
      if (!opts.ip) {
        throw new UsageError("`hosts enroll` requires --ip.");
      }

      const created = await client.request<HostRow>({
        method: "POST",
        path: "/host/enroll",
        data: buildHostPayload(opts),
      });
      printResult(`Enrolled host ${created.id}.`, {
        id: created.id,
        name: created.name,
      });
    });
  });
}

/**
 * Drop fields the server owns before echoing a host back in an update.
 *
 * The `has*` presence flags and `hostKey*` state are matched by prefix rather
 * than listed individually, so new fields of those families are handled
 * without this needing an edit every time the backend grows one. Secrets are
 * stripped defensively even though GET does not return them today.
 */
const SERVER_MANAGED_EXACT = new Set([
  "id",
  "userId",
  "createdAt",
  "updatedAt",
  "isShared",
  "permissionLevel",
  "sharedExpiresAt",
  "ownerUsername",
  "password",
  "key",
  "keyPassword",
]);

function stripServerManaged(host: HostRow): HostRow {
  const out: HostRow = {};
  for (const [key, value] of Object.entries(host)) {
    if (SERVER_MANAGED_EXACT.has(key)) continue;
    if (/^has[A-Z]/.test(key)) continue;
    if (key.startsWith("hostKey")) continue;
    out[key] = value;
  }
  return out;
}

function toTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return value.split(",");
  return [];
}

export function parseId(value: string, label = "id"): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new UsageError(
      `Invalid ${label}: "${value}" (expected a positive integer).`,
    );
  }
  return id;
}
