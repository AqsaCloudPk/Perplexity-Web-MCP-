import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";

export const DEFAULT_DIAGNOSTICS_DIR = dataPath("diagnostics");
const MAX_SNAPSHOT_GROUPS = 30;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export function resolveDiagnosticsDir(env = process.env) {
    const custom = env?.PERPLEXITY_DIAGNOSTICS_DIR;
    return custom && String(custom).trim() ? path.resolve(String(custom).trim()) : DEFAULT_DIAGNOSTICS_DIR;
}

function prune(dir) {
    try {
        const groups = new Map();
        for (const f of fs.readdirSync(dir)) {
            const base = f.replace(/\.(html|png|json)$/, "");
            const full = path.join(dir, f);
            const mtime = fs.statSync(full).mtimeMs;
            const g = groups.get(base) ?? { files: [], mtime: 0 };
            g.files.push(full);
            g.mtime = Math.max(g.mtime, mtime);
            groups.set(base, g);
        }
        const sorted = Array.from(groups.values()).sort((a, b) => b.mtime - a.mtime);
        for (const g of sorted.slice(MAX_SNAPSHOT_GROUPS)) {
            for (const f of g.files)
                fs.rmSync(f, { force: true });
        }
    }
    catch {
        // Best-effort
    }
}

/**
 * Save an HTML + screenshot + metadata snapshot of the current page for debugging selector breakage.
 * Snapshots stay local (git-ignored) because they can contain logged-in page content. Never throws.
 */
export async function saveDiagnosticSnapshot(page, label = "snapshot", extra = {}, { env = process.env } = {}) {
    if (!page || page.isClosed?.())
        return null;
    const dir = resolveDiagnosticsDir(env);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "snapshot";
    const base = path.join(dir, `${stamp}-${safeLabel}`);
    const saved = {};
    try {
        fs.mkdirSync(dir, { recursive: true });
        const html = await Promise.race([
            page.content(),
            new Promise((resolve) => setTimeout(() => resolve(null), 4_000)),
        ]).catch(() => null);
        if (typeof html === "string") {
            fs.writeFileSync(`${base}.html`, html.slice(0, MAX_HTML_BYTES), "utf8");
            saved.html = `${base}.html`;
        }
        const png = await page.screenshot({ path: `${base}.png`, timeout: 4_000, animations: "disabled" }).then(() => true).catch(() => false);
        if (png)
            saved.png = `${base}.png`;
        const meta = {
            label: safeLabel,
            savedAt: new Date().toISOString(),
            url: page.url?.() ?? null,
            title: await page.title().catch(() => null),
            ...extra,
        };
        fs.writeFileSync(`${base}.json`, JSON.stringify(meta, null, 2), "utf8");
        saved.json = `${base}.json`;
        prune(dir);
        return saved;
    }
    catch {
        return Object.keys(saved).length > 0 ? saved : null;
    }
}
