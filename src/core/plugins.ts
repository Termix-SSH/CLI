import { FEATURES, type Feature } from "../api/features.js";
import { FeatureUnavailableError, TermixApiError } from "./errors.js";
import type { TermixClient } from "./http.js";

/** One entry of `GET /plugins`, as every signed-in user sees it. */
export interface ServerPlugin {
  id: string;
  name?: string;
  version?: string;
  enabled?: boolean;
  state?: string;
  [key: string]: unknown;
}

const OLD_SERVER =
  "This server runs a Termix version older than 2.9, which this CLI no longer supports. Use @termix-ssh/cli 1.0.x with it, or upgrade Termix.";

const cache = new WeakMap<TermixClient, Promise<ServerPlugin[]>>();

/**
 * The server's plugins, fetched once per client.
 *
 * `GET /plugins` came with the plugin system in 2.9, so a server that answers
 * anything but a list is older than every version this CLI supports.
 */
export function getServerPlugins(
  client: TermixClient,
): Promise<ServerPlugin[]> {
  let pending = cache.get(client);
  if (!pending) {
    pending = fetchPlugins(client);
    cache.set(client, pending);
    // A failed lookup should not stick for the rest of the process.
    pending.catch(() => cache.delete(client));
  }
  return pending;
}

async function fetchPlugins(client: TermixClient): Promise<ServerPlugin[]> {
  let data: unknown;
  try {
    data = await client.request({ method: "GET", path: "/plugins" });
  } catch (error) {
    if (error instanceof TermixApiError && error.status === 404) {
      throw new Error(OLD_SERVER);
    }
    throw error;
  }
  if (!Array.isArray(data)) throw new Error(OLD_SERVER);
  return data.filter(
    (entry): entry is ServerPlugin =>
      !!entry && typeof (entry as ServerPlugin).id === "string",
  );
}

/** True when the plugin is installed and running. */
export function isPluginActive(plugin: ServerPlugin): boolean {
  if (plugin.state) return plugin.state === "active";
  return plugin.enabled === true;
}

/** Throw a FeatureUnavailableError unless the feature's plugin is running. */
export async function requireFeature(
  client: TermixClient,
  feature: Feature,
): Promise<void> {
  const { pluginId } = FEATURES[feature];
  const plugin = (await getServerPlugins(client)).find(
    (p) => p.id === pluginId,
  );
  if (!plugin) throw featureMissing(feature);
  if (!isPluginActive(plugin)) throw featureDisabled(feature);
}

export function featureMissing(feature: Feature): FeatureUnavailableError {
  const { label, pluginId } = FEATURES[feature];
  return new FeatureUnavailableError(
    `${label} is not installed on this server (plugin "${pluginId}").`,
    pluginId,
    "missing",
  );
}

export function featureDisabled(feature: Feature): FeatureUnavailableError {
  const { label, pluginId } = FEATURES[feature];
  return new FeatureUnavailableError(
    `${label} is turned off on this server (plugin "${pluginId}").`,
    pluginId,
    "disabled",
  );
}

/** Map a plugin id from a server error back to the friendly error. */
export function unavailableFor(
  pluginId: string,
  reason: "missing" | "disabled",
): FeatureUnavailableError {
  const entry = Object.entries(FEATURES).find(
    ([, value]) => value.pluginId === pluginId,
  );
  if (entry) {
    const feature = entry[0] as Feature;
    return reason === "missing"
      ? featureMissing(feature)
      : featureDisabled(feature);
  }
  return new FeatureUnavailableError(
    reason === "missing"
      ? `The "${pluginId}" plugin is not installed on this server.`
      : `The "${pluginId}" plugin is turned off on this server.`,
    pluginId,
    reason,
  );
}
