import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ENDPOINTS } from "../src/api/endpoints.js";
import { FEATURES } from "../src/api/features.js";

const specDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "spec",
);

interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
}

function loadSpec(file: string): OpenApiSpec {
  return JSON.parse(
    fs.readFileSync(path.join(specDir, file), "utf8"),
  ) as OpenApiSpec;
}

const core = loadSpec("openapi.json");
const pluginSpecs = new Map<string, OpenApiSpec>();

function specFor(plugin: string | undefined): OpenApiSpec {
  if (!plugin) return core;
  let spec = pluginSpecs.get(plugin);
  if (!spec) {
    spec = loadSpec(path.join("plugins", `${plugin}.json`));
    pluginSpecs.set(plugin, spec);
  }
  return spec;
}

/**
 * Guards against the failure that produced this rewrite: the CLI drifted from
 * the server and nothing noticed until a command failed for a user.
 *
 * Core routes are checked against core's spec and plugin routes against that
 * plugin's own. Refresh them with `node scripts/sync-spec.mjs <Termix-Docs>`.
 */
describe("API drift", () => {
  it("has a vendored core specification to check against", () => {
    expect(Object.keys(core.paths ?? {}).length).toBeGreaterThan(0);
  });

  const documented = ENDPOINTS.filter((e) => !e.undocumented);
  const undocumented = ENDPOINTS.filter((e) => e.undocumented);

  it.each(documented)(
    "$method $path still exists (used by $usedBy)",
    ({ method, path: endpointPath, plugin }) => {
      const operations = specFor(plugin).paths[endpointPath];
      expect(
        operations,
        `${plugin ? `The ${plugin} plugin` : "The server"} no longer documents "${endpointPath}". It was renamed or removed.`,
      ).toBeDefined();
      expect(
        operations?.[method],
        `"${endpointPath}" no longer accepts ${method.toUpperCase()}.`,
      ).toBeDefined();
    },
  );

  // These are real routes the generator cannot see. If one ever shows up in
  // the spec, drop its `undocumented` marker so it gets checked properly.
  it.each(undocumented)(
    "$method $path is still absent from the spec, as expected",
    ({ method, path: endpointPath, plugin }) => {
      expect(specFor(plugin).paths[endpointPath]?.[method]).toBeUndefined();
    },
  );

  it("lists no duplicate endpoints", () => {
    const seen = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("names only plugins the feature registry knows", () => {
    const known = new Set(Object.values(FEATURES).map((f) => f.pluginId));
    for (const endpoint of ENDPOINTS) {
      if (endpoint.plugin) expect(known).toContain(endpoint.plugin);
    }
  });
});
