import { contentWords, extractKeyFacts, factMatches, normalizeText } from "./facts.js";
import { assertPublicHost, BLOCKED_ADDRESS_CODE, parsePublicUrl, safeFetch } from "./net-guard.js";

const DEFAULT_PAGE_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_BUDGET_MS = 25_000;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_MAX_CLAIMS = 25;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "perplexity-web-mcp (claim-verification; +https://github.com/AqsaCloudPk/Perplexity-Web-MCP-)";

const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "..." };

/** Convert HTML into plain visible-ish text (scripts/styles removed, tags stripped, entities decoded). */
export function htmlToText(html) {
    return String(html ?? "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(?:br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    })
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
        const code = Number.parseInt(h, 16);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    })
        .replace(/&([a-z]+);/gi, (m, name) => ENTITY_MAP[name.toLowerCase()] ?? " ")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/\n\s*\n+/g, "\n")
        .trim();
}

async function readBodyLimited(response, maxBytes) {
    if (!response.body || typeof response.body.getReader !== "function") {
        const text = await response.text();
        return text.slice(0, maxBytes);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            chunks.push(value);
            total += value.byteLength;
            if (total >= maxBytes) {
                await reader.cancel().catch(() => { });
                break;
            }
        }
    }
    finally {
        reader.releaseLock?.();
    }
    const buf = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;
    for (const c of chunks) {
        const slice = c.subarray(0, Math.max(0, buf.length - offset));
        buf.set(slice, offset);
        offset += slice.length;
        if (offset >= buf.length)
            break;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/**
 * Fetch a cited page and return normalized plain text, or a structured failure reason.
 *
 * SSRF-hardened: only public http(s) destinations are contacted, redirects are followed manually
 * (max `maxRedirects`) and every hop is re-validated. `lookupImpl` / `fetchImpl` are injectable for tests.
 */
export async function fetchPageText(url, { timeoutMs = DEFAULT_PAGE_TIMEOUT_MS, signal, fetchImpl = safeFetch, lookupImpl, maxRedirects = MAX_REDIRECTS } = {}) {
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const fail = (reason, extra = {}) => ({ url, ok: false, status: null, reason, ms: Date.now() - startedAt, ...extra });
    try {
        let current = url;
        let response;
        for (let hop = 0;; hop++) {
            const parsed = parsePublicUrl(current);
            if (!parsed.ok)
                return fail(parsed.reason);
            if (lookupImpl || fetchImpl === safeFetch) {
                await assertPublicHost(parsed.host, lookupImpl);
            }
            response = await fetchImpl(parsed.url.href, {
                method: "GET",
                redirect: "manual",
                signal: combined,
                headers: {
                    "User-Agent": USER_AGENT,
                    Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
                    "Accept-Language": "en-US,en;q=0.8",
                },
            });
            const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
            if (!location)
                break;
            await response.body?.cancel?.().catch(() => { });
            if (hop >= maxRedirects)
                return fail("too_many_redirects", { status: response.status });
            current = new URL(location, parsed.url).href;
        }
        if (!response.ok) {
            return { url, ok: false, status: response.status, reason: response.status === 403 || response.status === 429 ? "blocked" : "http_error", ms: Date.now() - startedAt };
        }
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (contentType && !/text\/|html|xml|json/.test(contentType)) {
            return { url, ok: false, status: response.status, reason: "unsupported_content_type", contentType, ms: Date.now() - startedAt };
        }
        const raw = await readBodyLimited(response, MAX_BODY_BYTES);
        const text = /html|xml/.test(contentType) || /<html|<body|<div/i.test(raw.slice(0, 2000)) ? htmlToText(raw) : raw;
        const normalized = normalizeText(text);
        if (normalized.length < 200) {
            return { url, ok: false, status: response.status, reason: "empty_or_js_rendered", ms: Date.now() - startedAt };
        }
        return { url, ok: true, status: response.status, text: normalized, chars: normalized.length, ms: Date.now() - startedAt };
    }
    catch (err) {
        const aborted = signal?.aborted;
        if (err?.code === BLOCKED_ADDRESS_CODE)
            return fail("blocked_address");
        return fail(aborted ? "cancelled" : (timeoutSignal.aborted || err?.name === "TimeoutError" ? "timeout" : "network_error"));
    }
}

async function runLimited(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const idx = next++;
            results[idx] = await worker(items[idx], idx);
        }
    });
    await Promise.all(runners);
    return results;
}

