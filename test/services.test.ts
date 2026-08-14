import { describe, it, expect } from "vitest";
import {
  resolveServiceUrl,
  resolveWebSocketUrl,
} from "../src/core/services.js";
import type { CliConfig } from "../src/core/config.js";

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    url: "https://termix.example.com",
    insecureTls: false,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

describe("resolveServiceUrl", () => {
  it("uses the single origin when no override is set", () => {
    // The normal deployment puts every service behind one reverse proxy.
    const config = makeConfig();
    expect(resolveServiceUrl(config, "api")).toBe(config.url);
    expect(resolveServiceUrl(config, "metrics")).toBe(config.url);
  });

  it("uses a per-service override for bare-backend deployments", () => {
    const config = makeConfig({
      serviceUrls: { metrics: "http://localhost:30005" },
    });
    expect(resolveServiceUrl(config, "metrics")).toBe("http://localhost:30005");
    // Other services still fall back to the main origin.
    expect(resolveServiceUrl(config, "docker")).toBe(config.url);
  });

  it("never lets an override redirect the main API", () => {
    const config = makeConfig({
      serviceUrls: { metrics: "http://localhost:30005" },
    });
    expect(resolveServiceUrl(config, "api")).toBe(config.url);
  });
});

describe("resolveWebSocketUrl", () => {
  it("upgrades https to wss", () => {
    expect(resolveWebSocketUrl(makeConfig(), "/ssh/websocket/")).toBe(
      "wss://termix.example.com/ssh/websocket/",
    );
  });

  it("upgrades http to ws", () => {
    const config = makeConfig({ url: "http://localhost:8080" });
    expect(resolveWebSocketUrl(config, "/ssh/websocket/")).toBe(
      "ws://localhost:8080/ssh/websocket/",
    );
  });

  it("honours a terminal service override", () => {
    const config = makeConfig({
      serviceUrls: { terminal: "http://localhost:30002" },
    });
    expect(resolveWebSocketUrl(config, "/ssh/websocket/")).toBe(
      "ws://localhost:30002/ssh/websocket/",
    );
  });
});
