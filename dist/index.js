#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureAuthenticated } from "./auth.js";
import { closeBrowser, ensurePoolInitialized, getPoolStatus } from "./browser.js";
import { normalizeError } from "./errors.js";
import { formatResult } from "./output.js";
import { search, searchWithSources, listModels, setDefaultModel, DEFAULT_TIMEOUT_MS } from "./search.js";

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
    version: "1.3.0",
});

server.registerTool(
    "list_models",
    {
        description: "List the AI models available on your Perplexity.ai account (excluding unavailable Max-tier models), active and saved default model, and configured browser profile pool status.",
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
        description: "Set or clear your sticky default Perplexity model (persisted locally). Used automatically by search/search_advanced whenever no model argument is passed.",
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
        description: "Search the web using Perplexity.ai with claim-level citation provenance ([1] markers, snippets, dates), cancellation-safe streaming, progress notifications, partial .txt checkpoints, typed error JSON, poolable browser profiles, and optional official Agent API backend (PERPLEXITY_API_KEY). Supports model, thread_url, timeout_seconds (default 900s / max 1800s), profile, backend, and output_file / auto .txt spooling (>= 15000 chars).",
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
        },
    },
    wrapTool("search", async ({ query, model, thread_url, timeout_seconds, output_file, profile, backend }, extra) => {
        const result = await search(query, resolveTimeoutMs(timeout_seconds), model, thread_url, {
            profile,
            backend,
            outputFile: output_file,
            signal: extra?.signal,
            onProgress: createProgressReporter(extra),
        });
        return textResult(formatResult(result, { query, model, outputFile: output_file }));
    })
);

server.registerTool(
    "search_advanced",
    {
        description: "Search Perplexity.ai with specific source selection (web, academic, social), claim-level citation provenance ([1] markers, snippets, dates), cancellation-safe streaming, progress notifications, partial .txt checkpoints, typed error JSON, poolable browser profiles, and optional official Agent API backend. Supports model, thread_url, timeout_seconds (default 900s / max 1800s), profile, backend, and output_file / auto .txt spooling (>= 15000 chars).",
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
        },
    },
    wrapTool("search_advanced", async ({ query, sources, model, thread_url, timeout_seconds, output_file, profile, backend }, extra) => {
        const result = await searchWithSources(query, resolveTimeoutMs(timeout_seconds), sources, model, thread_url, {
            profile,
            backend,
            outputFile: output_file,
            signal: extra?.signal,
            onProgress: createProgressReporter(extra),
        });
        return textResult(formatResult(result, { query, model, outputFile: output_file }));
    })
);

server.registerTool(
    "login",
    {
        description: "Check if you are authenticated on Perplexity.ai for the default or specified browser profile. If not, opens a visible browser window so you can log in once.",
        inputSchema: {
            profile: profileSchema,
        },
    },
    wrapTool("login", async ({ profile }, extra) => {
        const res = await ensureAuthenticated({ profile, signal: extra?.signal });
        const msg = res.alreadyAuthenticated
            ? `Already authenticated on Perplexity.ai (profile "${res.profile}").`
            : `Login successful. You are now authenticated on Perplexity.ai (profile "${res.profile}").`;
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
    console.error(`[perplexity-web-mcp] Starting v1.3.0 (timeout=${TIMEOUT_MS}ms, pool=${pool.map((p) => p.id).join(",")}, apiKey=${process.env.PERPLEXITY_API_KEY ? "configured" : "unset"})...`);
    console.error("[perplexity-web-mcp] Ready. Browser will launch on first tool call.");
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("[perplexity-web-mcp] Fatal error:", err);
    process.exit(1);
});
