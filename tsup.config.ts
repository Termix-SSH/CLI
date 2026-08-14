import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

const shared = {
  target: "node20",
  platform: "node" as const,
  // Bundle dependencies so the published package has no runtime resolution
  // cost and no dependency drift at install time. keytar is excluded by the
  // negative lookahead: it is an optional native module, so bundling it would
  // ship one platform's .node binary to every platform. Left external, it is
  // resolved at runtime from node_modules when present.
  noExternal: [/^(?!keytar$).*/],
  external: ["keytar"],
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    format: ["esm"],
    outDir: "dist",
    clean: true,
    sourcemap: true,
    // Bundling CommonJS deps (commander, axios) into an ESM output leaves
    // their internal require() calls with nothing to resolve against. Give the
    // bundle a real require so those keep working.
    // No banner beyond this: tsup preserves the shebang from src/index.ts.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
  },
  {
    // A CommonJS build for the standalone binaries. Node's SEA only accepts
    // CJS, and it runs the entry point without a real file path, so the ESM
    // bundle's createRequire(import.meta.url) cannot work there.
    ...shared,
    entry: { cli: "src/index.ts" },
    format: ["cjs"],
    outDir: "build",
    clean: false,
    sourcemap: false,
  },
]);
