import { describe, it, expect } from "vitest";
import {
  decodeDownload,
  encodeUpload,
  parseRemote,
} from "../src/commands/files.js";

describe("file content encoding", () => {
  it("sends text as text", () => {
    expect(encodeUpload(Buffer.from("hello\n"))).toEqual({
      content: "hello\n",
    });
  });

  it("sends binary as base64", () => {
    const data = Buffer.from([0x89, 0x50, 0x00, 0xff]);
    expect(encodeUpload(data)).toEqual({
      content: data.toString("base64"),
      encoding: "base64",
    });
  });

  it("decodes what the file manager sends back", () => {
    const data = Buffer.from([1, 2, 0, 255]);
    expect(
      decodeDownload({ content: data.toString("base64"), encoding: "base64" }),
    ).toEqual(data);
    expect(decodeDownload({ content: "hi", encoding: "utf8" }).toString()).toBe(
      "hi",
    );
    expect(decodeDownload(undefined).length).toBe(0);
  });
});

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
