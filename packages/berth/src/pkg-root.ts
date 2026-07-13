// Shared package-root resolution.
//
// Walks up from this module to the nearest directory whose `package.json` is
// berth's. Used to locate source templates (`scripts/`, `adapters/`) both at
// scaffold time and when the CLI resolves an orchestration script to exec.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_NAME } from "./constants.js";

/** A permissive JSON object value. */
type JsonObject = { [key: string]: unknown };

/**
 * Walk up from this module to the nearest directory whose `package.json`
 * has `name === TOOL_NAME`.
 *
 * @throws Error if the package root cannot be located.
 */
export function findPkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (
          pkg &&
          typeof pkg === "object" &&
          !Array.isArray(pkg) &&
          (pkg as JsonObject)["name"] === TOOL_NAME
        ) {
          return dir;
        }
      } catch {
        // Ignore unreadable package.json and keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`${TOOL_NAME}: could not locate the package root`);
    }
    dir = parent;
  }
}
