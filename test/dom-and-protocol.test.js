import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runWithProfileSlot } from "../dist/browser.js";
import { buildCacheKey, setCachedResult } from "../dist/cache.js";
import { ErrorCode, normalizeError, PerplexityMcpError } from "../dist/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");

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

describe("errors.js", () => {
    it("formats PerplexityMcpError as typed MCP tool error JSON", () => {
        const err = new PerplexityMcpError(ErrorCode.TIMEOUT, "Timed out waiting", {
            stage: "wait_answer",
            profile: "default",
            threadUrl: "https://www.perplexity.ai/search/abc",
            checkpointFile: "/tmp/out-partial.txt",
            partialChars: 1200,
        });
        const res = err.toToolErrorResult();
        assert.equal(res.isError, true);
        const parsed = JSON.parse(res.content[0].text);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.error.code, "TIMEOUT");
        assert.equal(parsed.error.partialChars, 1200);
        assert.equal(parsed.error.checkpointFile, "/tmp/out-partial.txt");
    });

    it("normalizeError maps common runtime messages to typed codes", () => {
        assert.equal(normalizeError(new Error("Request timed out after 30s")).code, ErrorCode.TIMEOUT);
        assert.equal(normalizeError(new Error("Operation aborted by signal")).code, ErrorCode.CANCELLED);
        assert.equal(normalizeError(new Error("Cloudflare turnstile challenge")).code, ErrorCode.CLOUDFLARE_CHALLENGE);
        assert.equal(normalizeError(new Error("Not authenticated — please sign in")).code, ErrorCode.LOGIN_REQUIRED);
        assert.equal(normalizeError(new Error("Model Foo not found in available models")).code, ErrorCode.MODEL_UNAVAILABLE);
        assert.equal(normalizeError(new Error("Invalid thread_url host")).code, ErrorCode.INVALID_PARAMS);
        assert.equal(normalizeError(new Error("Waiting for selector #ask-input failed")).code, ErrorCode.SELECTOR_MISSING);
        assert.equal(normalizeError(new Error("Unexpected crash")).code, ErrorCode.INTERNAL_ERROR);
    });
});

describe("browser.js concurrency & queue cancellation", () => {
    it("runs separate named profile slots in parallel and cancels queued waiter via AbortSignal", async () => {
        const p1 = path.join(makeTmpDir("pplx-slot-"), "prof-a");
        const p2 = path.join(makeTmpDir("pplx-slot-"), "prof-b");
        const active = [];
        let maxConcurrent = 0;

        await Promise.all([
            runWithProfileSlot({ profile: p1 }, async () => {
                active.push("a");
                maxConcurrent = Math.max(maxConcurrent, active.length);
                await new Promise((r) => setTimeout(r, 80));
                active.pop();
            }),
            runWithProfileSlot({ profile: p2 }, async () => {
                active.push("b");
                maxConcurrent = Math.max(maxConcurrent, active.length);
                await new Promise((r) => setTimeout(r, 80));
                active.pop();
            }),
        ]);
        assert.equal(maxConcurrent, 2);

        const releaseFirst = {};
        const blocker = new Promise((r) => { releaseFirst.resolve = r; });
        const firstTask = runWithProfileSlot({ profile: p1 }, async () => {
            await blocker;
            return "first";
        });

        const ac = new AbortController();
        const queuedCancelled = runWithProfileSlot({ profile: p1, signal: ac.signal }, async () => "should-not-run");
        setTimeout(() => ac.abort(), 20);

        await assert.rejects(queuedCancelled, (e) => e.code === ErrorCode.CANCELLED && e.stage === "queue");

        const thirdTask = runWithProfileSlot({ profile: p1 }, async () => "third");
        releaseFirst.resolve();
        assert.equal(await firstTask, "first");
        assert.equal(await thirdTask, "third");
    });
});

