/**
 * Injected at build time from package.json by tsup's `define`.
 *
 * The previous approach read ../package.json relative to import.meta.url,
 * which breaks as soon as dist/ is published on its own - the published
 * package has a different layout than the repo.
 */
declare const __CLI_VERSION__: string;

export const CLI_VERSION: string =
  typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev";
