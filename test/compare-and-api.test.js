import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { analyzeComparison, compareModels, formatComparison } from "../dist/compare.js";
import { extractClaimsFromCitedText, parseApiResponsePayload, resolveExecutionBackend, runApiSearch } from "../dist/api.js";
import { ErrorCode, PerplexityMcpError } from "../dist/errors.js";

const tmpRoots = [];
after(() => {
    for (const dir of tmpRoots) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("compare.js", () => {
    it("analyzeComparison extracts agreed claims, unique specifics, and shared citations", () => {
        const analysis = analyzeComparison([
            {
                model: "GPT-6.1 Sol",
                ok: true,
                result: {
                    answer: "Node.js v22.11.0 reached Active LTS on October 29, 2024 with 30 months of support.",
                    sources: [
                        { title: "Node Releases", url: "https://nodejs.org/releases" },
                        { title: "GPT Only", url: "https://example.com/gpt" },
                    ],
                },
            },
            {
                model: "Claude Sonnet 5.5",
                ok: true,
                result: {
                    answer: "Node.js v22.11.0 entered LTS on 2024-10-29 and dropped support for 32-bit Windows.",
                    sources: [
                        { title: "Node Releases", url: "https://nodejs.org/releases" },
                    ],
                },
            },
            {
                model: "Gemini 4 Hydrogen",
                ok: false,
                error: { code: "MODEL_UNAVAILABLE", message: "Quota exhausted" },
            },
        ]);

        assert.equal(analysis.totalModels, 3);
        assert.equal(analysis.succeededCount, 2);
        assert.equal(analysis.failedCount, 1);
        assert.ok(analysis.agreedClaims.some((c) => /22\.11\.0/.test(c.text) && c.models.length === 2));
        assert.ok(analysis.agreedClaims.some((c) => /2024|October 29/.test(c.text) && c.models.length === 2));
        assert.ok(analysis.divergentFacts.some((f) => /30 months/.test(f.value) && f.model === "GPT-6.1 Sol"));
        assert.equal(analysis.sharedSources.length, 1);
        assert.equal(analysis.sharedSources[0].url, "https://nodejs.org/releases");
        assert.equal(analysis.totalUniqueSources, 2);
    });

    it("uses sentence-level consensus and ignores isolated ranking tokens", () => {
        const analysis = analyzeComparison([
            {
                model: "GPT-6.1 Sol",
                ok: true,
                result: {
                    answer: "RATING_PERSONAL: 9/10\nRANK_OVERALL: 1 of 5\nOption Best Useful 17. Node 26 removed the legacy _stream_readable module, so dependencies that require it fail at startup. The native addon ABI is 147, so Node 24 binaries must be rebuilt.",
                    sources: [],
                },
            },
            {
                model: "Claude Sonnet 5.5",
                ok: true,
                result: {
                    answer: "RATING_PERSONAL: 8/10\nRANK_OVERALL: 1 of 5\nOption Best Useful 17. Node 26 dropped the legacy _stream_readable module, which breaks dependencies that still require it. The native addon ABI is 147, so Node 24 binaries must be rebuilt.",
                    sources: [],
                },
            },
        ]);

        assert.ok(analysis.agreedClaims.length >= 1);
        assert.ok(analysis.agreedClaims.some((c) => /_stream_readable/.test(c.text) && c.models.length === 2));
        assert.ok(analysis.agreedClaims.every((c) => !/^\s*(Rank|Option|Best|Useful|17)\s*$/i.test(c.text)));
        assert.ok(analysis.divergentFacts.every((f) => f.value !== "17"));
    });

    it("skips Markdown tables and heading fragments in consensus", () => {
        const analysis = analyzeComparison([
            {
                model: "GPT-6.1 Sol",
                ok: true,
                result: {
                    answer: "### What to check\n| ABI | Version | Effect |\n| --- | --- | --- |\n| Node 26 | 147 | Rebuild addons |\nNode 26 uses ABI 147, so Node 24 addons must be rebuilt for compatibility.",
                    sources: [],
                },
            },
            {
                model: "Claude Sonnet 5.5",
                ok: true,
                result: {
                    answer: "### What to check\n| ABI | Version | Effect |\n| --- | --- | --- |\n| Node 26 | 147 | Rebuild addons |\nNode.js 26 uses ABI 147, so native addons built for Node 24 must be rebuilt.",
                    sources: [],
                },
            },
        ]);

        assert.ok(analysis.agreedClaims.length >= 1);
        assert.ok(analysis.agreedClaims.some((c) => /ABI 147/i.test(c.text)));
        assert.ok(analysis.agreedClaims.every((c) => !/\|/.test(c.text)));
        assert.ok(analysis.agreedClaims.every((c) => !/---/.test(c.text)));
    });

    it("compareModels distributes models across pooled browser profiles and survives partial errors", async () => {
        const calls = [];
        const progress = [];
        const comparison = await compareModels(
            {
                query: "Compare Node 22 vs 24",
                models: ["GPT-6.1 Sol", "Claude Sonnet 5.5", "Gemini 4 Hydrogen"],
                sources: ["web", "academic"],
                verifyClaims: true,
                noCache: true,
                onProgress: async (p) => { progress.push(p); },
            },
            {
                getPoolStatusFn: () => [
                    { id: "default", inPool: true },
                    { id: "worker-2", inPool: true },
                ],
                searchWithSourcesFn: async (q, timeout, sources, modelName, _thread, opts) => {
                    calls.push({ q, sources, modelName, opts });
                    if (modelName === "Gemini 4 Hydrogen") {
                        throw new PerplexityMcpError(ErrorCode.MODEL_UNAVAILABLE, "Model excluded", { stage: "select_model" });
                    }
                    return {
                        answer: `Answer from ${modelName} mentioning Node.js v22.11.0 [1].`,
                        sources: [{ index: 1, title: "Node Docs", url: "https://nodejs.org/en" }],
                        claims: [{ index: 1, text: "Node.js v22.11.0 [1]", citations: [1], urls: ["https://nodejs.org/en"], verification: { status: "supported" } }],
                        verificationSummary: { checkedClaims: 1, supported: 1, weak: 0, unverified: 0 },
                        threadUrl: `https://www.perplexity.ai/search/${opts.profile}`,
                        backend: "browser",
                        cached: modelName === "Claude Sonnet 5.5",
                        cacheAgeSeconds: 12,
                        durationMs: 42,
                    };
                },
            }
        );

        assert.deepEqual(
            calls.map((c) => [c.modelName, c.opts.profile, c.opts.verifyClaims, c.opts.noCache]),
            [
                ["GPT-6.1 Sol", "default", true, true],
                ["Claude Sonnet 5.5", "worker-2", true, true],
                ["Gemini 4 Hydrogen", "default", true, true],
            ]
        );
        assert.equal(comparison.parallelSlots, 2);
        assert.equal(comparison.analysis.succeededCount, 2);
        assert.equal(comparison.analysis.failedCount, 1);
        assert.equal(comparison.entries[2].error.code, ErrorCode.MODEL_UNAVAILABLE);
        assert.equal(progress[progress.length - 1].progress, 100);

        // Inline format check
        const inline = formatComparison(comparison, { env: { PERPLEXITY_LONG_OUTPUT_CHARS: "50000" } });
        assert.match(inline, /Multi-Model Comparison \(2\/3 succeeded/);
        assert.match(inline, /FAILED \(MODEL_UNAVAILABLE\)/);
        assert.match(inline, /Agreed Claims/);
        assert.match(inline, /Metadata: \{.*"spooled":false/);

        // Spooled file format check
        const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "pplx-cmp-"));
        tmpRoots.push(tmpOut);
        const target = path.join(tmpOut, "cmp.txt");
        const spooled = formatComparison(comparison, { outputFile: target, env: { PERPLEXITY_LONG_OUTPUT_CHARS: "50000", PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT: "1" } });
        assert.match(spooled, /\[Comparison saved to file\]/);
        assert.match(spooled, /"spooled":true/);
        assert.match(fs.readFileSync(target, "utf8"), /# Perplexity Multi-Model Comparison/);
    });
});

describe("api.js", () => {
    it("resolves backend modes and validates params cleanly", () => {
        assert.equal(resolveExecutionBackend({ backend: "auto", env: {} }), "browser");
        assert.equal(resolveExecutionBackend({ backend: "auto", env: { PERPLEXITY_API_KEY: "pplx-test" } }), "api");
        assert.equal(resolveExecutionBackend({ backend: "auto", threadUrl: "https://www.perplexity.ai/search/x", env: { PERPLEXITY_API_KEY: "pplx-test" } }), "browser");
        assert.throws(() => resolveExecutionBackend({ backend: "api", env: {} }), (e) => e.code === ErrorCode.INVALID_PARAMS);
        assert.throws(() => resolveExecutionBackend({ backend: "api", threadUrl: "https://www.perplexity.ai/search/x", env: { PERPLEXITY_API_KEY: "pplx-test" } }), (e) => e.code === ErrorCode.INVALID_PARAMS);
        assert.throws(() => resolveExecutionBackend({ backend: "bogus", env: {} }), (e) => e.code === ErrorCode.INVALID_PARAMS);
    });

    it("parses Agent API and legacy chat/completions payloads and extractClaimsFromCitedText", () => {
        const claims = extractClaimsFromCitedText("# Heading\n- Node.js v22.11.0 is Active LTS [1, 2].\n```\ncode [1]\n```", [
            { index: 1, url: "https://nodejs.org/1" },
            { index: 2, url: "https://nodejs.org/2" },
        ]);
        assert.equal(claims.length, 1);
        assert.deepEqual(claims[0].citations, [1, 2]);
        assert.deepEqual(claims[0].urls, ["https://nodejs.org/1", "https://nodejs.org/2"]);

        const agentParsed = parseApiResponsePayload({
            model: "sonar-pro",
            output_text: "Node 22 shipped in April 2024 [1].",
            output: [
                { type: "search_results", results: [{ id: 1, title: "Node Blog", url: "https://nodejs.org/en/blog", snippet: "Released Apr 24", date: "2024-04-24" }] },
            ],
        });
        assert.equal(agentParsed.modelUsed, "sonar-pro");
        assert.equal(agentParsed.sources.length, 1);
        assert.equal(agentParsed.claims[0].urls[0], "https://nodejs.org/en/blog");

        const legacyParsed = parseApiResponsePayload({
            model: "sonar",
            choices: [{ message: { content: "Answer [1]." } }],
            citations: ["https://example.com/1"],
        });
        assert.equal(legacyParsed.answer, "Answer [1].");
        assert.equal(legacyParsed.sources[0].url, "https://example.com/1");
    });

    it("runApiSearch handles success, HTTP 429 API_ERROR, and AbortSignal CANCELLED", async () => {
        const res = await runApiSearch("test", 5000, {
            env: { PERPLEXITY_API_KEY: "pplx-key" },
            fetchImpl: async () => new Response(JSON.stringify({ output_text: "OK [1].", output: [{ type: "search_results", results: [{ id: 1, url: "https://example.com" }] }] }), { status: 200 }),
        });
        assert.equal(res.backend, "api");
        assert.equal(res.answer, "OK [1].");

        await assert.rejects(
            () => runApiSearch("test", 5000, {
                env: { PERPLEXITY_API_KEY: "pplx-key" },
                fetchImpl: async () => new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 429 }),
            }),
            (e) => e.code === ErrorCode.API_ERROR && e.recoverable === true
        );

        const ac = new AbortController();
        ac.abort();
        await assert.rejects(
            () => runApiSearch("test", 5000, {
                signal: ac.signal,
                env: { PERPLEXITY_API_KEY: "pplx-key" },
                fetchImpl: async () => { throw new Error("aborted"); },
            }),
            (e) => e.code === ErrorCode.CANCELLED
        );
    });
});
