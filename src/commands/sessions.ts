import type { Command } from "commander";
import { createContext } from "../core/context.js";
import {
  printList,
  printResult,
  run,
  type Column,
} from "../core/output/index.js";

type Row = Record<string, unknown>;

const SESSION_COLUMNS: Column<Row>[] = [
  { header: "id", value: (s) => s.id },
  { header: "device", value: (s) => s.deviceType ?? s.device_type },
  { header: "info", value: (s) => s.deviceInfo ?? s.device_info },
  { header: "created", value: (s) => s.createdAt ?? s.created_at },
  { header: "last active", value: (s) => s.lastActiveAt ?? s.last_active_at },
  { header: "expires", value: (s) => s.expiresAt ?? s.expires_at },
];

/**
 * Session management. Termix tracks sessions in the database, so revoking one
 * takes effect immediately even though the JWT itself has not expired.
 */
export function registerSessionCommands(program: Command): void {
  const sessions = program
    .command("sessions")
    .description("List and revoke your active sessions.");

  sessions
    .command("list", { isDefault: true })
    .description("List active sessions and the devices holding them.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const data = await client.request<Row[] | { sessions?: Row[] }>({
          method: "GET",
          path: "/users/sessions",
        });
        const rows = Array.isArray(data) ? data : (data?.sessions ?? []);
        printList(rows, SESSION_COLUMNS);
      });
    });

  sessions
    .command("revoke <sessionId>")
    .description("Revoke a single session.")
    // Session ids are nanoids, which often start with "-".
    .allowUnknownOption()
    .action(async function (this: Command, sessionId: string) {
      await run(async () => {
        const { client } = await createContext(this);
        await client.request({
          method: "DELETE",
          path: `/users/sessions/${encodeURIComponent(sessionId)}`,
        });
        printResult(`Revoked session ${sessionId}.`, { id: sessionId });
      });
    });

  sessions
    .command("revoke-all")
    .description("Revoke every session, including this one.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        await client.request({
          method: "POST",
          path: "/users/sessions/revoke-all",
        });
        printResult(
          "Revoked all sessions. Run `termix login` to sign in again.",
        );
      });
    });
}
