import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const request = vi.fn();
vi.mock("../src/core/context.js", () => ({
  createContext: vi.fn(async () => ({ client: { request } })),
}));

import { registerHostCommands } from "../src/commands/hosts.js";

let stderr: string;

beforeEach(() => {
  stderr = "";
  request.mockReset();
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function hosts(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerHostCommands(program);
  await program.parseAsync(["hosts", ...args], { from: "user" });
}

/** Body of the first request with the given method. */
function sent(method: string): Record<string, unknown> {
  const call = request.mock.calls.find(([opts]) => opts.method === method);
  return call?.[0].data;
}

describe("hosts create", () => {
  const base = ["create", "--ip", "10.0.0.1", "--username", "root"];

  beforeEach(() => {
    request.mockResolvedValue({ id: 3, name: "root@10.0.0.1" });
  });

  it("infers authType credential from --credential-id", async () => {
    await hosts(...base, "--credential-id", "7");
    expect(sent("POST")).toMatchObject({
      authType: "credential",
      credentialId: 7,
    });
  });

  it("infers authType from --password and --key-file", async () => {
    await hosts(...base, "--password", "pw");
    expect(sent("POST").authType).toBe("password");

    request.mockClear();
    await hosts(...base, "--key-file", "package.json");
    expect(sent("POST").authType).toBe("key");
  });

  it("sends an explicit --auth-type that needs no secret", async () => {
    await hosts(...base, "--auth-type", "agent");
    expect(sent("POST")).toMatchObject({
      authType: "agent",
      credentialId: null,
    });
  });

  it("fails locally when no auth type can be inferred", async () => {
    await expect(hosts(...base)).rejects.toThrow("exit");
    expect(stderr).toMatch(/needs an auth method: pass --auth-type/);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses --auth-type credential without a credential", async () => {
    await expect(hosts(...base, "--auth-type", "credential")).rejects.toThrow(
      "exit",
    );
    expect(stderr).toMatch(/needs a saved credential/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("hosts update", () => {
  const stored = {
    id: 3,
    name: "web",
    ip: "10.0.0.1",
    port: 22,
    username: "root",
    hasPassword: true,
  };

  function storedHost(fields: Record<string, unknown>): void {
    request.mockImplementation(async ({ method }) =>
      method === "GET" ? { ...stored, ...fields } : {},
    );
  }

  it("switches a host to its saved credential", async () => {
    storedHost({ authType: "password", credentialId: null });
    await hosts("update", "3", "--credential-id", "7");
    expect(sent("PUT")).toMatchObject({
      authType: "credential",
      credentialId: 7,
    });
  });

  it("accepts --auth-type credential for a host with a bound credential", async () => {
    storedHost({ authType: "password", credentialId: 7 });
    await hosts("update", "3", "--auth-type", "credential");
    expect(sent("PUT")).toMatchObject({
      authType: "credential",
      credentialId: 7,
    });
  });

  it("unbinds the credential with --no-credential and --auth-type", async () => {
    storedHost({ authType: "credential", credentialId: 7 });
    await hosts("update", "3", "--no-credential", "--auth-type", "password");
    expect(sent("PUT")).toMatchObject({
      authType: "password",
      credentialId: null,
    });
  });

  it("infers the replacement auth type from --password", async () => {
    storedHost({ authType: "credential", credentialId: 7 });
    await hosts("update", "3", "--no-credential", "--password", "pw");
    expect(sent("PUT")).toMatchObject({
      authType: "password",
      credentialId: null,
      password: "pw",
    });
  });

  it("unbinds the credential when switching to another auth type", async () => {
    storedHost({ authType: "credential", credentialId: 7 });
    await hosts("update", "3", "--auth-type", "key");
    expect(sent("PUT")).toMatchObject({ authType: "key", credentialId: null });
  });

  it("only clears credentialId on a host that does not sign in with it", async () => {
    storedHost({ authType: "password", credentialId: 7 });
    await hosts("update", "3", "--no-credential");
    expect(sent("PUT")).toMatchObject({
      authType: "password",
      credentialId: null,
    });
  });

  it("asks for an auth type when unbinding a credential host", async () => {
    storedHost({ authType: "credential", credentialId: 7 });
    await expect(hosts("update", "3", "--no-credential")).rejects.toThrow(
      "exit",
    );
    expect(stderr).toMatch(
      /Host 3 signs in with a credential\. Pass --auth-type with --no-credential/,
    );
    expect(sent("PUT")).toBeUndefined();
  });

  it("refuses --auth-type credential on a host with no credential", async () => {
    storedHost({ authType: "password", credentialId: null });
    await expect(
      hosts("update", "3", "--auth-type", "credential"),
    ).rejects.toThrow("exit");
    expect(stderr).toMatch(/needs a saved credential/);
    expect(sent("PUT")).toBeUndefined();
  });
});

describe("hosts help", () => {
  it("documents the auth types and --no-credential", () => {
    const program = new Command();
    registerHostCommands(program);
    const update = program.commands
      .find((c) => c.name() === "hosts")
      ?.commands.find((c) => c.name() === "update");
    const help = (update?.helpInformation() ?? "").replace(/\s+/g, " ");
    expect(help).toMatch(/password \| key \| credential \| agent \| none/);
    expect(help).toMatch(/--no-credential/);
  });
});
