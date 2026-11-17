/**
 * Where this server keeps its mutable state (browser profile with session cookies, cache, outputs, diagnostics).
 *
 *  - PERPLEXITY_DATA_DIR overrides everything.
 *  - Running from a git clone / copied folder keeps the legacy behaviour: state lives next to the package.
 *  - Running from an installed package (npm cache, `npx`, global install, node_modules) uses ~/.perplexity-web-mcp,
 *    because the package directory is disposable and would silently lose the login session.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function packageDir() {
    return PACKAGE_DIR;
}

export function isInstalledPackage(dir = PACKAGE_DIR) {
    return dir.split(/[\\/]/).includes("node_modules") || /[\\/]_npx[\\/]/.test(dir);
}

export function resolveDataRoot(env = process.env, dir = PACKAGE_DIR) {
    const custom = env?.PERPLEXITY_DATA_DIR?.trim();
    if (custom)
        return path.resolve(custom);
    return isInstalledPackage(dir) ? path.join(os.homedir(), ".perplexity-web-mcp") : dir;
}

export function dataPath(...parts) {
    return path.join(resolveDataRoot(), ...parts);
}
