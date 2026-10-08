import { describe, it, expect, vi } from "vitest";
import { decideHostKey } from "../src/commands/ssh.js";

describe("decideHostKey", () => {
  it("trusts a new key with --trust-host-key without asking", async () => {
    await expect(
      decideHostKey(false, { fingerprint: "ab" }, "me@host:22", true),
    ).resolves.toBe(true);
  });

  it("never trusts a changed key without a person", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      // Tests have no terminal, so the confirmation cannot be answered.
      await expect(
        decideHostKey(true, { fingerprint: "cd" }, "me@host:22", true),
      ).rejects.toThrow(/not a terminal/);
      expect(String(write.mock.calls[0]?.[0])).toMatch(/has changed/);
    } finally {
      write.mockRestore();
    }
  });
});
