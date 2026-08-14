/**
 * Every Termix endpoint this CLI calls.
 *
 * This is the anti-drift contract. The CLI once shipped against endpoints that
 * had moved, and nothing caught it; `test/drift.test.ts` now checks each entry
 * against the server's own OpenAPI specification, so a renamed or removed
 * route fails CI here instead of failing for a user.
 *
 * Path parameters use the OpenAPI `{name}` form so they match the spec.
 */
export interface EndpointRef {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  /** Why the CLI calls it, for whoever has to fix a drift failure. */
  usedBy: string;
  /**
   * Set when the route exists but is absent from the specification, so the
   * drift check skips it. The generator only scans the per-feature route
   * directories, so routes registered directly on the Express app are never
   * documented. Verified by hand against the server source.
   */
  undocumented?: string;
}

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
    usedBy: "hosts get, ssh, files",
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

  // Snippets, which also back `termix exec`
  { method: "get", path: "/snippets", usedBy: "snippets list" },
  { method: "post", path: "/snippets", usedBy: "snippets create, exec" },
  { method: "put", path: "/snippets/{id}", usedBy: "snippets update" },
  { method: "delete", path: "/snippets/{id}", usedBy: "snippets delete, exec" },
  { method: "post", path: "/snippets/execute", usedBy: "snippets run, exec" },

  // Alerts
  { method: "get", path: "/alerts", usedBy: "alerts list" },
  { method: "post", path: "/alerts/dismiss", usedBy: "alerts dismiss" },
  { method: "delete", path: "/alerts/dismiss", usedBy: "alerts undismiss" },

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

  // Status and health
  {
    method: "get",
    path: "/health",
    usedBy: "version",
    undocumented: "registered on the app in database.ts, not in a routes file",
  },
  {
    method: "get",
    path: "/version",
    usedBy: "version",
    undocumented: "registered on the app in database.ts, not in a routes file",
  },
  { method: "get", path: "/status", usedBy: "status" },
  { method: "get", path: "/status/{id}", usedBy: "status <hostId>" },

  // File manager
  {
    method: "post",
    path: "/ssh/file_manager/ssh/connect",
    usedBy: "files (session setup)",
  },
  {
    method: "post",
    path: "/ssh/file_manager/ssh/disconnect",
    usedBy: "files (session teardown)",
  },
  {
    method: "get",
    path: "/ssh/file_manager/ssh/listFiles",
    usedBy: "files ls",
  },
  {
    method: "get",
    path: "/ssh/file_manager/ssh/readFile",
    usedBy: "files cat, get",
  },
  {
    method: "post",
    path: "/ssh/file_manager/ssh/writeFile",
    usedBy: "files put",
  },
  {
    method: "post",
    path: "/ssh/file_manager/ssh/createFolder",
    usedBy: "files mkdir",
  },
  {
    method: "delete",
    path: "/ssh/file_manager/ssh/deleteItem",
    usedBy: "files rm",
  },

  // Fleets
  { method: "get", path: "/fleets", usedBy: "fleets list" },
  { method: "post", path: "/fleets", usedBy: "fleets create" },
  { method: "delete", path: "/fleets/{id}", usedBy: "fleets delete" },
  { method: "get", path: "/fleets/{id}/members", usedBy: "fleets members" },
  { method: "post", path: "/fleets/{id}/members", usedBy: "fleets add-host" },
  {
    method: "delete",
    path: "/fleets/{id}/members/{hostId}",
    usedBy: "fleets remove-host",
  },
  { method: "post", path: "/fleets/{id}/execute", usedBy: "fleets exec" },

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

  // Tunnels
  { method: "get", path: "/ssh/tunnel/status", usedBy: "tunnel list" },
  { method: "post", path: "/ssh/tunnel/connect", usedBy: "tunnel start" },
  { method: "post", path: "/ssh/tunnel/disconnect", usedBy: "tunnel stop" },

  // Docker
  {
    method: "post",
    path: "/docker/ssh/connect",
    usedBy: "docker (session setup)",
  },
  {
    method: "post",
    path: "/docker/ssh/disconnect",
    usedBy: "docker (session teardown)",
  },
  {
    method: "get",
    path: "/docker/containers/{sessionId}",
    usedBy: "docker ps",
  },
  {
    method: "get",
    path: "/docker/containers/{sessionId}/{containerId}/logs",
    usedBy: "docker logs",
  },
  {
    method: "post",
    path: "/docker/containers/{sessionId}/{containerId}/start",
    usedBy: "docker start",
  },
  {
    method: "post",
    path: "/docker/containers/{sessionId}/{containerId}/stop",
    usedBy: "docker stop",
  },
  {
    method: "post",
    path: "/docker/containers/{sessionId}/{containerId}/restart",
    usedBy: "docker restart",
  },
  {
    method: "post",
    path: "/docker/containers/{sessionId}/{containerId}/pause",
    usedBy: "docker pause",
  },
  {
    method: "post",
    path: "/docker/containers/{sessionId}/{containerId}/unpause",
    usedBy: "docker unpause",
  },
];

/**
 * WebSocket endpoints, which OpenAPI does not describe. Listed so the set of
 * server surfaces the CLI depends on is documented in one place.
 */
export const WEBSOCKET_ENDPOINTS = [
  { path: "/ssh/websocket/", usedBy: "ssh (interactive terminal)" },
];
