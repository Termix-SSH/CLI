import type { CliConfig } from "./config.js";

/**
 * Pick the bearer credential for a request.
 *
 * The CLI never holds the user's password, so there is no silent re-login:
 * when the stored JWT is missing or expired the user is told to run
 * `termix login` again. Priority: JWT (full access) > API key (non-encrypted
 * endpoints only — Termix never restores the user's data key for API keys).
 */
export function getBearer(config: CliConfig): string {
  if (config.token) return config.token;
  if (config.apiKey) return config.apiKey;
  throw new Error(
    "Not authenticated. Run `termix login`, or set TERMIX_TOKEN (or TERMIX_API_KEY for read-only endpoints).",
  );
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

/** True when the JWT is past (or within `marginMs` of) its expiry. */
export function isTokenExpired(token: string, marginMs = 0): boolean {
  const expMs = decodeJwtExpMs(token);
  if (expMs === null) return false;
  return Date.now() >= expMs - marginMs;
}
