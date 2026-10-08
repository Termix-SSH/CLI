// Copies the OpenAPI specs the drift test checks against from a Termix-Docs
// checkout: core.json to spec/openapi.json, and the plugins the CLI calls to
// spec/plugins/<id>.json. Run `npm run sync` in Termix-Docs first.
//
//   node scripts/sync-spec.mjs [path-to-termix-docs]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const docs = path.resolve(
  process.argv[2] ?? path.join(root, "..", "Termix-Docs"),
);
const source = path.join(docs, "static", "openapi");

// The plugins named in the endpoint contract, read from its source so this
// needs no build.
const contract = fs.readFileSync(
  path.join(root, "src", "api", "endpoints.ts"),
  "utf8",
);
const plugins = new Set(
  [...contract.matchAll(/plugin\(\s*"([^"]+)"/g)].map((m) => m[1]),
);

if (!fs.existsSync(path.join(source, "core.json"))) {
  console.error(`No OpenAPI specs at ${source}. Pass the Termix-Docs path.`);
  process.exit(1);
}

// Formatted so the files pass the format check.
async function copySpec(from, to) {
  const raw = fs.readFileSync(from, "utf8");
  fs.writeFileSync(to, await prettier.format(raw, { parser: "json" }));
}

await copySpec(
  path.join(source, "core.json"),
  path.join(root, "spec", "openapi.json"),
);
fs.mkdirSync(path.join(root, "spec", "plugins"), { recursive: true });
for (const id of plugins) {
  await copySpec(
    path.join(source, "plugins", `${id}.json`),
    path.join(root, "spec", "plugins", `${id}.json`),
  );
}
console.log(`Synced core and ${plugins.size} plugin specs from ${source}`);
