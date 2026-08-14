import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ENDPOINTS } from "../src/api/endpoints.js";

const specPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "spec",
  "openapi.json",
);

interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
}

const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as OpenApiSpec;

/**
 * Guards against the failure that produced this rewrite: the CLI drifted from
 * the server and nothing noticed until a command failed for a user.
 *
 * Regenerate the vendored spec from the server repo with
 * `npm run generate:openapi`, then copy `openapi.json` to `spec/`.
 */
describe("API drift", () => {
  it("has a vendored specification to check against", () => {
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
  });

  const documented = ENDPOINTS.filter((e) => !e.undocumented);
  const undocumented = ENDPOINTS.filter((e) => e.undocumented);

  it.each(documented)(
    "$method $path still exists (used by $usedBy)",
    ({ method, path: endpointPath }) => {
      const operations = spec.paths[endpointPath];
      expect(
        operations,
        `The server no longer documents "${endpointPath}". It was renamed or removed.`,
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
    ({ method, path: endpointPath }) => {
      expect(spec.paths[endpointPath]?.[method]).toBeUndefined();
    },
  );

  it("lists no duplicate endpoints", () => {
    const seen = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
