#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import { z } from "zod";
import { ensureAuthenticated } from "./auth.js";
import { closeBrowser, ensurePoolInitialized, getPoolStatus } from "./browser.js";
import { resolveCacheTtlSeconds } from "./cache.js";
import { compareModels, DEFAULT_COMPARE_MODELS, formatComparison } from "./compare.js";
import { normalizeError } from "./errors.js";
import { formatResult } from "./output.js";
import { search, searchWithSources, listModels, setDefaultModel, healthCheck, DEFAULT_TIMEOUT_MS } from "./search.js";
import { resolveVerifyDefault } from "./verify.js";

const PKG_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
})();

// --- CLI args ---
const args = process.argv.slice(2);
const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const parsedTimeoutSec = timeoutArg ? Number.parseInt(timeoutArg.split("=")[1], 10) : NaN;
const TIMEOUT_MS = Number.isFinite(parsedTimeoutSec) && parsedTimeoutSec > 0
    ? parsedTimeoutSec * 1000
    : DEFAULT_TIMEOUT_MS;
const resolveTimeoutMs = (timeoutSeconds) => (timeoutSeconds ? timeoutSeconds * 1000 : TIMEOUT_MS);

// --- Shared Zod schemas ---
const timeoutSecondsSchema = z
    .number()
    .int()
    .positive()
    .max(1800)
    .optional()
    .describe("Optional timeout in seconds for waiting on the answer (defaults to server timeout, 900s / 15 minutes; max 1800s for very large code or multi-part responses).");

const outputFileSchema = z
    .string()
    .optional()
    .describe("Optional .txt file path to save the full answer to (regardless of length). Relative paths resolve inside the server's outputs directory. When omitted, answers at or above 15000 chars (configurable via PERPLEXITY_LONG_OUTPUT_CHARS) are automatically saved to a .txt file with an inline preview and path.");

const profileSchema = z
    .string()
    .optional()
    .describe("Optional browser profile name or directory path for isolated/concurrent execution (e.g. 'default', 'worker-2'). When omitted, automatically routes to an idle slot in PERPLEXITY_PROFILE_DIRS / default profile.");

const backendSchema = z
    .enum(["auto", "browser", "api"])
    .optional()
    .describe("Execution backend: 'auto' (uses official Perplexity Agent API if PERPLEXITY_API_KEY is configured and thread_url is omitted, otherwise browser Pro session), 'browser' (Playwright Pro UI), or 'api' (official HTTPS Agent API).");

const verifyClaimsSchema = z
    .boolean()
    .optional()
    .describe("If true (or PERPLEXITY_VERIFY_CLAIMS=1), fetches cited pages and checks key facts (numbers, dates, versions, names) for each claim, marking supported / weak / unverified.");

const noCacheSchema = z
    .boolean()
    .optional()
    .describe("If true, bypasses the local response cache (default TTL 3600s, configurable via PERPLEXITY_CACHE_TTL_SECONDS) and forces a fresh search.");

function createProgressReporter(extra) {
    const progressToken = extra?._meta?.progressToken;
    if (progressToken === undefined || progressToken === null || typeof extra?.sendNotification !== "function") {
        return undefined;
    }
    return async ({ progress, total = 100, message }) => {
        try {
            await extra.sendNotification({
                method: "notifications/progress",
                params: {
                    progressToken,
                    progress,
                    total,
                    ...(message ? { message } : {}),
                },
            });
        }
        catch {
            // Best-effort notification
        }
    };
}

function wrapTool(stage, handler) {
    return async (toolArgs, extra) => {
        try {
            return await handler(toolArgs ?? {}, extra);
        }
        catch (err) {
            return normalizeError(err, stage).toToolErrorResult();
        }
    };
}

function textResult(text) {
    return { content: [{ type: "text", text }] };
}

// --- MCP server ---
ensurePoolInitialized();

const server = new McpServer({
    name: "perplexity-web",
    version: PKG_VERSION,
});

