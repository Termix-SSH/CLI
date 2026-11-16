import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerAdminCommands, userState } from "../src/commands/admin.js";

describe("userState", () => {
  it("names the account state", () => {
    expect(userState({ disabled: false })).toBe("active");
    expect(userState({ disabled: true, disabled_reason: "admin" })).toBe(
      "disabled",
    );
    expect(
      userState({ disabled: true, disabled_reason: "pending_approval" }),
    ).toBe("pending");
  });
});

describe("admin commands", () => {
  it("registers the account, invite and access review commands", () => {
    const program = new Command();
    registerAdminCommands(program);
    const users = program.commands.find((c) => c.name() === "users")!;
    expect(users.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["list", "disable", "enable", "invites"]),
    );
    const invites = users.commands.find((c) => c.name() === "invites")!;
    expect(invites.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["list", "create", "revoke"]),
    );
    expect(program.commands.map((c) => c.name())).toContain("access-review");
  });
});
