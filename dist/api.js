import { ErrorCode, PerplexityMcpError } from "./errors.js";

const DEFAULT_API_URL = "https://api.perplexity.ai/v1/agent";

/** Resolve which backend ('browser' or 'api') to execute based on mode, key availability, and thread_url. */
export function resolveExecutionBackend({ backend = "auto", threadUrl = "", env = process.env } = {}) {
    const mode = String(backend || env?.PERPLEXITY_BACKEND || "auto").trim().toLowerCase();
    const apiKey = env?.PERPLEXITY_API_KEY?.trim() || "";

    if (mode === "api") {
        if (!apiKey) {
            throw new PerplexityMcpError(
                ErrorCode.INVALID_PARAMS,
                'backend="api" requires PERPLEXITY_API_KEY to be configured, or omit backend / pass backend="browser" to use your browser Pro session.',
                { stage: "validate_params" }
            );
        }
        if (threadUrl) {
            throw new PerplexityMcpError(
                ErrorCode.INVALID_PARAMS,
                'thread_url points to a web UI session and cannot be continued via backend="api". Use backend="browser" for web thread follow-ups.',
                { stage: "validate_params", threadUrl }
            );
        }
        return "api";
    }
    if (mode === "browser") {
        return "browser";
    }
    if (mode !== "auto") {
        throw new PerplexityMcpError(
            ErrorCode.INVALID_PARAMS,
            `Invalid backend "${backend}". Expected "auto", "browser", or "api".`,
            { stage: "validate_params" }
        );
    }
    // In auto mode, prefer the fast official API when PERPLEXITY_API_KEY is explicitly configured and no web thread_url is continued.
    if (apiKey && !threadUrl) {
        return "api";
    }
    return "browser";
}