// --- MCP Prompts ---
server.prompt(
    "research",
    "Research a topic via Perplexity and return a summary with cited sources.",
    { query: z.string().describe("The research question or topic") },
    ({ query }) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `Use the perplexity-web "search" tool to research the following topic. Include all cited sources in your answer.\n\nQuery: ${query}`,
            },
        }],
    })
);

server.prompt(
    "regression_research",
    "Compare answers from multiple Perplexity AI models to find consensus and divergence on a topic.",
    { query: z.string().describe("The question to compare across models") },
    ({ query }) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `Use the perplexity-web "compare_models" tool with verify_claims: true to compare answers across models for the following question. Highlight agreed facts, single-model specifics, and any unverified claims.\n\nQuery: ${query}`,
            },
        }],
    })
);

server.registerTool(
    "list_models",
    {
        title: "List Perplexity Models",
        description: "List the AI models available on your Perplexity.ai account (excluding unavailable Max-tier models), active and saved default model, and configured browser profile pool status.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        inputSchema: {
            profile: profileSchema,
        },
    },
    wrapTool("list_models", async ({ profile }, extra) => {
        const { profile: usedProfile, currentModel, defaultModel, models } = await listModels({
            profile,
            signal: extra?.signal,
        });
        const lines = models.map((m) => {
            const isDefault = defaultModel && m.name.toLowerCase() === defaultModel.toLowerCase();
            const tags = [
                m.selected ? "selected" : "",
                isDefault ? "default" : "",
                m.disabled ? "disabled/upgrade required" : "",
                m.notes || "",
            ].filter(Boolean);
            return `- ${m.name}${tags.length ? ` [${tags.join(" | ")}]` : ""}`;
        });
        const pool = getPoolStatus();
        const poolLines = pool.map((p) => `- ${p.id}${p.inPool ? " [pool]" : ""}: active=${p.active}, busy=${p.busy}, queued=${p.queued}, initialized=${p.exists}`);
        const meta = {
            ok: true,
            profile: usedProfile,
            currentModel,
            defaultModel,
            modelCount: models.length,
            pool,
        };
        return textResult(
            `Profile: ${usedProfile}\nCurrent button: ${currentModel}\nSaved default: ${defaultModel ?? "(none — uses current Perplexity selection)"}\n\nModels:\n${lines.join("\n")}\n\nProfile pool:\n${poolLines.join("\n")}\n\nMetadata: ${JSON.stringify(meta)}`
        );
    })
);

server.registerTool(
    "set_default_model",
    {
        title: "Set Default Model",
        description: "Set or clear your sticky default Perplexity model (persisted locally). Used automatically by search/search_advanced whenever no model argument is passed.",
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        inputSchema: {
            model: z.string().describe("Model name to set as default (e.g. 'GPT-6.1 Sol', 'Grok 4.7', 'Claude Sonnet 5.5', 'Best'), or 'none' to clear."),
            profile: profileSchema,
        },
    },
    wrapTool("set_default_model", async ({ model, profile }, extra) => {
        const result = await setDefaultModel(model, { profile, signal: extra?.signal });
        if (!result.defaultModel) {
            return textResult(`Cleared saved default model.\n\nMetadata: ${JSON.stringify({ ok: true, defaultModel: null, profile: result.profile })}`);
        }
        return textResult(`Saved default Perplexity model set to "${result.defaultModel}" (verified on profile "${result.profile}").\n\nMetadata: ${JSON.stringify({ ok: true, defaultModel: result.defaultModel, profile: result.profile })}`);
    })
);

