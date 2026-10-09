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

function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  return (
    lines
      .slice(start + 1, end)
      .join("\n")
      .trim() || null
  );
}

/**
 * Standalone binaries, one per platform and architecture. The names match what
 * .github/workflows/release.yml uploads, so a change here needs the same change
 * there.
 */
function buildTable(version) {
  const tag = `v${version}`;
  const base = `https://github.com/Termix-SSH/CLI/releases/download/${tag}`;
  const url = (file) => `${base}/${file}`;

  return [
    "| Architecture | Windows | Linux | macOS |",
    "| ------------ | ------- | ----- | ----- |",
    `| **x86-64 (64-bit)** | [EXE](${url("termix_windows_x64.exe")}) | [Binary](${url("termix_linux_x64")}) | [Binary](${url("termix_macos_x64")}) |`,
    `| **AArch64 (ARM64)** | - | [Binary](${url("termix_linux_arm64")}) | [Binary](${url("termix_macos_arm64")}) |`,
    `| **Any** | [npm](https://www.npmjs.com/package/@termix-ssh/cli) | [npm](https://www.npmjs.com/package/@termix-ssh/cli) | [npm](https://www.npmjs.com/package/@termix-ssh/cli) |`,
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version;
  const changelogPath = path.resolve(args.changelog || "CHANGELOG.md");

  if (!version || version === true) fail("--version is required");
  if (!fs.existsSync(changelogPath)) {
    fail(`changelog not found: ${changelogPath}`);
  }

  const changelog = fs.readFileSync(changelogPath, "utf8");
  const notes = changelogSection(changelog, version);
  if (!notes) fail(`CHANGELOG.md has no notes for ${version}`);

  // The summary is everything before the first ### list
  const listStart = notes.search(/^### /m);
  const summary = (listStart === -1 ? notes : notes.slice(0, listStart)).trim();
  const lists = listStart === -1 ? "" : notes.slice(listStart).trim();

  const install = [
    "```bash",
    "npm install -g @termix-ssh/cli",
    "```",
    "",
    "Or download a standalone binary below, which needs no Node.js install.",
  ].join("\n");

  const donateAlert = [
    "> [!TIP]",
    "> Termix is free and always will be. If it's useful to you, consider [donating](https://donate.termix.site/donate/) to support development.",
  ].join("\n");

  const body = [donateAlert, "", summary, "", install, "", buildTable(version)];
  if (lists) body.push("", lists);

  process.stdout.write(body.join("\n") + "\n");
}

main();
