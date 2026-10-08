import type { Command } from "commander";
import { createContext } from "../core/context.js";
import { getServerPlugins } from "../core/plugins.js";
import { commandsForPlugin } from "../api/features.js";
import { printList, run, type Column } from "../core/output/index.js";

type PluginRow = Record<string, unknown>;

const PLUGIN_COLUMNS: Column<PluginRow>[] = [
  { header: "id", value: (p) => p.id },
  { header: "name", value: (p) => p.name },
  { header: "version", value: (p) => p.version },
  { header: "state", value: (p) => p.state },
  { header: "commands", value: (p) => p.commands },
];

export function registerPluginCommands(program: Command): void {
  const plugins = program
    .command("plugins")
    .description(
      "Show the plugins on the server, and which CLI commands each one enables.",
    );

  plugins
    .command("list", { isDefault: true })
    .description("List the server's plugins.")
    .action(async function (this: Command) {
      await run(async () => {
        const { client } = await createContext(this);
        const rows = (await getServerPlugins(client)).map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          enabled: plugin.enabled,
          state: plugin.state,
          commands: commandsForPlugin(plugin.id),
        }));
        printList(rows, PLUGIN_COLUMNS, {
          jsonWrapper: (all) => ({ count: all.length, plugins: all }),
        });
      });
    });
}
