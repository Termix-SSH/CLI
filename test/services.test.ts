import { describe, it, expect } from "vitest";
import { resolveWebSocketUrl } from "../src/core/services.js";
import type { CliConfig } from "../src/core/config.js";

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    url: "https://termix.example.com",
    insecureTls: false,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

describe("resolveWebSocketUrl", () => {
  it("upgrades https to wss", () => {
    expect(
      resolveWebSocketUrl(makeConfig(), "/plugin-ws/ssh-terminal/terminal"),
    ).toBe("wss://termix.example.com/plugin-ws/ssh-terminal/terminal");
  });

  it("upgrades http to ws", () => {
    const config = makeConfig({ url: "http://localhost:8080" });
    expect(
      resolveWebSocketUrl(config, "/plugin-ws/ssh-terminal/terminal"),
    ).toBe("ws://localhost:8080/plugin-ws/ssh-terminal/terminal");
  });
});
