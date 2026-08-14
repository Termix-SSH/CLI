import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tmpDir: string;
const originalXdg = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "termix-store-test-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  vi.doUnmock("keytar");
});

/**
 * keytar is an optional native dependency. It is absent on musl and many
 * headless Linux boxes, so the file fallback is the common path, not the
 * exceptional one.
 */
describe("when the OS keychain is unavailable", () => {
  beforeEach(() => {
    vi.doMock("keytar", () => {
      throw new Error("Cannot find module 'keytar'");
    });
  });

  it("reports the keychain as unavailable instead of throwing", async () => {
    const store = await import("../src/core/credentials-store.js");
    expect(await store.keychainAvailable()).toBe(false);
  });

  it("writes the token to the config file", async () => {
    const store = await import("../src/core/credentials-store.js");
    const { usedKeychain } = await store.saveSession({
      url: "http://termix.local",
      token: "jwt-token",
      username: "u",
    });

    expect(usedKeychain).toBe(false);
    const session = await store.loadSession();
    expect(session?.token).toBe("jwt-token");
  });

  it("clears the session", async () => {
    const store = await import("../src/core/credentials-store.js");
    await store.saveSession({ url: "http://termix.local", token: "t" });
    expect(await store.clearSession()).toBe(true);
    expect(await store.loadSession()).toBeNull();
  });
});

describe("when the OS keychain is available", () => {
  const vault = new Map<string, string>();

  beforeEach(() => {
    vault.clear();
    vi.doMock("keytar", () => ({
      default: {
        getPassword: async (_s: string, account: string) =>
          vault.get(account) ?? null,
        setPassword: async (_s: string, account: string, password: string) => {
          vault.set(account, password);
        },
        deletePassword: async (_s: string, account: string) =>
          vault.delete(account),
      },
    }));
  });

  it("keeps the token out of the config file", async () => {
    const store = await import("../src/core/credentials-store.js");
    const { file, usedKeychain } = await store.saveSession({
      url: "http://termix.local",
      token: "secret-jwt",
      username: "u",
    });

    expect(usedKeychain).toBe(true);
    expect(vault.get("http://termix.local")).toBe("secret-jwt");
    // The token must not be readable from disk.
    expect(fs.readFileSync(file, "utf8")).not.toContain("secret-jwt");
  });

  it("recombines the keychain token with the stored config on read", async () => {
    const store = await import("../src/core/credentials-store.js");
    await store.saveSession({
      url: "http://termix.local",
      token: "secret-jwt",
      username: "u",
    });

    const session = await store.loadSession();
    expect(session).toMatchObject({
      url: "http://termix.local",
      username: "u",
      token: "secret-jwt",
    });
  });

  it("removes the keychain entry on logout", async () => {
    const store = await import("../src/core/credentials-store.js");
    await store.saveSession({ url: "http://termix.local", token: "secret" });
    await store.clearSession();
    expect(vault.size).toBe(0);
  });
});
