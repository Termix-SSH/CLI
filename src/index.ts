#!/usr/bin/env node
import { Command } from "commander";
import { applyGlobalFlags, type GlobalFlags } from "./core/context.js";
import { fail } from "./core/output/index.js";
import { ExitCode } from "./core/errors.js";
import { CLI_VERSION } from "./version.js";
import { registerAuthCommands } from "./commands/login.js";
import { registerHostCommands } from "./commands/hosts.js";
import { registerExecCommands } from "./commands/exec.js";
import { registerSshCommands } from "./commands/ssh.js";
import { registerFileCommands } from "./commands/files.js";
import { registerTunnelCommands } from "./commands/tunnel.js";
import { registerDockerCommands } from "./commands/docker.js";
import { registerFleetCommands } from "./commands/fleets.js";
import { registerSessionCommands } from "./commands/sessions.js";
import { registerSnippetCommands } from "./commands/snippets.js";
import { registerCredentialCommands } from "./commands/credentials.js";
import { registerAlertCommands } from "./commands/alerts.js";
import { registerAdminCommands } from "./commands/admin.js";
import { registerApiKeyCommands } from "./commands/api-keys.js";
import { registerMiscCommands } from "./commands/misc.js";

const program = new Command();

program
  .name("termix")
  .description(
    "Command-line interface for Termix.\n\n" +
      "Authenticate with `termix login`, or set TERMIX_URL and TERMIX_API_KEY for\n" +
      "scripts and agents. Output is a table on a terminal and JSON when piped.",
  )
  .version(CLI_VERSION)
  .option("--url <url>", "Termix base URL (overrides the stored config)")
  .option("--api-key <key>", "API key (tmx_...) to authenticate with")
  .option("--json", "Force JSON output (default when stdout is not a terminal)")
  .option("--no-json", "Force human-readable output even when piped")
  .option("-q, --quiet", "Print only ids, one per line")
  .option("--no-color", "Disable coloured output")
  .option("--insecure", "Skip TLS certificate verification")
  .showSuggestionAfterError();

program.hook("preAction", (thisCommand) => {
  applyGlobalFlags(thisCommand.opts<GlobalFlags>());
});

registerAuthCommands(program);
registerHostCommands(program);
registerExecCommands(program);
registerSshCommands(program);
registerFileCommands(program);
registerTunnelCommands(program);
registerDockerCommands(program);
registerFleetCommands(program);
registerSessionCommands(program);
registerSnippetCommands(program);
registerCredentialCommands(program);
registerAlertCommands(program);
registerAdminCommands(program);
registerApiKeyCommands(program);
registerMiscCommands(program);

// Commander exits the process itself; take it over so every path leaves
// through our exit-code taxonomy instead of commander's 0/1.
program.exitOverride((error) => {
  if (
    error.code === "commander.help" ||
    error.code === "commander.helpDisplayed" ||
    error.code === "commander.version"
  ) {
    process.exit(ExitCode.OK);
  }
  throw error;
});

// Wrapped in a function rather than using top-level await: the standalone
// binaries are built as CommonJS, which cannot express it.
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (typeof code === "string" && code.startsWith("commander.")) {
      // Commander has already written the details to stderr, so exit with the
      // usage code rather than printing the same message a second time.
      process.exit(ExitCode.USAGE);
    }
    fail(error);
  }
}

void main();
