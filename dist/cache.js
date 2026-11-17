import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";

export const DEFAULT_CACHE_DIR = dataPath("cache");
export const DEFAULT_CACHE_TTL_SECONDS = 3600;
const MAX_CACHE_ENTRIES = 300;

/** Cache TTL in seconds from PERPLEXITY_CACHE_TTL_SECONDS (0 disables caching). */
export function resolveCacheTtlSeconds(env = process.env) {
    const raw = env?.PERPLEXITY_CACHE_TTL_SECONDS;
    if (raw === undefined || String(raw).trim() === "")
        return DEFAULT_CACHE_TTL_SECONDS;
    const n = Number.parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_TTL_SECONDS;
}

export function resolveCacheDir(env = process.env) {
    const custom = env?.PERPLEXITY_CACHE_DIR;
    return custom && String(custom).trim() ? path.resolve(String(custom).trim()) : DEFAULT_CACHE_DIR;
}

/** Stable cache key for backend + model + sources + normalized query. */
export function buildCacheKey({ backend = "browser", model = "", sources = null, query = "" } = {}) {
    const normalized = {
        backend: String(backend || "browser").toLowerCase(),
        model: String(model || "(default)").trim().toLowerCase(),
        sources: Array.isArray(sources) ? [...sources].map((s) => String(s).toLowerCase()).sort() : [],
        query: String(query ?? "").replace(/\s+/g, " ").trim().toLowerCase(),
    };
    return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 40);
}

/** Return a cached result if present and younger than ttlSeconds, otherwise null. */
export function getCachedResult(key, ttlSeconds, { env = process.env, now = Date.now() } = {}) {
    if (!key || !(ttlSeconds > 0))
        return null;
    const file = path.join(resolveCacheDir(env), `${key}.json`);
    try {
        if (!fs.existsSync(file))
            return null;
        const entry = JSON.parse(fs.readFileSync(file, "utf8"));
        const ageMs = now - Number(entry?.storedAt ?? 0);
        if (!entry?.result || !(ageMs >= 0) || ageMs > ttlSeconds * 1000) {
            fs.rmSync(file, { force: true });
            return null;
        }
        return { result: entry.result, ageSeconds: Math.round(ageMs / 1000) };
    }
    catch {
        return null;
    }
}

function pruneCache(dir, ttlSeconds, now) {
    try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
            const full = path.join(dir, f);
            return { full, mtime: fs.statSync(full).mtimeMs };
        });
        for (const f of files) {
            if (ttlSeconds > 0 && now - f.mtime > ttlSeconds * 1000)
                fs.rmSync(f.full, { force: true });
        }
        const remaining = files.filter((f) => fs.existsSync(f.full)).sort((a, b) => b.mtime - a.mtime);
        for (const f of remaining.slice(MAX_CACHE_ENTRIES))
            fs.rmSync(f.full, { force: true });
    }
    catch {
        // Best-effort pruning
    }
}

/** Store a completed (non-partial) result. Never throws. */
export function setCachedResult(key, result, { env = process.env, ttlSeconds = resolveCacheTtlSeconds(env), now = Date.now() } = {}) {
    if (!key || !result?.answer || result.partial || result.timedOut || !(ttlSeconds > 0))
        return false;
    const dir = resolveCacheDir(env);
    try {
        fs.mkdirSync(dir, { recursive: true });
        const { cached, cacheAgeSeconds, ...clean } = result;
        fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ storedAt: now, result: clean }), "utf8");
        pruneCache(dir, ttlSeconds, now);
        return true;
    }
    catch {
        return false;
    }
}
