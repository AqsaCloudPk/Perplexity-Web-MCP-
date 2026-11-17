import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { chromium } from "playwright";
import { buildCacheKey, getCachedResult, resolveCacheTtlSeconds, setCachedResult } from "../dist/cache.js";
import { saveDiagnosticSnapshot } from "../dist/diagnostics.js";
import { buildResultMetadata, formatResult, removeCheckpoint, writeCheckpoint, writeTextOutputFile } from "../dist/output.js";

const tmpRoots = [];
function makeTmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
}

after(() => {
    for (const dir of tmpRoots) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("cache.js", () => {
    it("resolves TTL defaults and overrides", () => {
        assert.equal(resolveCacheTtlSeconds({}), 3600);
        assert.equal(resolveCacheTtlSeconds({ PERPLEXITY_CACHE_TTL_SECONDS: "0" }), 0);
        assert.equal(resolveCacheTtlSeconds({ PERPLEXITY_CACHE_TTL_SECONDS: "120" }), 120);
        assert.equal(resolveCacheTtlSeconds({ PERPLEXITY_CACHE_TTL_SECONDS: "bad" }), 3600);
    });

    it("normalizes cache keys across whitespace, case, and sorted sources", () => {
        const k1 = buildCacheKey({ backend: "BROWSER", model: "  Sonar ", sources: ["academic", "web"], query: "  What  is  MCP? " });
        const k2 = buildCacheKey({ backend: "browser", model: "sonar", sources: ["web", "academic"], query: "what is mcp?" });
        const k3 = buildCacheKey({ backend: "browser", model: "sonar", sources: ["web"], query: "what is mcp?" });
        assert.equal(k1, k2);
        assert.notEqual(k1, k3);
    });

    it("stores, reads, expires by TTL, and skips partial/timedOut results", () => {
        const cacheDir = makeTmpDir("pplx-cache-");
        const env = { PERPLEXITY_CACHE_DIR: cacheDir, PERPLEXITY_CACHE_TTL_SECONDS: "60" };
        const key = buildCacheKey({ model: "Sonar", query: "Node 22 LTS date" });

        assert.equal(setCachedResult(key, { answer: "partial", partial: true }, { env }), false);
        assert.equal(setCachedResult(key, { answer: "timed out", timedOut: true }, { env }), false);

        const now = 1_700_000_000_000;
        const okStored = setCachedResult(
            key,
            { answer: "October 29, 2024 [1].", sources: [], claims: [], cached: true, cacheAgeSeconds: 99 },
            { env, ttlSeconds: 60, now }
        );
        assert.equal(okStored, true);

        const hit = getCachedResult(key, 60, { env, now: now + 15_000 });
        assert.ok(hit);
        assert.equal(hit.ageSeconds, 15);
        assert.equal(hit.result.answer, "October 29, 2024 [1].");
        assert.equal(hit.result.cached, undefined);

        const expired = getCachedResult(key, 60, { env, now: now + 61_000 });
        assert.equal(expired, null);
        assert.equal(fs.existsSync(path.join(cacheDir, `${key}.json`)), false);
    });
});

describe("diagnostics.js", () => {
    it("captures .html, .png, and .json snapshot in headless Chromium", async () => {
        const diagDir = makeTmpDir("pplx-diag-");
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
            await page.setContent("<html><head><title>Selector Test</title></head><body><main>Diagnostic body</main></body></html>");
            const saved = await saveDiagnosticSnapshot(page, "composer_missing", { selector: "#ask-input", attempt: 2 }, { env: { PERPLEXITY_DIAGNOSTICS_DIR: diagDir } });
            assert.ok(saved?.html && fs.existsSync(saved.html));
            assert.ok(saved?.png && fs.existsSync(saved.png));
            assert.ok(saved?.json && fs.existsSync(saved.json));
            const meta = JSON.parse(fs.readFileSync(saved.json, "utf8"));
            assert.equal(meta.label, "composer_missing");
            assert.equal(meta.title, "Selector Test");
            assert.equal(meta.selector, "#ask-input");
            assert.match(fs.readFileSync(saved.html, "utf8"), /Diagnostic body/);
        }
        finally {
            await browser.close();
        }
    });
});

describe("output.js", () => {
    it("formats verification badges, virtualized metadata, cached notice, and auto-spools long outputs", () => {
        const outDir = makeTmpDir("pplx-out-");
        const env = { PERPLEXITY_OUTPUT_DIR: outDir, PERPLEXITY_LONG_OUTPUT_CHARS: "200" };
        const result = {
            answer: "Node.js v22.11.0 entered Active LTS on October 29, 2024 [1]. " + "More technical details. ".repeat(12),
            sources: [{ index: 1, title: "Node Release Schedule", url: "https://nodejs.org/en/about/previous-releases", domain: "nodejs.org" }],
            claims: [
                {
                    index: 1,
                    text: "Node.js v22.11.0 entered Active LTS on October 29, 2024 [1].",
                    citations: [1],
                    urls: ["https://nodejs.org/en/about/previous-releases"],
                    verification: { status: "supported", matchedFacts: ["October 29, 2024", "22.11.0"], missingFacts: [] },
                },
            ],
            verificationSummary: { checkedClaims: 1, supported: 1, weak: 0, unverified: 0, pagesChecked: 1, pagesLoaded: 1 },
            turnCount: 8,
            virtualizedThread: true,
            cached: true,
            cacheAgeSeconds: 42,
            threadUrl: "https://www.perplexity.ai/search/test",
            profile: "default",
            backend: "browser",
            partial: false,
            timedOut: false,
        };

        const meta = buildResultMetadata(result, { model: "Sonar", spooled: true, outputFile: path.join(outDir, "sample.txt") });
        assert.equal(meta.turnCount, 8);
        assert.equal(meta.virtualizedThread, true);
        assert.equal(meta.cached, true);
        assert.equal(meta.cacheAgeSeconds, 42);
        assert.equal(meta.verification.supported, 1);

        const formatted = formatResult(result, { query: "Node 22 LTS", model: "Sonar", env });
        assert.match(formatted, /\[Long output saved to file/);
        assert.match(formatted, /\[Cached result \(42s old\)/);
        assert.match(formatted, /"virtualizedThread":true/);

        const fileMatch = formatted.match(/^File:\s*(.+)$/m);
        assert.ok(fileMatch);
        const spooledContent = fs.readFileSync(fileMatch[1].trim(), "utf8");
        assert.match(spooledContent, /Node\.js v22\.11\.0 entered Active LTS/);
        assert.match(spooledContent, /\| supported \| \[1\] \|/);
        assert.match(spooledContent, /Verification: supported=1, weak=0, unverified=0 \(pages=1\/1\)/);
    });

    it("includes the claim/verdict/source table inline even with more than 12 claims", () => {
        const claims = Array.from({ length: 17 }, (_, i) => ({
            index: i + 1,
            text: `Claim ${i + 1}: Node 26 changed behavior for native modules [1].`,
            citations: [1],
            urls: ["https://nodejs.org/en"],
            verification: {
                status: i % 3 === 0 ? "supported" : i % 3 === 1 ? "weak" : "unverified",
                reason: i % 3 === 0 ? "facts_found" : "partial_match",
            },
        }));
        const result = {
            answer: "Short answer [1].",
            sources: [{ index: 1, title: "Node", url: "https://nodejs.org/en" }],
            claims,
            verificationSummary: {
                checkedClaims: 17,
                supported: 6,
                weak: 6,
                unverified: 5,
                pagesChecked: 1,
                pagesLoaded: 1,
                durationMs: 42,
            },
            profile: "default",
            backend: "browser",
        };

        const formatted = formatResult(result, { query: "claims", env: { PERPLEXITY_LONG_OUTPUT_CHARS: "50000" } });
        assert.match(formatted, /Claim Verification:/);
        assert.match(formatted, /Verification: supported=6, weak=6, unverified=5/);
        assert.match(formatted, /\| # \| Claim \| Verdict \| Sources \|/);
        assert.match(formatted, /Claim 17: Node 26 changed behavior/);
        assert.match(formatted, /\| supported \| \[1\] \|/);
        assert.match(formatted, /\| weak \(partial_match\) \| \[1\] \|/);
        assert.match(formatted, /\| unverified \(partial_match\) \| \[1\] \|/);
    });

    it("flattens Markdown table rows inside claim cells", () => {
        const result = {
            answer: "Short answer [1].",
            sources: [{ index: 1, title: "Node", url: "https://nodejs.org/en" }],
            claims: [{
                index: 1,
                text: "| Node 26 | 147 | Rebuild addons |",
                citations: [1],
                urls: ["https://nodejs.org/en"],
                verification: { status: "supported" },
            }],
            verificationSummary: { checkedClaims: 1, supported: 1, weak: 0, unverified: 0, pagesChecked: 1, pagesLoaded: 1 },
            profile: "default",
            backend: "browser",
        };

        const formatted = formatResult(result, { query: "table", env: { PERPLEXITY_LONG_OUTPUT_CHARS: "50000" } });
        assert.match(formatted, /Node 26; 147; Rebuild addons/);
        assert.ok(!formatted.includes("\\|"));
    });

    it("writes and removes partial checkpoints cleanly", () => {
        const outDir = makeTmpDir("pplx-ckpt-");
        const env = { PERPLEXITY_OUTPUT_DIR: outDir };
        const ckpt = writeCheckpoint({ answer: "Partial stream...", sources: [], claims: [], partial: true, timedOut: false, backend: "browser" }, { query: "checkpoint test", env });
        assert.ok(ckpt && fs.existsSync(ckpt));
        assert.match(ckpt, /-partial\.txt$/);
        removeCheckpoint(ckpt);
        assert.equal(fs.existsSync(ckpt), false);

        const direct = writeTextOutputFile({ fullDocument: "hello world", query: "direct", outputFile: path.join(outDir, "explicit.txt"), env });
        assert.equal(direct.ok, true);
        assert.equal(fs.readFileSync(direct.targetPath, "utf8"), "hello world");
    });
});