describe("Headless DOM & virtualized-thread / citation behaviors", () => {
    it("detects virtualized follow-up turn even when DOM .prose count remains 2", async () => {
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            await page.setContent(`
                <main>
                    <div class="prose">Earlier answer turn 5 with plenty of content.</div>
                    <div class="prose">Earlier answer turn 6 with detailed prose tail signature.</div>
                </main>
            `);

            // Simulate pre-submit baseline snapshot (matching getTurnCounts logic)
            const baseline = await page.evaluate(() => {
                const panels = Array.from(document.querySelectorAll(".prose"));
                for (const el of panels)
                    el.setAttribute("data-mcp-old-prose", "1");
                const last = panels[panels.length - 1];
                const t = (last?.innerText || "").replace(/\s+/g, " ").trim();
                return {
                    proseCount: panels.length,
                    lastProseSig: `${t.length}:${t.slice(0, 80)}::${t.slice(-80)}`,
                };
            });
            assert.equal(baseline.proseCount, 2);

            // Simulate virtualized follow-up: top turn unmounted, turn 6 kept, new turn 7 mounted -> still 2 .prose nodes!
            await page.evaluate(() => {
                const main = document.querySelector("main");
                main.children[0].remove();
                const turn7 = document.createElement("div");
                turn7.className = "prose";
                turn7.innerHTML = `<p>New answer turn 7 with <a data-pplx-citation-url="https://nodejs.org/en/releases"><span>1</span></a> citation.</p>`;
                main.appendChild(turn7);
            });

            const afterFollowUp = await page.evaluate((baseSig) => {
                const panels = Array.from(document.querySelectorAll(".prose"));
                const unmarkedCount = panels.filter((el) => el.getAttribute("data-mcp-old-prose") !== "1").length;
                const last = panels[panels.length - 1];
                const t = (last?.innerText || "").replace(/\s+/g, " ").trim();
                const lastSig = `${t.length}:${t.slice(0, 80)}::${t.slice(-80)}`;
                const citation = last?.querySelector("[data-pplx-citation-url]");
                return {
                    proseCount: panels.length,
                    unmarkedCount,
                    tailChanged: lastSig !== baseSig,
                    citationUrl: citation?.getAttribute("data-pplx-citation-url") || null,
                };
            }, baseline.lastProseSig);

            assert.equal(afterFollowUp.proseCount, 2);
            assert.equal(afterFollowUp.unmarkedCount, 1);
            assert.equal(afterFollowUp.tailChanged, true);
            assert.equal(afterFollowUp.citationUrl, "https://nodejs.org/en/releases");
        }
        finally {
            await browser.close();
        }
    });
});

describe("Stdio MCP protocol integration", () => {
    it("exposes all 7 v1.4.0 tools, validates inputs, and serves cached search results cleanly", async () => {
        const tmpCacheDir = makeTmpDir("pplx-mcp-cache-");
        const tmpProfileDir = makeTmpDir("pplx-mcp-prof-");
        const query = "mcp stdio cache integration check";
        const key = buildCacheKey({ backend: "browser", model: "", sources: null, query });
        setCachedResult(
            key,
            {
                answer: "Cached MCP response confirming Node.js v22.11.0 [1].",
                sources: [{ index: 1, title: "Node Releases", url: "https://nodejs.org/en/about/previous-releases", domain: "nodejs.org" }],
                claims: [{ index: 1, text: "Cached MCP response confirming Node.js v22.11.0 [1].", citations: [1], urls: ["https://nodejs.org/en/about/previous-releases"] }],
                attachments: [],
                threadUrl: "https://www.perplexity.ai/search/mock-cached",
                profile: "default",
                backend: "browser",
                turnCount: 1,
                virtualizedThread: false,
                partial: false,
                timedOut: false,
            },
            { env: { PERPLEXITY_CACHE_DIR: tmpCacheDir, PERPLEXITY_CACHE_TTL_SECONDS: "3600" } }
        );

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [SERVER_ENTRY],
            cwd: PROJECT_ROOT,
            env: {
                ...process.env,
                PERPLEXITY_API_KEY: "",
                PERPLEXITY_PROFILE_DIR: tmpProfileDir,
                PERPLEXITY_CACHE_DIR: tmpCacheDir,
                PERPLEXITY_CACHE_TTL_SECONDS: "3600",
                PERPLEXITY_VERIFY_CLAIMS: "0",
            },
        });
        const client = new Client({ name: "perplexity-test-client", version: "1.4.0" });
        await client.connect(transport);
        try {
            const listed = await client.listTools();
            const names = listed.tools.map((t) => t.name).sort();
            assert.deepEqual(names, [
                "compare_models",
                "health_check",
                "list_models",
                "login",
                "search",
                "search_advanced",
                "set_default_model",
            ]);

            const searchTool = listed.tools.find((t) => t.name === "search");
            const advTool = listed.tools.find((t) => t.name === "search_advanced");
            assert.ok("verify_claims" in (searchTool.inputSchema?.properties ?? {}));
            assert.ok("no_cache" in (searchTool.inputSchema?.properties ?? {}));
            assert.ok("verify_claims" in (advTool.inputSchema?.properties ?? {}));
            assert.ok("no_cache" in (advTool.inputSchema?.properties ?? {}));

            // backend="api" without PERPLEXITY_API_KEY returns typed INVALID_PARAMS
            const apiErrRes = await client.callTool({ name: "search", arguments: { query: "ping", backend: "api" } });
            assert.equal(apiErrRes.isError, true);
            const parsedErr = JSON.parse(apiErrRes.content[0].text);
            assert.equal(parsedErr.error.code, ErrorCode.INVALID_PARAMS);

            // compare_models rejects < 2 models via Zod schema validation
            const cmpSchemaErr = await client.callTool({ name: "compare_models", arguments: { query: "ping", models: ["SingleModel"] } });
            assert.equal(cmpSchemaErr.isError, true);

            // Cached search hit succeeds cleanly through stdio MCP without launching Chromium
            const cachedRes = await client.callTool({ name: "search", arguments: { query } });
            assert.notEqual(cachedRes.isError, true);
            const text = cachedRes.content[0].text;
            assert.match(text, /Cached MCP response confirming Node\.js v22\.11\.0/);
            assert.match(text, /\[Cached result \(\d+s old\)/);
            assert.match(text, /"cached":true/);
        }
        finally {
            await client.close();
        }
    });
});
