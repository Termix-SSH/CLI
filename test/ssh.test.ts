import { describe, it, expect, vi } from "vitest";

vi.mock("../src/core/prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/prompt.js")>()),
  promptHidden: vi.fn(async () => "secret"),
}));

import { completeAuth, decideHostKey } from "../src/commands/ssh.js";
import type { TerminalSocket } from "../src/terminal/ws-client.js";

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

describe("completeAuth", () => {
  const connect = {
    cols: 80,
    rows: 24,
    hostConfig: { id: 1, ip: "10.0.0.1", port: 22, username: "me" },
  };

  it("asks for a password when the host has no usable login", async () => {
    const replies = [
      { type: "auth_method_not_available" },
      { type: "connected" },
    ];
    const send = vi.fn();
    const socket = {
      waitFor: vi.fn(async () => replies.shift()),
      send,
    } as unknown as TerminalSocket;

    await completeAuth(socket, connect, false);

    expect(send).toHaveBeenCalledWith("reconnect_with_credentials", {
      ...connect,
      password: "secret",
    });
  });
});
