/**
 * Exit codes. Scripts branch on these, so they are part of the CLI's contract:
 * changing one is a breaking change.
 *
 * `termix exec` and `termix ssh` are deliberate exceptions - they pass through
 * the *remote* command's exit code, which is why their own failures use
 * INTERNAL (255) rather than a code the remote side could also produce.
 */
export const ExitCode = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  AUTH_REQUIRED: 3,
  PERMISSION_DENIED: 4,
  NOT_FOUND: 5,
  UNREACHABLE: 6,
  DATA_LOCKED: 7,
  INTERNAL: 255,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Error carrying the HTTP status and the Termix error payload. */
export class TermixApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly path: string,
    /** Server-supplied machine code, e.g. TOTP_REQUIRED or DATA_LOCKED. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "TermixApiError";
  }

  get exitCode(): ExitCodeValue {
    if (this.code === "DATA_LOCKED" || this.status === 423) {
      return ExitCode.DATA_LOCKED;
    }
    switch (this.status) {
      case 401:
        return ExitCode.AUTH_REQUIRED;
      case 403:
        return ExitCode.PERMISSION_DENIED;
      case 404:
        return ExitCode.NOT_FOUND;
      case 502:
      case 503:
      case 504:
        return ExitCode.UNREACHABLE;
      default:
        return ExitCode.FAILURE;
    }
  }
}

/** A network-level failure: the server could not be reached at all. */
export class TermixConnectionError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "TermixConnectionError";
  }

  get exitCode(): ExitCodeValue {
    return ExitCode.UNREACHABLE;
  }
}

/** Bad flags or arguments: the user's invocation, not the server's fault. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }

  get exitCode(): ExitCodeValue {
    return ExitCode.USAGE;
  }
}

/**
 * Guidance appended to an error, chosen from the server's machine code where
 * one is available. The codes come from the backend auth middleware.
 */
export function remediationFor(error: unknown): string | undefined {
  if (!(error instanceof TermixApiError)) return undefined;

  switch (error.code) {
    case "TOTP_REQUIRED":
      return "Two-factor verification is required. Run `termix login` again.";
    case "SESSION_EXPIRED":
    case "SESSION_NOT_FOUND":
      return "Your session is no longer valid. Run `termix login`.";
    case "DATA_LOCKED":
    case "TARGET_DATA_LOCKED":
      return "Encrypted data is locked. Sign in to unlock it.";
    case "API_KEY_REQUIRED":
      return "This endpoint only accepts an API key. Pass --api-key or set TERMIX_API_KEY.";
    case "IMPERSONATION_NOT_ALLOWED":
      return "API keys cannot impersonate another user. Use a session token.";
    default:
      break;
  }

  if (error.status === 401) {
    return "Your session may have expired. Run `termix login`.";
  }
  if (error.status === 403) {
    // 403 also covers not-owner/access-denied, not just missing admin.
    return "Permission denied. Admin-only endpoints also return 403.";
  }
  return undefined;
}

/** Map any thrown value to the exit code the process should terminate with. */
export function exitCodeFor(error: unknown): ExitCodeValue {
  if (
    error instanceof TermixApiError ||
    error instanceof TermixConnectionError ||
    error instanceof UsageError
  ) {
    return error.exitCode;
  }
  return ExitCode.FAILURE;
}

export function messageFor(error: unknown): string {
  if (error instanceof TermixApiError) {
    return error.status
      ? `${error.message} (HTTP ${error.status})`
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