/** Classify a single claim against the already-fetched page texts it cites. */
export function classifyClaim(claim, pageResults) {
    const urls = Array.isArray(claim?.urls) ? claim.urls : [];
    const checked = urls.map((u) => pageResults.get(u)).filter(Boolean);
    const loaded = checked.filter((p) => p.ok);
    const facts = extractKeyFacts(claim?.text ?? "");

    if (urls.length === 0) {
        return { status: "unverified", reason: "no_citation", facts: facts.map((f) => f.value), matchedFacts: [], missingFacts: facts.map((f) => f.value), checkedUrls: [] };
    }
    if (checked.length === 0) {
        return { status: "unverified", reason: "not_checked", facts: facts.map((f) => f.value), matchedFacts: [], missingFacts: facts.map((f) => f.value), checkedUrls: [] };
    }
    if (loaded.length === 0) {
        const reasons = Array.from(new Set(checked.map((p) => p.reason)));
        return { status: "unverified", reason: `source_unreachable:${reasons.join(",")}`, facts: facts.map((f) => f.value), matchedFacts: [], missingFacts: facts.map((f) => f.value), checkedUrls: checked.map((p) => p.url) };
    }

    if (facts.length === 0) {
        const words = contentWords(claim?.text ?? "");
        if (words.length === 0) {
            return { status: "unverified", reason: "no_checkable_facts", facts: [], matchedFacts: [], missingFacts: [], checkedUrls: loaded.map((p) => p.url) };
        }
        const found = words.filter((w) => loaded.some((p) => p.text.includes(w)));
        const ratio = found.length / words.length;
        const status = ratio >= 0.7 ? "supported" : ratio >= 0.4 ? "weak" : "unverified";
        return { status, reason: "keyword_overlap", overlap: Number(ratio.toFixed(2)), facts: [], matchedFacts: found, missingFacts: words.filter((w) => !found.includes(w)), checkedUrls: loaded.map((p) => p.url) };
    }

    const matched = [];
    const missing = [];
    for (const fact of facts) {
        if (loaded.some((p) => factMatches(fact, p.text)))
            matched.push(fact.value);
        else
            missing.push(fact.value);
    }
    const ratio = matched.length / facts.length;
    // Dates/numbers/versions are the most checkable signal; missing ones weigh heavier than missing names.
    const missingHard = facts.filter((f) => missing.includes(f.value) && f.type !== "name").length;
    let status;
    if (ratio >= 0.999 || (ratio >= 0.8 && missingHard === 0))
        status = "supported";
    else if (ratio >= 0.4)
        status = "weak";
    else
        status = "unverified";
    return {
        status,
        reason: status === "supported" ? "facts_found" : status === "weak" ? "partial_match" : "facts_not_found",
        facts: facts.map((f) => f.value),
        matchedFacts: matched,
        missingFacts: missing,
        checkedUrls: loaded.map((p) => p.url),
    };
}

/**
 * Verify claim-level citations by fetching cited pages and checking each claim's key facts.
 * Returns annotated claims plus a summary; never throws (failures become "unverified").
 */
export async function verifyClaims(claims, { maxClaims = DEFAULT_MAX_CLAIMS, maxPages = DEFAULT_MAX_PAGES, pageTimeoutMs = DEFAULT_PAGE_TIMEOUT_MS, totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS, concurrency = 4, signal, fetchImpl = safeFetch, lookupImpl, onProgress } = {}) {
    const startedAt = Date.now();
    const list = Array.isArray(claims) ? claims.slice(0, maxClaims) : [];
    const urlFreq = new Map();
    for (const c of list) {
        for (const u of c?.urls ?? []) {
            urlFreq.set(u, (urlFreq.get(u) ?? 0) + 1);
        }
    }
    const urls = Array.from(urlFreq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxPages)
        .map(([u]) => u);

    if (onProgress && urls.length > 0) {
        await onProgress({ progress: 97, total: 100, message: `Verifying ${list.length} claims against ${urls.length} cited pages...` }).catch(() => { });
    }

    const budgetSignal = AbortSignal.timeout(totalBudgetMs);
    const combined = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
    const fetched = await runLimited(urls, concurrency, (u) => fetchPageText(u, { timeoutMs: pageTimeoutMs, signal: combined, fetchImpl, lookupImpl }));
    const pageResults = new Map(fetched.map((p) => [p.url, p]));

    const annotated = (Array.isArray(claims) ? claims : []).map((c, idx) => {
        if (idx >= maxClaims) {
            return { ...c, verification: { status: "unverified", reason: "claim_limit", matchedFacts: [], missingFacts: [], checkedUrls: [] } };
        }
        return { ...c, verification: classifyClaim(c, pageResults) };
    });

    const counts = { supported: 0, weak: 0, unverified: 0 };
    for (const c of annotated)
        counts[c.verification.status] = (counts[c.verification.status] ?? 0) + 1;

    return {
        claims: annotated,
        summary: {
            checkedClaims: annotated.length,
            ...counts,
            pagesChecked: fetched.length,
            pagesLoaded: fetched.filter((p) => p.ok).length,
            pageFailures: fetched.filter((p) => !p.ok).map((p) => ({ url: p.url, reason: p.reason, status: p.status })),
            durationMs: Date.now() - startedAt,
        },
    };
}

/** Resolve whether claim verification should run by default (PERPLEXITY_VERIFY_CLAIMS=1). */
export function resolveVerifyDefault(env = process.env) {
    return /^(1|true|yes|on)$/i.test(String(env?.PERPLEXITY_VERIFY_CLAIMS ?? "").trim());
}
