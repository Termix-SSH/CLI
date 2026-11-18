import { describe, expect, it } from "vitest";
import {
  collectHosts,
  collectInput,
  exitFor,
  OPS_EXIT,
} from "../src/commands/ops.js";

describe("termix ops arguments", () => {
  it("reads inputs, parsing values that look like JSON", () => {
    expect(collectInput("port=443", collectInput("force=true", {}))).toEqual({
      force: true,
      port: 443,
    });
    expect(collectInput("name=web-1", {})).toEqual({ name: "web-1" });
    expect(collectInput('tags=["a"]', {})).toEqual({ tags: ["a"] });
    expect(() => collectInput("nope", {})).toThrow(/KEY=VALUE/);
  });

  it("reads host lists", () => {
    expect(collectHosts("1,2", collectHosts("3", []))).toEqual([3, 1, 2]);
    expect(() => collectHosts("x", [])).toThrow(/host id/);
  });

  it("picks an exit code from the outcomes", () => {
    const ok = { runId: "a", status: "success" };
    const bad = { runId: "b", status: "failed" };
    const wait = { runId: "c", status: "pending_approval" };
    expect(exitFor([ok, ok])).toBe(0);
    expect(exitFor([bad])).toBe(OPS_EXIT.FAILED);
    expect(exitFor([ok, bad])).toBe(OPS_EXIT.PARTIAL);
    expect(exitFor([ok, wait])).toBe(OPS_EXIT.NEEDS_APPROVAL);
  });
});

describe("api key scopes", () => {
  it("maps the short names", async () => {
    const { scopeOf } = await import("../src/commands/api-keys.js");
    expect(scopeOf("actions-read")).toBe("operations:read");
    expect(scopeOf("actions-run")).toBe("operations:run");
    expect(scopeOf("read")).toBe("read");
    expect(scopeOf("full")).toBe("full");
    expect(() => scopeOf("all")).toThrow(/actions-read/);
  });
});
