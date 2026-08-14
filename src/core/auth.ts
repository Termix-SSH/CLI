import type { CliConfig } from "./config.js";

/**
 * Pick the bearer credential for a request.
 *
 * API keys win over the session JWT. They are long-lived, individually
 * revocable, and carry the same data access: the server wraps each user's
 * data-encryption key with a system key rather than their password, so an
 * API-key request decrypts hosts and credentials exactly like a logged-in
 * session does. A caller who supplied a key meant to use it.
 *
 * The CLI never holds the user's password, so there is no silent re-login:
 * when the stored JWT is missing or rejected the user runs `termix login`
 * again.
 */
export function getBearer(config: CliConfig): string {
  if (config.apiKey) return config.apiKey;
  if (config.token) return config.token;
  throw new Error(
    "Not authenticated. Run `termix login`, or set TERMIX_API_KEY (recommended for scripts) or TERMIX_TOKEN.",
  );
}

/** True when the credential in use is an API key rather than a session JWT. */
export function isApiKey(credential: string): boolean {
  return credential.startsWith("tmx_");
}

/**
 * The terminal, tunnel and console WebSockets verify a JWT directly and never
 * consult the API-key table, so a `tmx_` credential cannot open them. Commands
 * that need a socket call this to fail with an actionable message instead of a
 * bare handshake rejection.
 */
export function requireSessionToken(
  config: CliConfig,
  feature: string,
): string {
  if (config.token) return config.token;
  if (config.apiKey) {
    throw new Error(
      `${feature} needs a session token: API keys cannot open WebSocket connections. Run \`termix login\`.`,
    );
  }
  throw new Error(`Not authenticated. Run \`termix login\` to use ${feature}.`);
}

/** Decode the `exp` claim (seconds) of a JWT into epoch milliseconds. */
export function decodeJwtExpMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * True when the JWT is past (or within `marginMs` of) its expiry.
 *
 * Advisory only. Termix tracks sessions in the database, so a token that looks
 * valid here can still be rejected once revoked - the 401 handling is what
 * actually decides. Use this to warn early, never to skip a request.
 */
export function isTokenExpired(token: string, marginMs = 0): boolean {
  const expMs = decodeJwtExpMs(token);
  if (expMs === null) return false;
  return Date.now() >= expMs - marginMs;
}
