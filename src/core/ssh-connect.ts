import type { TermixClient } from "./http.js";
import { promptHidden } from "./prompt.js";

/**
 * What a plugin's SSH connect route answers with. A plain success carries
 * none of these fields; the rest mean the host wants something from the user.
 */
export interface ConnectReply {
  status?: string;
  requires_totp?: boolean;
  /** Spelling used before the file manager became a plugin. */
  requiresTOTP?: boolean;
  requires_browser_sign_in?: boolean;
  prompt?: string;
  isPassword?: boolean;
  reason?: string;
}

export interface SshConnectOptions {
  client: TermixClient;
  hostId: number;
  sessionId: string;
  /** Route that opens the session. */
  connectPath: string;
  /** Route that answers a code or keyboard-interactive prompt. */
  totpPath: string;
  body: Record<string, unknown>;
  /** Body field the connect route reads a key passphrase from. */
  passphraseField: string;
}

const MAX_ROUNDS = 5;

/**
 * Open a session on a plugin that connects over SSH (file manager, Docker),
 * prompting on the terminal for a code, password or key passphrase when the
 * host asks for one.
 */
export async function openSshSession(opts: SshConnectOptions): Promise<void> {
  const { client, hostId, sessionId } = opts;
  const connect = (
    extra: Record<string, unknown> = {},
  ): Promise<ConnectReply> =>
    client.request<ConnectReply>({
      method: "POST",
      path: opts.connectPath,
      data: { ...opts.body, ...extra },
    });

  let reply = await connect();
  let askedPassphrase = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (!reply || typeof reply !== "object") return;

    if (reply.requires_totp || reply.requiresTOTP) {
      const label =
        reply.prompt?.trim() ||
        (reply.isPassword ? "Password:" : "Verification code:");
      const code = await promptHidden(`${label} `);
      reply = await client.request<ConnectReply>({
        method: "POST",
        path: opts.totpPath,
        data: { sessionId, totpCode: code },
      });
      continue;
    }

    if (reply.requires_browser_sign_in) {
      throw new Error(
        `Host ${hostId} needs a browser sign-in, which the CLI cannot do. Use the web UI.`,
      );
    }

    if (reply.status === "passphrase_required") {
      if (askedPassphrase)
        throw new Error("The key passphrase was not accepted.");
      askedPassphrase = true;
      const passphrase = await promptHidden("Key passphrase: ");
      reply = await connect({ [opts.passphraseField]: passphrase });
      continue;
    }

    if (reply.status === "auth_required") {
      throw new Error(
        `Host ${hostId} has no saved login the server can use. Add a password, key or credential to the host.`,
      );
    }

    return;
  }

  throw new Error(`Host ${hostId} kept asking for more sign-in steps.`);
}
