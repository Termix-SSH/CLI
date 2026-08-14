#!/usr/bin/env node
/**
 * Build a standalone executable with Node's Single Executable Application
 * support, so users can run the CLI without installing Node.
 *
 * SEA cannot cross-compile: the binary embeds the Node runtime it was built
 * with, so each platform and architecture has to build on its own runner. The
 * release workflow does that with a matrix.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";

const outputName = process.argv[2];
if (!outputName) {
  process.stderr.write("usage: build-binary.mjs <output-name>\n");
  process.exit(1);
}

const buildDir = path.join(root, "build");
const releaseDir = path.join(root, "release");
// The CommonJS build, not the ESM one npm ships: SEA only accepts CJS.
const bundle = path.join(buildDir, "cli.cjs");

function run(command, args, options = {}) {
  const [file, argv] = isWindows
    ? ["cmd.exe", ["/d", "/s", "/c", command, ...args]]
    : [command, args];
  return execFileSync(file, argv, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
}

if (!fs.existsSync(bundle)) {
  process.stderr.write(
    `${path.relative(root, bundle)} is missing. Run \`npm run build\` first.\n`,
  );
  process.exit(1);
}

fs.mkdirSync(releaseDir, { recursive: true });

const entry = bundle;
const configPath = path.join(buildDir, "sea-config.json");
const blobPath = path.join(buildDir, "sea-prep.blob");
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: entry,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

process.stdout.write("Generating the SEA blob...\n");
run(process.execPath, ["--experimental-sea-config", configPath]);

const target = path.join(releaseDir, outputName);
fs.copyFileSync(process.execPath, target);

// Signatures cover the whole binary, so they must be removed before injecting
// and re-applied afterwards, or the OS refuses to run the result.
if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", target]);
}

process.stdout.write("Injecting the application into the runtime...\n");
const postjectArgs = [
  "postject",
  target,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run(isWindows ? "npx.cmd" : "npx", postjectArgs);

if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", target]);
}

if (!isWindows) {
  fs.chmodSync(target, 0o755);
}

const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
process.stdout.write(`\nBuilt ${path.relative(root, target)} (${sizeMb} MB)\n`);

// Prove the binary actually runs before it is uploaded as a release asset.
process.stdout.write("Verifying...\n");
const reported = execFileSync(target, ["--version"], {
  encoding: "utf8",
}).trim();
const expected = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;

if (reported !== expected) {
  process.stderr.write(
    `Binary reported version ${reported}, expected ${expected}\n`,
  );
  process.exit(1);
}
process.stdout.write(`${outputName} reports ${reported}\n`);

// Only the SEA intermediates: build/cli.cjs is a build output the next
// invocation reuses.
fs.rmSync(configPath, { force: true });
fs.rmSync(blobPath, { force: true });
