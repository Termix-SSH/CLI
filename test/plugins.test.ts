import { describe, it, expect, vi } from "vitest";
import {
  getServerPlugins,
  isPluginActive,
  requireFeature,
} from "../src/core/plugins.js";
import { FeatureUnavailableError, TermixApiError } from "../src/core/errors.js";
import type { TermixClient } from "../src/core/http.js";
import { commandsForPlugin, pluginPath } from "../src/api/features.js";

function fakeClient(answer: () => unknown): {
  client: TermixClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => answer());
  return { client: { request } as unknown as TermixClient, request };
}

async function caught(
  promise: Promise<unknown>,
): Promise<FeatureUnavailableError> {
  return (await promise.catch((e: unknown) => e)) as FeatureUnavailableError;
}

describe("getServerPlugins", () => {
  it("asks the server once per client", async () => {
    const { client, request } = fakeClient(() => [
      { id: "docker", state: "active" },
    ]);
    await getServerPlugins(client);
    await getServerPlugins(client);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ method: "GET", path: "/plugins" });
  });

  it("calls a server without a plugin list older than 2.9", async () => {
    const { client } = fakeClient(() => ({ status: "ok" }));
    await expect(getServerPlugins(client)).rejects.toThrow(/older than 2.9/);
  });

  it("treats a missing /plugins route as an old server", async () => {
    const { client } = fakeClient(() => {
      throw new TermixApiError("web page", 404, "/plugins");
    });
    await expect(getServerPlugins(client)).rejects.toThrow(/older than 2.9/);
  });

  it("does not cache a failed lookup", async () => {
    let calls = 0;
    const { client } = fakeClient(() => {
      calls++;
      if (calls === 1) throw new Error("network");
      return [];
    });
    await expect(getServerPlugins(client)).rejects.toThrow("network");
    await expect(getServerPlugins(client)).resolves.toEqual([]);
  });
});

describe("isPluginActive", () => {
  it("trusts the live state over the enabled flag", () => {
    expect(isPluginActive({ id: "a", enabled: true, state: "failed" })).toBe(
      false,
    );
    expect(isPluginActive({ id: "a", enabled: true, state: "active" })).toBe(
      true,
    );
    expect(isPluginActive({ id: "a", enabled: true })).toBe(true);
  });
});

describe("requireFeature", () => {
  it("passes when the plugin is running", async () => {
    const { client } = fakeClient(() => [{ id: "docker", state: "active" }]);
    await expect(requireFeature(client, "docker")).resolves.toBeUndefined();
  });

  it("reports a plugin that is not installed", async () => {
    const { client } = fakeClient(() => [{ id: "fleets", state: "active" }]);
    const error = await caught(requireFeature(client, "docker"));
    expect(error).toBeInstanceOf(FeatureUnavailableError);
    expect(error.reason).toBe("missing");
    expect(error.pluginId).toBe("docker");
    expect(error.message).toMatch(/Docker is not installed/);
  });

  it("reports a plugin that is turned off", async () => {
    const { client } = fakeClient(() => [
      { id: "file-manager", enabled: false, state: "disabled" },
    ]);
    const error = await caught(requireFeature(client, "files"));
    expect(error.reason).toBe("disabled");
    expect(error.message).toMatch(/file manager is turned off/);
  });
});

describe("feature registry", () => {
  it("builds plugin paths", () => {
    expect(pluginPath("snippets")).toBe("/plugin-api/snippets");
    expect(pluginPath("files", "/listFiles")).toBe(
      "/plugin-api/file-manager/listFiles",
    );
    expect(pluginPath("docker", "ssh/connect")).toBe(
      "/plugin-api/docker/ssh/connect",
    );
  });

  it("lists the commands a plugin enables", () => {
    expect(commandsForPlugin("snippets")).toEqual(["snippets", "exec"]);
    expect(commandsForPlugin("proxmox")).toEqual([]);
  });
});
