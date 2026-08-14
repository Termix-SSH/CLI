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
  configDir,
} from "../src/core/config.js";

let tmpDir: string;
let env: NodeJS.ProcessEnv;

/** Windows has no POSIX mode bits, so 0600 is meaningless there. */
const posixOnly = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "termix-cli-test-"));
  env = { XDG_CONFIG_HOME: tmpDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("configDir", () => {
  it("honours XDG_CONFIG_HOME on every platform", () => {
    expect(configDir(env)).toBe(path.join(tmpDir, "termix"));
  });

  it("falls back to a platform-native location", () => {
    const dir = configDir({
      APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    } as NodeJS.ProcessEnv);
    if (process.platform === "win32") {
      expect(dir).toBe(path.join("C:\\Users\\x\\AppData\\Roaming", "termix"));
    } else if (process.platform === "darwin") {
      expect(dir).toBe(
        path.join(os.homedir(), "Library", "Application Support", "termix"),
      );
    } else {
      expect(dir).toBe(path.join(os.homedir(), ".config", "termix"));
    }
  });
});

describe("stored config", () => {
  it("round-trips through save/load", () => {
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
  });

  posixOnly("applies owner-only permissions", () => {
    const file = saveStoredConfig({ url: "http://termix.local" }, env);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  posixOnly("re-applies permissions when the file already exists", () => {
    const file = saveStoredConfig({ url: "http://termix.local" }, env);
    fs.chmodSync(file, 0o644);
    saveStoredConfig({ url: "http://termix.local", token: "t" }, env);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
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

  it("rejects a URL without an http(s) scheme", () => {
    expect(() =>
      resolveConfig({
        ...env,
        TERMIX_URL: "termix.local",
      } as NodeJS.ProcessEnv),
    ).toThrow(/expected http/);
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

  it("the --api-key flag also suppresses the stored token", () => {
    saveStoredConfig({ url: "http://stored.local", token: "stored" }, env);
    const cfg = resolveConfig(env, { apiKey: "tmx_flag" });
    expect(cfg.token).toBeUndefined();
    expect(cfg.apiKey).toBe("tmx_flag");
  });

  it("the --api-key flag outranks TERMIX_API_KEY", () => {
    const cfg = resolveConfig(
      {
        ...env,
        TERMIX_URL: "http://x.local",
        TERMIX_API_KEY: "tmx_env",
      } as NodeJS.ProcessEnv,
      { apiKey: "tmx_flag" },
    );
    expect(cfg.apiKey).toBe("tmx_flag");
  });

  it("still uses the stored token when no auth env var is set", () => {
    saveStoredConfig({ url: "http://stored.local", token: "stored" }, env);
    const cfg = resolveConfig(env);
    expect(cfg.token).toBe("stored");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("reads per-service URL overrides", () => {
    const cfg = resolveConfig({
      ...env,
      TERMIX_URL: "http://x.local",
      TERMIX_METRICS_URL: "http://x.local:30005/",
    } as NodeJS.ProcessEnv);
    expect(cfg.serviceUrls?.metrics).toBe("http://x.local:30005");
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
