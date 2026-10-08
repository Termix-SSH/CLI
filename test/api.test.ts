import { describe, it, expect } from "vitest";
import {
  collectQuery,
  parseApiBody,
  parseApiMethod,
  parseApiPath,
} from "../src/commands/api.js";

describe("termix api arguments", () => {
  it("accepts methods in any case", () => {
    expect(parseApiMethod("get")).toBe("GET");
    expect(parseApiMethod("Patch")).toBe("PATCH");
    expect(() => parseApiMethod("TRACE")).toThrow(/Unknown method/);
  });

  it("keeps the request on the server", () => {
    expect(parseApiPath("/plugins")).toBe("/plugins");
    expect(parseApiPath("plugin-api/docker/ssh/status")).toBe(
      "/plugin-api/docker/ssh/status",
    );
    expect(() => parseApiPath("//evil.example/x")).toThrow(/not a full URL/);
    expect(() => parseApiPath("https://evil.example/x")).toThrow(
      /not a full URL/,
    );
  });

  it("explains a path Git Bash rewrote", () => {
    expect(() => parseApiPath("C:/Program Files/Git/plugins")).toThrow(
      /Git Bash/,
    );
  });

  it("collects query parameters", () => {
    expect(collectQuery("a=1", collectQuery("b=x=y", {}))).toEqual({
      a: "1",
      b: "x=y",
    });
    expect(() => collectQuery("nope", {})).toThrow(/NAME=VALUE/);
  });

  it("parses a JSON body", () => {
    expect(parseApiBody({ data: '{"a":1}' })).toEqual({ a: 1 });
    expect(parseApiBody({})).toBeUndefined();
    expect(() => parseApiBody({ data: "{" })).toThrow(/not valid JSON/);
    expect(() => parseApiBody({ data: "{}", dataFile: "x" })).toThrow(
      /only one/,
    );
  });
});
