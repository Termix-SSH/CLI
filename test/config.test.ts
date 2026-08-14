import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveConfig,
  saveStoredConfig,
  loadStoredConfig,
  deleteStoredConfig,
  configFilePath,
} from "../src/core/config.js";

let tmpDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "termix-cli-test-"));
  env = { XDG_CONFIG_HOME: tmpDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("stored config", () => {
  it("round-trips through save/load and applies 0600 permissions", () => {
    const file = saveStoredConfig(
      { url: "http://termix.local", token: "t", username: "u" },
      env,
    );
    expect(file).toBe(configFilePath(env));
    expect(loadStoredConfig(env)).toEqual({
      url: "http://termix.local",
      token: "t",
      username: "u",
    });
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns null when the file is absent or invalid", () => {
    expect(loadStoredConfig(env)).toBeNull();
    fs.mkdirSync(path.join(tmpDir, "termix"), { recursive: true });
    fs.writeFileSync(configFilePath(env), "not json");
    expect(loadStoredConfig(env)).toBeNull();
  });

  it("deleteStoredConfig removes the file", () => {
    saveStoredConfig({ url: "http://termix.local" }, env);
    expect(deleteStoredConfig(env)).toBe(true);
    expect(deleteStoredConfig(env)).toBe(false);
  });
});

describe("resolveConfig", () => {
  it("throws a readable error when no URL is configured", () => {
    expect(() => resolveConfig(env)).toThrow(/termix login|TERMIX_URL/);
  });

  it("reads the stored file and strips trailing slashes", () => {
    saveStoredConfig(
      { url: "http://termix.local/", token: "jwt", username: "u" },
      env,
    );
    const cfg = resolveConfig(env);
    expect(cfg.url).toBe("http://termix.local");
    expect(cfg.token).toBe("jwt");
    expect(cfg.username).toBe("u");
  });

  it("lets environment variables override the stored file", () => {
    saveStoredConfig({ url: "http://stored.local", token: "stored" }, env);
    const cfg = resolveConfig({
      ...env,
      TERMIX_URL: "http://env.local",
      TERMIX_TOKEN: "env-token",
    } as NodeJS.ProcessEnv);
    expect(cfg.url).toBe("http://env.local");
    expect(cfg.token).toBe("env-token");
  });

  it("an env API key overrides the stored token instead of being ignored", () => {
    saveStoredConfig({ url: "http://stored.local", token: "stored" }, env);
    const cfg = resolveConfig({
      ...env,
      TERMIX_API_KEY: "tmx_key",
    } as NodeJS.ProcessEnv);
    // The stored token must NOT leak through when an env API key is set.
    expect(cfg.token).toBeUndefined();
    expect(cfg.apiKey).toBe("tmx_key");
  });

  it("still uses the stored token when no auth env var is set", () => {
    saveStoredConfig({ url: "http://stored.local", token: "stored" }, env);
    const cfg = resolveConfig(env);
    expect(cfg.token).toBe("stored");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("validates TERMIX_REQUEST_TIMEOUT_MS", () => {
    expect(() =>
      resolveConfig({
        ...env,
        TERMIX_URL: "http://x.local",
        TERMIX_REQUEST_TIMEOUT_MS: "nope",
      } as NodeJS.ProcessEnv),
    ).toThrow(/TERMIX_REQUEST_TIMEOUT_MS/);
  });
});