server.registerTool(
    "search",
    {
        title: "Search Perplexity",
        description: "Search the web using Perplexity.ai with claim-level citation provenance ([1] markers, snippets, dates), optional live claim-source verification (supported/weak/unverified), local caching, cancellation-safe streaming, progress notifications, partial .txt checkpoints, typed error JSON, poolable browser profiles, and optional official Agent API backend. Supports model, thread_url, timeout_seconds (default 900s / max 1800s), profile, backend, verify_claims, no_cache, and output_file / auto .txt spooling (>= 15000 chars).",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        inputSchema: {
            query: z.string().describe("The search query or follow-up question"),
            model: z
                .string()
                .optional()
                .describe("Optional Perplexity model name (e.g. 'Best', 'GPT-6.1 Sol', 'Grok 4.7', 'Claude Sonnet 5.5', 'Gemini 4 Hydrogen', 'Kimi K3', or 'sonar' for API backend). Omit to use the currently selected model."),
            thread_url: z
                .string()
                .optional()
                .describe("Optional Perplexity thread URL returned by a previous search to ask a follow-up in the same conversation (browser backend)."),
            timeout_seconds: timeoutSecondsSchema,
            output_file: outputFileSchema,
            profile: profileSchema,
            backend: backendSchema,
            verify_claims: verifyClaimsSchema,
            no_cache: noCacheSchema,
        },
    },
    wrapTool("search", async ({ query, model, thread_url, timeout_seconds, output_file, profile, backend, verify_claims, no_cache }, extra) => {
        const result = await search(query, resolveTimeoutMs(timeout_seconds), model, thread_url, {
            profile,
            backend,
            outputFile: output_file,
            verifyClaims: verify_claims,
            noCache: no_cache,
            signal: extra?.signal,
            onProgress: createProgressReporter(extra),
        });
        return textResult(formatResult(result, { query, model, outputFile: output_file }));
    })
);

server.registerTool(
    "search_advanced",
    {
        title: "Advanced Perplexity Search",
        description: "Search Perplexity.ai with specific source selection (web, academic, social), claim-level citation provenance ([1] markers, snippets, dates), optional live claim-source verification, local caching, cancellation-safe streaming, progress notifications, partial .txt checkpoints, typed error JSON, poolable browser profiles, and optional official Agent API backend.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        inputSchema: {
            query: z.string().describe("The search query"),
            sources: z
                .array(z.enum(["web", "academic", "social"]))
                .min(1)
                .describe("Sources to search: 'web' (general web), 'academic' (scholarly articles), 'social' (Reddit & forums). Can combine multiple."),
            model: z
                .string()
                .optional()
                .describe("Optional Perplexity model name (e.g. 'Best', 'GPT-6.1 Sol', 'Grok 4.7', 'Claude Sonnet 5.5', 'Gemini 4 Hydrogen', or 'sonar' for API backend). Omit to use the currently selected model."),
            thread_url: z
                .string()
                .optional()
                .describe("Optional Perplexity thread URL returned by a previous search to ask a follow-up in the same conversation (browser backend)."),
            timeout_seconds: timeoutSecondsSchema,
            output_file: outputFileSchema,
            profile: profileSchema,
            backend: backendSchema,
            verify_claims: verifyClaimsSchema,
            no_cache: noCacheSchema,
        },
    },
    wrapTool("search_advanced", async ({ query, sources, model, thread_url, timeout_seconds, output_file, profile, backend, verify_claims, no_cache }, extra) => {
        const result = await searchWithSources(query, resolveTimeoutMs(timeout_seconds), sources, model, thread_url, {
            profile,
            backend,
            outputFile: output_file,
            verifyClaims: verify_claims,
            noCache: no_cache,
            signal: extra?.signal,
            onProgress: createProgressReporter(extra),
        });
        return textResult(formatResult(result, { query, model, outputFile: output_file }));
    })
);

server.registerTool(
    "compare_models",
    {
        title: "Compare Perplexity Models",
        description: "Ask one question across 2–5 Perplexity models (running concurrently when multiple PERPLEXITY_PROFILE_DIRS profiles or backend='api' are configured; sequential with a single profile), compare shared citations and agreed/divergent key facts, and return a consolidated Markdown report (spooled to .txt if >= 15000 chars or output_file is set).",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        inputSchema: {
            query: z.string().describe("Question or architecture/code comparison prompt to send to each model"),
            models: z
                .array(z.string())
                .min(2)
                .max(5)
                .optional()
                .describe(`Optional list of 2-5 Perplexity models (defaults to ${DEFAULT_COMPARE_MODELS.join(", ")}).`),
            sources: z
                .array(z.enum(["web", "academic", "social"]))
                .min(1)
                .optional()
                .describe("Optional source filter applied to every model in the comparison."),
            timeout_seconds: timeoutSecondsSchema,
            output_file: outputFileSchema,
            backend: backendSchema,
            verify_claims: verifyClaimsSchema,
            no_cache: noCacheSchema,
        },
    },
    wrapTool("compare_models", async ({ query, models, sources, timeout_seconds, output_file, backend, verify_claims, no_cache }, extra) => {
        const comparison = await compareModels({
            query,
            models,
            sources,
            timeoutMs: resolveTimeoutMs(timeout_seconds),
            backend,
            verifyClaims: verify_claims,
            noCache: no_cache,
            signal: extra?.signal,
            onProgress: createProgressReporter(extra),
        });
        return textResult(formatComparison(comparison, { outputFile: output_file }));
    })
);

