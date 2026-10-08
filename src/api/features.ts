/**
 * Features the CLI drives that a plugin provides, not core.
 *
 * Since Termix 2.9 the terminal, file manager, Docker, tunnels, fleets,
 * snippets and alerts are plugins. An admin can remove or turn off any of
 * them, so a command checks its plugin before calling it.
 */
export const FEATURES = {
  terminal: {
    pluginId: "ssh-terminal",
    label: "The SSH terminal",
    commands: ["ssh"],
  },
  files: {
    pluginId: "file-manager",
    label: "The file manager",
    commands: ["files"],
  },
  docker: { pluginId: "docker", label: "Docker", commands: ["docker"] },
  tunnels: { pluginId: "tunnels", label: "Tunnels", commands: ["tunnel"] },
  fleets: { pluginId: "fleets", label: "Fleets", commands: ["fleets"] },
  snippets: {
    pluginId: "snippets",
    label: "Snippets",
    commands: ["snippets", "exec"],
  },
  alerts: { pluginId: "alerts", label: "Alerts", commands: ["alerts"] },
} as const;

export type Feature = keyof typeof FEATURES;

/** The CLI commands a plugin unlocks, for `termix plugins`. */
export function commandsForPlugin(pluginId: string): string[] {
  return Object.values(FEATURES)
    .filter((feature) => feature.pluginId === pluginId)
    .flatMap((feature) => [...feature.commands]);
}

/** Path to a feature's HTTP route, e.g. `pluginPath("docker", "/ssh/connect")`. */
export function pluginPath(feature: Feature, sub = ""): string {
  const tail = !sub || sub.startsWith("/") ? sub : `/${sub}`;
  return `/plugin-api/${FEATURES[feature].pluginId}${tail}`;
}
