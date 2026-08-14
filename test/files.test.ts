import { describe, it, expect } from "vitest";
import { parseRemote } from "../src/commands/files.js";

describe("parseRemote", () => {
  it("splits HOST_ID:/path into its parts", () => {
    expect(parseRemote("3:/etc/hosts")).toEqual({
      hostId: 3,
      path: "/etc/hosts",
    });
  });

  it("keeps colons that appear inside the path", () => {
    // Only the first colon separates the host from the path.
    expect(parseRemote("7:/var/log/app:1.log")).toEqual({
      hostId: 7,
      path: "/var/log/app:1.log",
    });
  });

  it("accepts a relative remote path", () => {
    expect(parseRemote("2:notes.txt")).toEqual({
      hostId: 2,
      path: "notes.txt",
    });
  });

  it("rejects a value with no colon", () => {
    expect(() => parseRemote("/etc/hosts")).toThrow(/HOST_ID/);
  });

  it("rejects a missing path", () => {
    expect(() => parseRemote("3:")).toThrow(/no path/);
  });

  it("rejects a non-numeric host id", () => {
    expect(() => parseRemote("web:/etc/hosts")).toThrow(/host id/);
  });
});