server.registerTool(
    "health_check",
    {
        title: "Health Check",
        description: "Quick (~5s) diagnostic check verifying Perplexity authentication, absence of Cloudflare blocks, composer search input, add/sources trigger, model selector hydration, and writable local directories. Saves a diagnostic HTML+PNG snapshot automatically if any check fails.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        inputSchema: {
            profile: profileSchema,
        },
    },
    wrapTool("health_check", async ({ profile }, extra) => {
        const report = await healthCheck({ profile, signal: extra?.signal });
        const checkLines = report.checks.map((c) => `- ${c.name}: ${c.ok ? "OK" : "FAIL"}${typeof c.ms === "number" ? ` (${c.ms}ms)` : ""}${c.detail ? ` — ${c.detail}` : ""}${c.error ? ` — ${c.error}` : ""}`);
        const text = [
            `Health status: ${report.status.toUpperCase()} (profile="${report.profile}", ${report.durationMs}ms)`,
            `Authenticated: ${report.authenticated}`,
            `Models available: ${report.modelCount}${report.defaultModel ? ` (saved default: ${report.defaultModel})` : ""}`,
            "",
            "Checks:",
            ...checkLines,
            ...(report.snapshotFiles ? ["", `Diagnostic snapshot saved: ${JSON.stringify(report.snapshotFiles)}`] : []),
            "",
            `Metadata: ${JSON.stringify(report)}`,
        ].join("\n");
        return textResult(text);
    })
);

server.registerTool(
    "login",
    {
        title: "Login to Perplexity",
        description: "Check if you are authenticated on Perplexity.ai for the default or specified browser profile. If not, opens a visible browser window so you can log in once.",
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        inputSchema: {
            profile: profileSchema,
        },
    },
    wrapTool("login", async ({ profile }, extra) => {
        const res = await ensureAuthenticated({ profile, signal: extra?.signal });
        const msg = res.alreadyAuthenticated
            ? `Already authenticated on Perplexity.ai (profile "${res.profile}", profile dir: ${res.profileDir}).`
            : `Login successful. You are now authenticated on Perplexity.ai (profile "${res.profile}", profile dir: ${res.profileDir}).`;
        return textResult(`${msg}\n\nMetadata: ${JSON.stringify({ ok: true, ...res })}`);
    })
);

// --- Shutdown cleanup ---
let shuttingDown = false;
async function shutdown(code = 0) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    await closeBrowser().catch(() => { });
    await server.close().catch(() => { });
    process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGHUP", () => void shutdown(0));
process.stdin.on("close", () => void shutdown(0));
process.stdin.on("end", () => void shutdown(0));

// --- Startup ---
async function main() {
    const pool = getPoolStatus();
    console.error(`[perplexity-web-mcp] Starting v${PKG_VERSION} (timeout=${TIMEOUT_MS}ms, cacheTtl=${resolveCacheTtlSeconds()}s, verifyDefault=${resolveVerifyDefault()}, pool=${pool.map((p) => p.id).join(",")}, apiKey=${process.env.PERPLEXITY_API_KEY ? "configured" : "unset"})...`);
    console.error("[perplexity-web-mcp] Ready. Browser will launch on first tool call.");
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("[perplexity-web-mcp] Fatal error:", err);
    process.exit(1);
});
