/**
 * Every Termix endpoint this CLI calls.
 *
 * This is the anti-drift contract. The CLI once shipped against endpoints that
 * had moved, and nothing caught it; `test/drift.test.ts` now checks each entry
 * against the server's own OpenAPI specification (core, or the plugin that
 * serves it), so a renamed or removed route fails CI here instead of failing
 * for a user.
 *
 * Path parameters use the OpenAPI `{name}` form so they match the spec.
 */
export interface EndpointRef {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  /** Why the CLI calls it, for whoever has to fix a drift failure. */
  usedBy: string;
  /** The plugin that serves it. Checked against `spec/plugins/<id>.json`. */
  plugin?: string;
  /**
   * Set when the route exists but is absent from the specification, so the
   * drift check skips it. Verified by hand against the server source.
   */
  undocumented?: string;
}

const plugin = (
  id: string,
  method: EndpointRef["method"],
  sub: string,
  usedBy: string,
): EndpointRef => ({
  method,
  path: `/plugin-api/${id}${sub}`,
  usedBy,
  plugin: id,
});

export const ENDPOINTS: EndpointRef[] = [
  // Authentication
  { method: "post", path: "/users/login", usedBy: "login" },
  { method: "post", path: "/users/totp/verify-login", usedBy: "login (2FA)" },
  { method: "get", path: "/users/me", usedBy: "whoami" },

  // Hosts
  { method: "get", path: "/host/db/host", usedBy: "hosts list" },
  { method: "post", path: "/host/db/host", usedBy: "hosts create" },
  {
    method: "get",
    path: "/host/db/host/{id}",
    usedBy: "hosts get, ssh, files, tunnel",
  },
  { method: "put", path: "/host/db/host/{id}", usedBy: "hosts update" },
  { method: "delete", path: "/host/db/host/{id}", usedBy: "hosts delete" },
  { method: "post", path: "/host/enroll", usedBy: "hosts enroll" },
  { method: "get", path: "/host/db/hosts/export", usedBy: "hosts export" },
  { method: "post", path: "/host/bulk-import", usedBy: "hosts import" },

  // Credentials
  { method: "get", path: "/credentials", usedBy: "credentials list" },
  { method: "post", path: "/credentials", usedBy: "credentials create" },
  { method: "get", path: "/credentials/{id}", usedBy: "credentials get" },
  { method: "put", path: "/credentials/{id}", usedBy: "credentials update" },
  { method: "delete", path: "/credentials/{id}", usedBy: "credentials delete" },

  // Administration
  { method: "get", path: "/audit-logs", usedBy: "audit-logs" },
  { method: "get", path: "/users/list", usedBy: "users list" },
  { method: "post", path: "/users/api-keys", usedBy: "api-keys create" },
  { method: "get", path: "/users/api-keys", usedBy: "api-keys list" },
  {
    method: "delete",
    path: "/users/api-keys/{keyId}",
    usedBy: "api-keys revoke",
  },

  // Sessions
  { method: "get", path: "/users/sessions", usedBy: "sessions list" },
  {
    method: "delete",
    path: "/users/sessions/{sessionId}",
    usedBy: "sessions revoke",
  },
  {
    method: "post",
    path: "/users/sessions/revoke-all",
    usedBy: "sessions revoke-all",
  },

  // Status, health and plugins
  { method: "get", path: "/health", usedBy: "version" },
  { method: "get", path: "/version", usedBy: "version" },
  { method: "get", path: "/plugins", usedBy: "plugins, feature checks" },
  { method: "get", path: "/host/status", usedBy: "status" },
  { method: "get", path: "/host/status/{id}", usedBy: "status <hostId>" },

  // Snippets, which also back `termix exec`
  plugin("snippets", "get", "", "snippets list"),
  plugin("snippets", "post", "", "snippets create, exec"),
  plugin("snippets", "put", "/{id}", "snippets update"),
  plugin("snippets", "delete", "/{id}", "snippets delete, exec"),
  plugin("snippets", "post", "/execute", "snippets run, exec"),

  // Alerts
  plugin("alerts", "get", "/items", "alerts list"),
  plugin("alerts", "post", "/items/read", "alerts dismiss, undismiss"),
  plugin("alerts", "delete", "/items/{id}", "alerts delete"),

  // File manager
  plugin("file-manager", "post", "/connect", "files (session setup)"),
  plugin("file-manager", "post", "/connect-totp", "files (host 2FA)"),
  plugin("file-manager", "post", "/disconnect", "files (session teardown)"),
  plugin("file-manager", "get", "/listFiles", "files ls"),
  plugin("file-manager", "get", "/readFile", "files cat, get"),
  plugin("file-manager", "post", "/writeFile", "files put"),
  plugin("file-manager", "post", "/createFolder", "files mkdir"),
  plugin("file-manager", "delete", "/deleteItem", "files rm"),

  // Fleets
  plugin("fleets", "get", "", "fleets list"),
  plugin("fleets", "post", "", "fleets create"),
  plugin("fleets", "delete", "/{id}", "fleets delete"),
  plugin("fleets", "get", "/{id}/members", "fleets members"),
  plugin("fleets", "post", "/{id}/members", "fleets add-host"),
  plugin("fleets", "delete", "/{id}/members/{hostId}", "fleets remove-host"),
  plugin("fleets", "post", "/{id}/execute", "fleets exec"),

  // Tunnels
  plugin("tunnels", "get", "/status", "tunnel list"),
  plugin("tunnels", "get", "/status/{tunnelName}", "tunnel start (wait)"),
  plugin("tunnels", "post", "/connect", "tunnel start"),
  plugin("tunnels", "post", "/disconnect", "tunnel stop"),

  // Docker
  plugin("docker", "post", "/ssh/connect", "docker (session setup)"),
  plugin("docker", "post", "/ssh/connect-totp", "docker (host 2FA)"),
  plugin("docker", "post", "/ssh/disconnect", "docker (session teardown)"),
  plugin("docker", "get", "/containers/{sessionId}", "docker ps"),
  plugin(
    "docker",
    "get",
    "/containers/{sessionId}/{containerId}/logs",
    "docker logs",
  ),
  plugin(
    "docker",
    "post",
    "/containers/{sessionId}/{containerId}/{action}",
    "docker start, stop, restart, pause, unpause",
  ),
];

/**
 * WebSocket endpoints, which OpenAPI does not describe. Listed so the set of
 * server surfaces the CLI depends on is documented in one place.
 */
export const WEBSOCKET_ENDPOINTS = [
  {
    path: "/plugin-ws/ssh-terminal/terminal",
    usedBy: "ssh (interactive terminal)",
  },
];
