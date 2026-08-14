import { describe, it, expect } from "vitest";
import {
  ExitCode,
  TermixApiError,
  TermixConnectionError,
  UsageError,
  exitCodeFor,
  messageFor,
  remediationFor,
} from "../src/core/errors.js";

describe("exit code mapping", () => {
  it("maps HTTP statuses to distinct exit codes", () => {
    const cases: Array<[number, number]> = [
      [401, ExitCode.AUTH_REQUIRED],
      [403, ExitCode.PERMISSION_DENIED],
      [404, ExitCode.NOT_FOUND],
      [503, ExitCode.UNREACHABLE],
      [500, ExitCode.FAILURE],
    ];
    for (const [status, expected] of cases) {
      expect(exitCodeFor(new TermixApiError("x", status, "/p"))).toBe(expected);
    }
  });

  it("treats a locked data vault as its own condition", () => {
    expect(exitCodeFor(new TermixApiError("x", 423, "/p"))).toBe(
      ExitCode.DATA_LOCKED,
    );
    // The code wins even when the status is generic.
    expect(exitCodeFor(new TermixApiError("x", 500, "/p", "DATA_LOCKED"))).toBe(
      ExitCode.DATA_LOCKED,
    );
  });

  it("maps connection and usage failures", () => {
    expect(exitCodeFor(new TermixConnectionError("x", "http://a"))).toBe(
      ExitCode.UNREACHABLE,
    );
    expect(exitCodeFor(new UsageError("bad flag"))).toBe(ExitCode.USAGE);
    expect(exitCodeFor(new Error("boom"))).toBe(ExitCode.FAILURE);
  });
});

describe("remediation", () => {
  it("explains revoked sessions", () => {
    expect(
      remediationFor(new TermixApiError("x", 401, "/p", "SESSION_EXPIRED")),
    ).toMatch(/termix login/);
  });

  it("explains the API-key-only enrollment path", () => {
    expect(
      remediationFor(new TermixApiError("x", 401, "/p", "API_KEY_REQUIRED")),
    ).toMatch(/API key/);
  });

  it("falls back to status-based guidance", () => {
    expect(remediationFor(new TermixApiError("x", 403, "/p"))).toMatch(
      /Permission denied/,
    );
    expect(remediationFor(new Error("plain"))).toBeUndefined();
  });
});

describe("messageFor", () => {
  it("includes the HTTP status when there is one", () => {
    expect(messageFor(new TermixApiError("nope", 404, "/p"))).toBe(
      "nope (HTTP 404)",
    );
    expect(messageFor(new Error("plain"))).toBe("plain");
  });
});
