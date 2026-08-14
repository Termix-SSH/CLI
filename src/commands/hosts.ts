import type { Command } from "commander";
import { resolveConfig } from "../core/config.js";
import { TermixClient } from "../core/http.js";
import { printJson, run } from "../core/output.js";
import {
  addHostFieldOptions,
  buildHostPayload,
  type HostFieldOpts,
} from "./host-fields.js";

/**
 * Non-secret host fields safe to print. An allowlist (vs deleting known secret
 * keys) guarantees that any future secret field added by the backend cannot
 * leak by default. The backend already strips secrets from list/get responses
 * (stripSensitiveFields, replacing them with `has*` flags); the allowlist is
 * defense-in-depth on top of that.
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
  "createdAt",
  "updatedAt",
] as const;

/**
 * Server-managed / derived fields to drop from a read-modify-write update so we
 * never echo them back (ids, timestamps, host-key state, and the `has*` secret
 * presence flags — the real secrets are preserved server-side when omitted).
 */
const SERVER_MANAGED_HOST_FIELDS = [
  "id",
  "userId",
  "createdAt",
  "updatedAt",
  "hasPassword",
  "hasKey",
  "hasKeyPassword",
  "hasSudoPassword",
  "hostKeyFingerprint",
  "hostKeyType",
  "hostKeyAlgorithm",
  "hostKeyFirstSeen",
  "hostKeyLastVerified",
  "hostKeyChangedCount",
] as const;

function sanitiseHost(host: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SAFE_HOST_FIELDS) {
    if (key in host) out[key] = host[key];
  }
  return out;
}

/** Compact summary used by `hosts list`. */
function summariseHost(host: Record<string, unknown>): Record<string, unknown> {
  return {
    id: host.id,
    name: host.name,
    ip: host.ip,
    port: host.port,
    username: host.username,
    authType: host.authType,
    folder: host.folder ?? null,
    tags: host.tags,
  };
}

export function registerHostCommands(program: Command): void {
  const hosts = program
    .command("hosts")
    .description("Inspect the SSH hosts configured in Termix.");

  hosts
    .command("list")
    .description("List hosts (id, name, ip, port, username, folder, tags).")
    .option("--folder <folder>", "Only hosts in this folder")
    .action(async (opts: { folder?: string }) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const all = await client.request<Array<Record<string, unknown>>>({
          method: "GET",
          path: "/host/db/host",
        });
        let summaries = all.map(summariseHost);
        if (opts.folder) {
          summaries = summaries.filter((h) => h.folder === opts.folder);
        }
        printJson({ count: summaries.length, hosts: summaries });
      }),
    );

  hosts
    .command("get <hostId>")
    .description("Show one host's configuration (secrets are never printed).")
    .action(async (hostId: string) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const host = await client.request<Record<string, unknown>>({
          method: "GET",
          path: `/host/db/host/${parseId(hostId)}`,
        });
        printJson(sanitiseHost(host));
      }),
    );

  hosts
    .command("status [hostId]")
    .description("Online/offline status for all hosts, or a single host by id.")
    .action(async (hostId?: string) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const path = hostId ? `/status/${parseId(hostId)}` : "/status";
        const status = await client.request({ method: "GET", path });
        printJson(status);
      }),
    );

  addHostFieldOptions(
    hosts
      .command("create")
      .description(
        "Create a new SSH host. --ip and --username are required; provide a --password or --key-file.",
      ),
  ).action(async (opts: HostFieldOpts) =>
    run(async () => {
      if (!opts.ip || !opts.username) {
        throw new Error("`hosts create` requires --ip and --username.");
      }
      // Require an auth method up front: without one the backend returns an
      // opaque HTTP 500, so fail here with an actionable message instead.
      if (
        opts.password === undefined &&
        opts.keyFile === undefined &&
        opts.credentialId === undefined
      ) {
        throw new Error(
          "`hosts create` needs an auth method: pass --password, --key-file or --credential-id.",
        );
      }
      // Sensible create defaults: Termix requires a valid port, and the auth
      // type can be inferred from whichever secret was supplied.
      if (opts.port === undefined) opts.port = "22";
      if (opts.authType === undefined) {
        if (opts.password !== undefined) opts.authType = "password";
        else if (opts.keyFile !== undefined) opts.authType = "key";
      }
      const client = new TermixClient(resolveConfig());
      const created = await client.request<Record<string, unknown>>({
        method: "POST",
        path: "/host/db/host",
        data: buildHostPayload(opts),
      });
      printJson({ id: created.id, name: created.name });
    }),
  );

  addHostFieldOptions(
    hosts
      .command("update <hostId>")
      .description(
        "Update fields of an existing SSH host (only the options you pass are changed; other fields are preserved).",
      ),
  ).action(async (hostId: string, opts: HostFieldOpts) =>
    run(async () => {
      const client = new TermixClient(resolveConfig());
      const id = parseId(hostId);

      // Termix's PUT replaces the whole host definition and requires ip/port,
      // so read-modify-write: fetch the current host, apply the CLI overrides,
      // and send the merged object. The server strips secrets from GET
      // responses, so omitting them here means it keeps the existing
      // password/key.
      const current = await client.request<Record<string, unknown>>({
        method: "GET",
        path: `/host/db/host/${id}`,
      });
      // Defensive: never round-trip a secret field the server might return in
      // the future (strip from `current`, not `merged`, so secrets passed via
      // CLI options survive).
      for (const key of ["password", "key", "keyPassword"]) delete current[key];
      const merged = { ...current, ...buildHostPayload(opts) };
      for (const key of SERVER_MANAGED_HOST_FIELDS) delete merged[key];

      const updated = await client.request<Record<string, unknown>>({
        method: "PUT",
        path: `/host/db/host/${id}`,
        data: merged,
      });
      printJson({ id: updated.id ?? id, name: merged.name });
    }),
  );

  hosts
    .command("delete <hostId>")
    .description("Delete an SSH host by id.")
    .action(async (hostId: string) =>
      run(async () => {
        const client = new TermixClient(resolveConfig());
        const data = await client.request({
          method: "DELETE",
          path: `/host/db/host/${parseId(hostId)}`,
        });
        printJson(data);
      }),
    );
}

export function parseId(value: string, label = "id"): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `Invalid ${label}: "${value}" (expected a positive integer).`,
    );
  }
  return id;
}
