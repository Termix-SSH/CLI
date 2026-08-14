import type { Command } from "commander";
import { resolveConfig, type CliConfig } from "./config.js";
import { loadSession } from "./credentials-store.js";
import { TermixClient } from "./http.js";
import { configureOutput } from "./output/index.js";

export interface GlobalFlags {
  url?: string;
  apiKey?: string;
  json?: boolean;
  quiet?: boolean;
  color?: boolean;
  insecure?: boolean;
}

/**
 * Everything a command action needs, resolved once.
 *
 * Commands take this instead of each reaching for resolveConfig/new
 * TermixClient themselves, so global flags apply uniformly and there is a
 * single place to change how credentials and output are set up.
 */
export interface CommandContext {
  config: CliConfig;
  client: TermixClient;
}

/** Read the global flags from the root command, wherever we are in the tree. */
export function globalFlags(command: Command): GlobalFlags {
  let root: Command = command;
  while (root.parent) root = root.parent;
  return root.opts<GlobalFlags>();
}

/**
 * Apply output flags. Called once from the root preAction hook, before any
 * command action runs, so even early failures render in the right mode.
 */
export function applyGlobalFlags(flags: GlobalFlags): void {
  configureOutput({
    json: flags.json,
    quiet: flags.quiet,
    color: flags.color,
  });
  if (flags.insecure) {
    process.env.TERMIX_INSECURE_TLS = "true";
  }
}

/**
 * Build the context for a command action. Throws if no server is configured.
 *
 * Async because the session token may live in the OS keychain, which can only
 * be read asynchronously. An explicit credential short-circuits that lookup.
 */
export async function createContext(command: Command): Promise<CommandContext> {
  const flags = globalFlags(command);
  const config = resolveConfig(process.env, {
    url: flags.url,
    apiKey: flags.apiKey,
  });

  // resolveConfig only sees the config file. When it found no token and none
  // was supplied explicitly, the keychain is the remaining place to look.
  if (!config.token && !config.apiKey) {
    const session = await loadSession();
    if (session?.token && session.url === config.url) {
      config.token = session.token;
    }
  }

  return { config, client: new TermixClient(config) };
}
