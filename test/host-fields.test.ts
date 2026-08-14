import { describe, it, expect } from "vitest";
import { buildHostPayload } from "../src/commands/host-fields.js";
import { parseId } from "../src/commands/hosts.js";

describe("parseId", () => {
  it("parses positive integers", () => {
    expect(parseId("7")).toBe(7);
  });

  it("rejects non-integers with the default label", () => {
    expect(() => parseId("abc")).toThrow(/Invalid id: "abc"/);
  });

  it("uses the provided label in the error message", () => {
    expect(() => parseId("nope", "--limit")).toThrow(/Invalid --limit/);
  });
});

describe("buildHostPayload", () => {
  it("always sets connectionType and includes only provided fields", () => {
    expect(buildHostPayload({ ip: "10.0.0.1", username: "root" })).toEqual({
      connectionType: "ssh",
      ip: "10.0.0.1",
      username: "root",
    });
  });

  it("parses the port and splits comma-separated tags", () => {
    const body = buildHostPayload({ port: "2222", tags: "a, b ,c" });
    expect(body.port).toBe(2222);
    expect(body.tags).toEqual(["a", "b", "c"]);
  });

  it("maps enable flags and passes secrets straight through", () => {
    const body = buildHostPayload({
      authType: "password",
      password: "s3cret",
      enableDocker: true,
    });
    expect(body).toMatchObject({
      authType: "password",
      password: "s3cret",
      enableDocker: true,
    });
  });

  it("rejects an invalid port", () => {
    expect(() => buildHostPayload({ port: "99999" })).toThrow(/port/i);
  });

  it("rejects an invalid auth type", () => {
    expect(() => buildHostPayload({ authType: "totp" })).toThrow(/auth-type/i);
  });

  it("maps a numeric credential id and rejects a non-numeric one", () => {
    expect(buildHostPayload({ credentialId: "5" }).credentialId).toBe(5);
    expect(() => buildHostPayload({ credentialId: "abc" })).toThrow(
      /credential-id/i,
    );
  });
});