/** Extract claim-to-citation mapping from markdown/plain text containing [1], [2] style markers. */
export function extractClaimsFromCitedText(text, sources = []) {
    const byIndex = new Map(sources.map((s, idx) => [s.index ?? idx + 1, s]));
    const lines = [];
    let inCodeFence = false;
    for (const rawLine of String(text ?? "").split(/\r?\n/)) {
        const l = rawLine.trim();
        if (/^```/.test(l)) {
            inCodeFence = !inCodeFence;
            continue;
        }
        if (inCodeFence || !l || /^#{1,4}\s/.test(l) || /^\|[-\s|]+\|$/.test(l))
            continue;
        lines.push(l);
    }

    const claims = [];
    for (const line of lines) {
        const cleanedLine = line.replace(/^-\s+/, "").trim();
        const matches = Array.from(cleanedLine.matchAll(/\[(?:web:)?(\d+(?:\s*,\s*\d+)*)\]/g));
        if (matches.length === 0)
            continue;
        const citationIndices = [];
        const seenIdx = new Set();
        for (const m of matches) {
            for (const part of m[1].split(",")) {
                const n = Number.parseInt(part.trim(), 10);
                if (Number.isFinite(n) && !seenIdx.has(n)) {
                    seenIdx.add(n);
                    citationIndices.push(n);
                }
            }
        }
        const urls = citationIndices.map((idx) => byIndex.get(idx)?.url).filter(Boolean);
        claims.push({
            index: claims.length + 1,
            text: cleanedLine,
            citations: citationIndices,
            urls,
        });
    }
    return claims;
}

/** Parse Perplexity Agent API (/v1/agent) or legacy chat/orchestrator responses into unified MCP format. */
export function parseApiResponsePayload(payload, maxSources = 50) {
    let answerParts = [];
    const rawSources = [];

    if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
        answerParts.push(payload.output_text.trim());
    }
    if (Array.isArray(payload?.output)) {
        for (const item of payload.output) {
            if (item?.type === "search_results" && Array.isArray(item.results)) {
                rawSources.push(...item.results);
            }
            else if (item?.type === "message" && Array.isArray(item.content) && answerParts.length === 0) {
                for (const block of item.content) {
                    if (block?.type === "output_text" && typeof block.text === "string") {
                        answerParts.push(block.text);
                    }
                }
            }
        }
    }

    // Fallback for /orchestrator/v1/chat/completions or OpenAI-compatible payloads
    if (answerParts.length === 0 && Array.isArray(payload?.choices)) {
        const content = payload.choices[0]?.message?.content;
        if (typeof content === "string" && content.trim()) {
            answerParts.push(content.trim());
        }
    }
    if (Array.isArray(payload?.search_results)) {
        rawSources.push(...payload.search_results);
    }
    if (rawSources.length === 0 && Array.isArray(payload?.citations)) {
        payload.citations.forEach((url, idx) => {
            if (typeof url === "string")
                rawSources.push({ id: idx + 1, url });
        });
    }

    const sources = [];
    const seenUrls = new Set();
    for (let i = 0; i < rawSources.length; i++) {
        const s = rawSources[i];
        const url = s?.url;
        if (!url || typeof url !== "string" || seenUrls.has(url))
            continue;
        seenUrls.add(url);
        let domain = "";
        try {
            domain = new URL(url).hostname;
        }
        catch {
            domain = "";
        }
        sources.push({
            index: typeof s.id === "number" ? s.id : sources.length + 1,
            title: String(s.title || domain || url).replace(/\s+/g, " ").trim(),
            url,
            ...(domain ? { domain } : {}),
            ...(s.snippet ? { snippet: String(s.snippet).replace(/\s+/g, " ").trim() } : {}),
            ...(s.date ? { date: String(s.date).trim() } : {}),
            ...(s.last_updated ? { lastUpdated: String(s.last_updated).trim() } : {}),
        });
        if (maxSources > 0 && sources.length >= maxSources)
            break;
    }

    const answer = answerParts.join("\n\n").trim();
    const claims = extractClaimsFromCitedText(answer, sources);
    return {
        answer,
        sources,
        claims,
        modelUsed: payload?.model ?? null,
        usage: payload?.usage ?? null,
    };
}

/** Query Perplexity's official Agent API with native AbortSignal timeout + progress reporting. */
export async function runApiSearch(query, timeoutMs, { model, sources, maxSources = 50, signal, onProgress, env = process.env, fetchImpl = fetch } = {}) {
    const apiKey = env?.PERPLEXITY_API_KEY?.trim();
    if (!apiKey) {
        throw new PerplexityMcpError(ErrorCode.INVALID_PARAMS, "PERPLEXITY_API_KEY is not set.", { stage: "api_init" });
    }
    const endpoint = env?.PERPLEXITY_API_URL?.trim() || DEFAULT_API_URL;
    const requestedModel = model?.trim() || env?.PERPLEXITY_API_MODEL?.trim() || "sonar";
    const effort = env?.PERPLEXITY_API_EFFORT?.trim() || "medium";
    const startedAt = Date.now();

    if (onProgress) {
        await onProgress({ progress: 15, total: 100, message: `Calling Perplexity official API (${requestedModel})...` }).catch(() => { });
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const sourceHint = Array.isArray(sources) && sources.length > 0
        ? `Prioritize ${sources.join(" and ")} sources.\n\n`
        : "";
    const body = endpoint.includes("chat/completions")
        ? {
            model: requestedModel,
            messages: [{ role: "user", content: `${sourceHint}${query}` }],
        }
        : {
            model: requestedModel,
            effort,
            input: [{ role: "user", content: `${sourceHint}${query}` }],
        };

    let response;
    try {
        response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: combinedSignal,
        });
    }
    catch (err) {
        if (signal?.aborted) {
            throw new PerplexityMcpError(ErrorCode.CANCELLED, "Official API request cancelled by MCP client.", {
                stage: "api_request",
                cause: err,
            });
        }
        if (timeoutSignal.aborted || err?.name === "TimeoutError") {
            throw new PerplexityMcpError(ErrorCode.TIMEOUT, `Official API request timed out after ${timeoutMs}ms.`, {
                stage: "api_request",
                cause: err,
            });
        }
        throw new PerplexityMcpError(ErrorCode.API_ERROR, `Perplexity API network error: ${err instanceof Error ? err.message : String(err)}`, {
            stage: "api_request",
            cause: err,
        });
    }

    const rawText = await response.text().catch(() => "");
    let payload = null;
    try {
        payload = rawText ? JSON.parse(rawText) : null;
    }
    catch {
        payload = null;
    }

    if (!response.ok) {
        const apiMsg = payload?.error?.message || payload?.message || rawText.slice(0, 300) || `HTTP ${response.status}`;
        throw new PerplexityMcpError(ErrorCode.API_ERROR, `Perplexity API returned HTTP ${response.status}: ${apiMsg}`, {
            stage: "api_response",
            recoverable: response.status >= 500 || response.status === 429,
            details: { status: response.status, endpoint },
        });
    }

    if (onProgress) {
        await onProgress({ progress: 100, total: 100, message: "Done (official API)." }).catch(() => { });
    }

    const parsed = parseApiResponsePayload(payload, maxSources);
    return {
        answer: parsed.answer,
        sources: parsed.sources,
        claims: parsed.claims,
        attachments: [],
        threadUrl: "",
        profile: "api",
        backend: "api",
        modelUsed: parsed.modelUsed || requestedModel,
        usage: parsed.usage,
        partial: false,
        timedOut: false,
        durationMs: Date.now() - startedAt,
    };
}
