import {
  loadStoredConfig,
  saveStoredConfig,
  deleteStoredConfig,
  type StoredConfig,
} from "./config.js";

const SERVICE = "termix-cli";

interface Keytar {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(
    service: string,
    account: string,
    password: string,
  ): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let keytarPromise: Promise<Keytar | null> | undefined;

/**
 * Load the OS keychain binding, or null when it is unavailable.
 *
 * keytar is an optional dependency with a native component: it is missing on
 * musl and headless Linux boxes, and installing it must never be required to
 * use the CLI. Everything here degrades to the config file instead.
 */
async function loadKeytar(): Promise<Keytar | null> {
  if (!keytarPromise) {
    keytarPromise = import("keytar")
      .then((mod) => (mod.default ?? mod) as unknown as Keytar)
      .catch(() => null);
  }
  return keytarPromise;
}

/** Keychain entries are per server URL, so several servers can coexist. */
function accountFor(url: string): string {
  return url;
}

/**
 * Persist a session.
 *
 * The token goes to the OS keychain when one is available, and the config file
 * keeps only the non-secret parts. This matters most on Windows, where the
 * file's 0600 mode is not enforceable.
 */
export async function saveSession(config: StoredConfig): Promise<{
  file: string;
  usedKeychain: boolean;
}> {
  const keytar = await loadKeytar();

  if (keytar && config.token) {
    try {
      await keytar.setPassword(SERVICE, accountFor(config.url), config.token);
      const file = saveStoredConfig({
        url: config.url,
        username: config.username,
      });
      return { file, usedKeychain: true };
    } catch {
      // Keychain locked or unavailable at runtime: fall through to the file.
    }
  }

  return { file: saveStoredConfig(config), usedKeychain: false };
}

/** Read the stored session, consulting the keychain when the file has no token. */
export async function loadSession(): Promise<StoredConfig | null> {
  const stored = loadStoredConfig();
  if (!stored) return null;
  if (stored.token) return stored;

  const keytar = await loadKeytar();
  if (!keytar) return stored;

  try {
    const token = await keytar.getPassword(SERVICE, accountFor(stored.url));
    return token ? { ...stored, token } : stored;
  } catch {
    return stored;
  }
}

/** Remove the stored session from both the file and the keychain. */
export async function clearSession(): Promise<boolean> {
  const stored = loadStoredConfig();
  const removed = deleteStoredConfig();

  if (stored) {
    const keytar = await loadKeytar();
    if (keytar) {
      try {
        await keytar.deletePassword(SERVICE, accountFor(stored.url));
      } catch {
        // Nothing stored, or the keychain is unavailable.
      }
    }
  }

  return removed;
}

/** Whether an OS keychain is usable, for `termix whoami` to report. */
export async function keychainAvailable(): Promise<boolean> {
  return (await loadKeytar()) !== null;
}
