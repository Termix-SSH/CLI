#!/usr/bin/env node
/**
 * Rebuild from a clean slate, then run the CLI with whatever arguments follow.
 *
 * The point is that there is never a stale `dist/` to second-guess: every run
 * deletes the previous build first. Arguments pass straight through, and the
 * CLI's exit code becomes this script's, so exit-code behaviour can be tested
 * exactly as a user would see it.
 *
 *   npm run cli -- hosts list
 *   npm run cli -- ssh 3
 *   npm run cli -- --help
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const args = process.argv.slice(2);

// tsup cleans dist/ itself, but build/ holds the CommonJS bundle used for the
// standalone binaries and would otherwise go stale next to a fresh dist/.
for (const dir of ["dist", "build"]) {
  fs.rmSync(path.join(root, dir), { recursive: true, force: true });
}

// Build output goes to stderr so `npm run cli -- hosts list --json | jq` still
// sees only the CLI's own stdout.
process.stderr.write("Rebuilding...\n");

// Windows resolves npx through a .cmd wrapper, which needs cmd.exe. Passing
// the arguments after /c keeps them escaped rather than concatenated.
const [buildFile, buildArgs] = isWindows
  ? ["cmd.exe", ["/d", "/s", "/c", "npx.cmd", "tsup"]]
  : ["npx", ["tsup"]];

// Captured rather than inherited: a successful build has nothing worth
// reading, and it would otherwise bury the output being tested. On failure
// everything is replayed.
const build = spawnSync(buildFile, buildArgs, {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (build.status !== 0) {
  process.stderr.write(build.stdout ?? "");
  process.stderr.write(build.stderr ?? "");
  process.stderr.write("\nBuild failed.\n");
  process.exit(1);
}

const entry = path.join(root, "dist", "index.js");
if (!fs.existsSync(entry)) {
  process.stderr.write("Build produced no dist/index.js.\n");
  process.exit(1);
}

// Inherit stdio so interactive commands (`ssh`, password prompts) work, and
// spawnSync rather than execFileSync so a non-zero exit is not an exception.
const result = spawnSync(process.execPath, [entry, ...args], {
  cwd: process.cwd(),
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

// Signals have no exit code; report them the way a shell does.
if (result.signal) {
  process.exit(128 + (result.status ?? 0));
}

process.exit(result.status ?? 0);
