import { describe, it, expect } from "vitest";
import {
  buildTunnelName,
  connectRequestFor,
  parseConnections,
  parseTunnelName,
} from "../src/commands/tunnel.js";

const host = { id: 4, name: "web", ip: "10.0.0.4", username: "root" };
const saved = {
  sourcePort: 8080,
  endpointHost: " db.local ",
  endpointPort: 5432,
  maxRetries: 3,
  retryInterval: 10,
  autoStart: false,
};

describe("tunnel names", () => {
  it("uses the host label like the web UI", () => {
    expect(buildTunnelName(host, 0, saved)).toBe(
      "4::0::web::8080::db.local::5432",
    );
    expect(buildTunnelName({ ...host, name: "" }, 1, saved)).toBe(
      "4::1::root@10.0.0.4::8080::db.local::5432",
    );
  });

  it("splits a name back into its parts", () => {
    expect(parseTunnelName("4::0::web::8080::db.local::5432")).toEqual({
      sourceHostId: 4,
      tunnelIndex: 0,
      hostLabel: "web",
      sourcePort: "8080",
      endpointHost: "db.local",
      endpointPort: "5432",
    });
    expect(parseTunnelName("web:something")).toEqual({});
  });
});

describe("parseConnections", () => {
  it("reads the tunnels plugin host settings", () => {
    expect(
      parseConnections({
        pluginSettings: { tunnels: { tunnelConnections: [saved] } },
      }),
    ).toEqual([saved]);
  });

  it("accepts the settings as a JSON string", () => {
    expect(
      parseConnections({
        pluginSettings: {
          tunnels: { tunnelConnections: JSON.stringify([saved]) },
        },
      }),
    ).toEqual([saved]);
  });

  it("returns nothing when the host has no tunnels", () => {
    expect(parseConnections({})).toEqual([]);
    expect(
      parseConnections({
        pluginSettings: { tunnels: { tunnelConnections: "{" } },
      }),
    ).toEqual([]);
  });
});

describe("connectRequestFor", () => {
  it("sends a config that matches its own name", () => {
    expect(connectRequestFor(host, 0, saved)).toMatchObject({
      name: "4::0::web::8080::db.local::5432",
      sourceHostId: 4,
      tunnelIndex: 0,
      scope: "s2s",
      mode: "local",
      tunnelType: "local",
      endpointHost: "db.local",
      sourcePort: 8080,
      endpointPort: 5432,
    });
  });

  it("maps a remote forward", () => {
    expect(
      connectRequestFor(host, 0, { ...saved, mode: "remote" }),
    ).toMatchObject({ mode: "remote", tunnelType: "remote" });
  });
});
