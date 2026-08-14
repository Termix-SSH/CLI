import { describe, it, expect } from "vitest";
import {
  getBearer,
  decodeJwtExpMs,
  isTokenExpired,
  isApiKey,
  requireSessionToken,
} from "../src/core/auth.js";
import type { CliConfig } from "../src/core/config.js";

function makeConfig(overrides: Partial<CliConfig>): CliConfig {
  return {
    url: "http://termix.local",
    insecureTls: false,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

function fakeJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString(
    "base64url",
  );
  return `header.${payload}.sig`;
}

describe("getBearer", () => {
  it("prefers the API key over the session token", () => {
    // An API key is long-lived and individually revocable, and the server
    // grants it the same data access, so an explicit key wins.
    expect(getBearer(makeConfig({ token: "jwt", apiKey: "tmx_k" }))).toBe(
      "tmx_k",
    );
  });

  it("falls back to the session token", () => {
    expect(getBearer(makeConfig({ token: "jwt" }))).toBe("jwt");
  });

  it("tells the user to run `termix login` when nothing is configured", () => {
    expect(() => getBearer(makeConfig({}))).toThrow(/termix login/);
  });
});

describe("isApiKey", () => {
  it("recognises the tmx_ prefix the server branches on", () => {
    expect(isApiKey("tmx_abc")).toBe(true);
    expect(isApiKey("header.payload.sig")).toBe(false);
  });
});

describe("requireSessionToken", () => {
  it("returns the JWT when one is present", () => {
    expect(
      requireSessionToken(makeConfig({ token: "jwt" }), "termix ssh"),
    ).toBe("jwt");
  });

  it("explains that API keys cannot open a WebSocket", () => {
    expect(() =>
      requireSessionToken(makeConfig({ apiKey: "tmx_k" }), "termix ssh"),
    ).toThrow(/API keys cannot open WebSocket/);
  });

  it("asks an unauthenticated user to log in", () => {
    expect(() => requireSessionToken(makeConfig({}), "termix ssh")).toThrow(
      /termix login/,
    );
  });
});

describe("JWT expiry helpers", () => {
  it("decodes the exp claim to epoch milliseconds", () => {
    expect(decodeJwtExpMs(fakeJwt(1000))).toBe(1000_000);
    expect(decodeJwtExpMs("garbage")).toBeNull();
  });

  it("detects expired and valid tokens", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(isTokenExpired(fakeJwt(past))).toBe(true);
    expect(isTokenExpired(fakeJwt(future))).toBe(false);
    // Unparseable tokens are not assumed expired.
    expect(isTokenExpired("garbage")).toBe(false);
  });
});
