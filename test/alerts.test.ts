import { describe, it, expect } from "vitest";
import { toAlertRows } from "../src/commands/alerts.js";

describe("toAlertRows", () => {
  it("unwraps the inbox items", () => {
    expect(toAlertRows({ items: [{ id: 1 }], unread: 1 })).toEqual([{ id: 1 }]);
  });

  it("accepts a bare array", () => {
    expect(toAlertRows([{ id: 2 }])).toEqual([{ id: 2 }]);
  });

  it("returns nothing for an unexpected shape", () => {
    expect(toAlertRows(null)).toEqual([]);
    expect(toAlertRows({ ok: true })).toEqual([]);
  });
});
