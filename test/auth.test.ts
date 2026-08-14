import { describe, it, expect } from "vitest";
import { getBearer, decodeJwtExpMs, isTokenExpired } from "../src/core/auth.js";
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
  it("prefers the session token over the API key", () => {
    expect(getBearer(makeConfig({ token: "jwt", apiKey: "tmx_k" }))).toBe(
      "jwt",
    );
  });

  it("falls back to the API key", () => {
    expect(getBearer(makeConfig({ apiKey: "tmx_k" }))).toBe("tmx_k");
  });

  it("tells the user to run `termix login` when nothing is configured", () => {
    expect(() => getBearer(makeConfig({}))).toThrow(/termix login/);
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
