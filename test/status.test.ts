import { describe, it, expect } from "vitest";
import { toStatusRows } from "../src/commands/misc.js";

describe("toStatusRows", () => {
  it("turns the id-keyed map the server returns into rows", () => {
    // Regression: /status returns { "2": {...} }, not an array, so a plain
    // Array.isArray check rendered nothing at all.
    const rows = toStatusRows({
      "2": { status: "online", lastChecked: "2026-08-14T06:06:15.791Z" },
      "3": { status: "offline", lastChecked: "2026-08-14T06:06:15.749Z" },
    });

    expect(rows).toEqual([
      { id: "2", status: "online", lastChecked: "2026-08-14T06:06:15.791Z" },
      { id: "3", status: "offline", lastChecked: "2026-08-14T06:06:15.749Z" },
    ]);
  });

  it("passes an array through unchanged", () => {
    const rows = [{ id: 1, status: "online" }];
    expect(toStatusRows(rows)).toEqual(rows);
  });

  it("returns nothing for an empty or unexpected payload", () => {
    expect(toStatusRows({})).toEqual([]);
    expect(toStatusRows(null)).toEqual([]);
    expect(toStatusRows("nope")).toEqual([]);
  });
});
