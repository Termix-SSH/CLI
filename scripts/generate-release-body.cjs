const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function fail(message) {
  console.error(`generate-release-body: ${message}`);
  process.exit(1);
}

function extractSection(notes, name) {
  const pattern = new RegExp(
    `<!--\\s*${name}\\s*-->([\\s\\S]*?)<!--\\s*/${name}\\s*-->`,
  );
  const match = notes.match(pattern);
  if (!match) {
    fail(`missing <!-- ${name} --> section in release notes`);
  }
  const value = match[1].trim();
  if (!value) {
    fail(`empty <!-- ${name} --> section in release notes`);
  }
  return value;
}

/**
 * Standalone binaries, one per platform and architecture. The names match what
 * .github/workflows/release.yml uploads, so a change here needs the same change
 * there.
 */
function buildTable(version) {
  const tag = `release-${version}-tag`;
  const base = `https://github.com/Termix-SSH/CLI/releases/download/${tag}`;
  const url = (file) => `${base}/${file}`;

  return [
    "| Architecture | Windows | Linux | macOS |",
    "| ------------ | ------- | ----- | ----- |",
    `| **x86-64 (64-bit)** | [EXE](${url("termix_windows_x64.exe")}) | [Binary](${url("termix_linux_x64")}) | [Binary](${url("termix_macos_x64")}) |`,
    `| **AArch64 (ARM64)** | — | [Binary](${url("termix_linux_arm64")}) | [Binary](${url("termix_macos_arm64")}) |`,
    `| **Any** | [npm](https://www.npmjs.com/package/termix-cli) | [npm](https://www.npmjs.com/package/termix-cli) | [npm](https://www.npmjs.com/package/termix-cli) |`,
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version;
  const notesPath = args.notes || "RELEASE_NOTES.md";

  if (!version || version === true) fail("--version is required");

  const resolvedNotes = path.resolve(notesPath);
  if (!fs.existsSync(resolvedNotes)) {
    fail(`release notes file not found: ${resolvedNotes}`);
  }

  const notes = fs.readFileSync(resolvedNotes, "utf8");
  const summary = extractSection(notes, "SUMMARY");
  const updateLog = extractSection(notes, "UPDATE_LOG");
  const bugFixes = extractSection(notes, "BUG_FIXES");

  const install = [
    "```bash",
    "npm install -g termix-cli",
    "```",
    "",
    "Or download a standalone binary below, which needs no Node.js install.",
  ].join("\n");

  const donateAlert = [
    "> [!TIP]",
    "> Termix is free and always will be. If it's useful to you, consider [donating](https://donate.termix.site/donate/) to support development.",
  ].join("\n");

  const body = [
    donateAlert,
    "",
    summary,
    "",
    install,
    "",
    buildTable(version),
    "",
    "Update Log:",
    updateLog,
    "",
    "Bug Fixes:",
    bugFixes,
  ].join("\n");

  process.stdout.write(body + "\n");
}

main();
