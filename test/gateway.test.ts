import { describe, it, expect } from "vitest";
import { buildConnection } from "../src/commands/tunnel.js";
import { buildPortBody } from "../src/commands/gateway.js";

describe("buildConnection", () => {
  it("starts from the same defaults as the web UI", () => {
    expect(
      buildConnection({
        sourcePort: "8080",
        endpointHost: "db",
        endpointPort: "5432",
      }),
    ).toEqual({
      scope: "s2s",
      mode: "local",
      bindHost: "127.0.0.1",
      maxRetries: 3,
      retryInterval: 10,
      autoStart: false,
      sourcePort: 8080,
      endpointHost: "db",
      endpointPort: 5432,
    });
  });

  it("changes only the given options of an existing tunnel", () => {
    const base = buildConnection({
      sourcePort: "8080",
      endpointHost: "db",
      endpointPort: "5432",
    });
    const next = buildConnection(
      { endpointPort: "6543", autoStart: true },
      base,
    );
    expect(next).toMatchObject({
      sourcePort: 8080,
      endpointHost: "db",
      endpointPort: 6543,
      autoStart: true,
    });
    expect(base.endpointPort).toBe(5432);
  });

  it("marks a remote forward", () => {
    expect(
      buildConnection({
        mode: "remote",
        sourcePort: "2222",
        endpointPort: "22",
      }),
    ).toMatchObject({ mode: "remote", tunnelType: "remote" });
  });

  it("needs no endpoint for a dynamic proxy", () => {
    expect(
      buildConnection({ mode: "dynamic", sourcePort: "1080" }),
    ).toMatchObject({ mode: "dynamic", sourcePort: 1080 });
  });

  it("refuses bad input", () => {
    expect(() => buildConnection({ endpointPort: "5432" })).toThrow(
      /--source-port/,
    );
    expect(() => buildConnection({ sourcePort: "8080" })).toThrow(
      /--endpoint-port/,
    );
    expect(() =>
      buildConnection({ sourcePort: "0", endpointPort: "1" }),
    ).toThrow(/--source-port/);
    expect(() =>
      buildConnection({ mode: "sideways", sourcePort: "1", endpointPort: "1" }),
    ).toThrow(/--mode/);
    expect(() =>
      buildConnection({
        sourcePort: "1",
        endpointPort: "1",
        maxRetries: "-1",
      }),
    ).toThrow(/--max-retries/);
  });
});

describe("buildPortBody", () => {
  it("forwards to the same port on the private host by default", () => {
    expect(buildPortBody({ publicPort: "25565" })).toEqual({
      proto: "tcp",
      publicPort: 25565,
      targetPort: 25565,
      targetHost: "",
      label: "",
      force: undefined,
    });
  });

  it("takes a protocol, a target and a label", () => {
    expect(
      buildPortBody({
        publicPort: "7777",
        targetPort: "7778",
        proto: "both",
        targetHost: "192.168.1.50",
        label: "game",
        force: true,
      }),
    ).toMatchObject({
      proto: "both",
      targetPort: 7778,
      targetHost: "192.168.1.50",
      label: "game",
      force: true,
    });
  });

  it("refuses bad input", () => {
    expect(() => buildPortBody({})).toThrow(/--public-port/);
    expect(() => buildPortBody({ publicPort: "70000" })).toThrow(
      /--public-port/,
    );
    expect(() => buildPortBody({ publicPort: "80", proto: "icmp" })).toThrow(
      /--proto/,
    );
  });
});
