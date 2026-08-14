#!/usr/bin/env node
/**
 * Packaged-install smoke test.
 *
 * Builds, packs and installs the tarball into a throwaway prefix, then runs the
 * binary the way a user would. This catches the failures unit tests cannot: a
 * missing entry in `files`, a broken bin path, a shebang that got mangled, or a
 * dependency that was bundled wrong.
 *
 * Nothing is published and the global environment is untouched.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "termix-cli-smoke-"));
const isWindows = process.platform === "win32";

let failures = 0;

class StepFailure extends Error {}

function step(label, fn, { required = false } = {}) {
  process.stdout.write(`${label} ... `);
  try {
    const result = fn();
    process.stdout.write("ok\n");
    return result;
  } catch (error) {
    failures += 1;
    process.stdout.write("FAILED\n");
    const detail = error.stdout || error.stderr || error.message;
    process.stdout.write(`${String(detail).trim()}\n\n`);

    // Later steps drive a binary that a failed build or install never
    // produced, so reporting each of those as its own failure just buries the
    // one that matters.
    if (required) {
      throw new StepFailure(label);
    }
    return undefined;
  }
}

/**
 * Never runs through a shell. On Windows the executables are .cmd wrappers, so
 * they are invoked via cmd.exe with the path passed as an argument - that keeps
 * arguments properly escaped rather than concatenated into a command string.
 */
function run(command, args, options = {}) {
  const [file, argv] = isWindows
    ? ["cmd.exe", ["/d", "/s", "/c", command, ...args]]
    : [command, args];

  return execFileSync(file, argv, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
}

function runNpm(args, options = {}) {
  return run(isWindows ? "npm.cmd" : "npm", args, options);
}

try {
  step("build", () => execSync("npm run build", { cwd: root, stdio: "pipe" }), {
    required: true,
  });

  const tarball = step(
    "pack",
    () => {
      // --ignore-scripts skips `prepare`, which runs husky. That is a
      // developer-machine concern and fails anywhere without a git checkout,
      // so it must not decide whether the package is sound.
      const output = runNpm(
        ["pack", "--ignore-scripts", "--pack-destination", workDir],
        { cwd: root },
      );
      return path.join(workDir, output.trim().split("\n").pop().trim());
    },
    { required: true },
  );

  step("tarball contains the built entry point", () => {
    // npm force-includes the `bin` target even when `files` omits it, so a
    // working install does not prove the package is correct. Check the
    // manifest directly.
    const listing = runNpm(
      ["pack", "--dry-run", "--ignore-scripts", "--json"],
      {
        cwd: root,
      },
    );
    const [meta] = JSON.parse(listing);
    const entries = (meta?.files ?? []).map((f) => f.path);

    for (const required of ["dist/index.js", "README.md", "LICENSE"]) {
      if (!entries.includes(required)) {
        throw new Error(
          `${required} is missing from the tarball (found: ${entries.join(", ")})`,
        );
      }
    }
    // Source maps are large and of no use to an installing user.
    const stray = entries.filter((f) => f.endsWith(".node"));
    if (stray.length > 0) {
      throw new Error(
        `Native binaries must not be bundled: ${stray.join(", ")}`,
      );
    }
  });

  // A private prefix keeps this out of the real global node_modules.
  const prefix = path.join(workDir, "prefix");
  fs.mkdirSync(prefix, { recursive: true });

  step(
    "install globally",
    () =>
      runNpm(["install", "--global", "--prefix", prefix, tarball], {
        cwd: workDir,
      }),
    { required: true },
  );

  const binary = isWindows
    ? path.join(prefix, "termix.cmd")
    : path.join(prefix, "bin", "termix");

  const runCli = (args, options = {}) => run(binary, args, options);

  step(
    "binary exists",
    () => {
      if (!fs.existsSync(binary)) {
        throw new Error(`No executable at ${binary}`);
      }
    },
    { required: true },
  );

  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;

  step("--version matches package.json", () => {
    const reported = runCli(["--version"]).trim();
    if (reported !== pkgVersion) {
      throw new Error(`Reported ${reported}, expected ${pkgVersion}`);
    }
  });

  step("--help lists commands", () => {
    const help = runCli(["--help"]);
    for (const command of ["login", "ssh", "hosts", "files", "exec"]) {
      if (!help.includes(command)) {
        throw new Error(`"${command}" missing from --help`);
      }
    }
  });

  step("exits 2 on an unknown command", () => {
    try {
      runCli(["not-a-command"]);
      throw new Error("Expected a non-zero exit");
    } catch (error) {
      if (error.status !== 2) {
        throw new Error(`Exited ${error.status}, expected 2`);
      }
    }
  });

  step("exits 6 when the server is unreachable", () => {
    try {
      // Port 9 (discard) refuses connections.
      runCli([
        "--url",
        "http://127.0.0.1:9",
        "--api-key",
        "tmx_smoke",
        "hosts",
        "list",
      ]);
      throw new Error("Expected a non-zero exit");
    } catch (error) {
      if (error.status !== 6) {
        throw new Error(`Exited ${error.status}, expected 6`);
      }
    }
  });

  step("keeps warnings off stdout", () => {
    try {
      const stdout = runCli(
        [
          "--url",
          "http://127.0.0.1:9",
          "--api-key",
          "tmx_smoke",
          "hosts",
          "list",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      if (stdout.trim()) {
        throw new Error(`stdout should be empty, got: ${stdout}`);
      }
    } catch (error) {
      // A non-zero exit is expected here; only stdout content matters.
      if (error.stdout && error.stdout.trim()) {
        throw new Error(`stdout should be empty, got: ${error.stdout}`);
      }
    }
  });
} catch (error) {
  // A required step already reported itself; anything else is a bug here.
  if (!(error instanceof StepFailure)) {
    throw error;
  }
  process.stdout.write("Skipping the remaining checks.\n");
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  process.stderr.write(`\n${failures} smoke check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nAll smoke checks passed.\n");
