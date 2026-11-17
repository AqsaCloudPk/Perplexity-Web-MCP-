import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, "../outputs");
export const DEFAULT_LONG_OUTPUT_CHARS = 15_000;
export const PREVIEW_CHARS = 2_000;
const STALE_OUTPUT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Resolve the character threshold above which answers auto-save to a .txt file (0 disables auto-saving). */
export function resolveLongOutputThreshold(env = process.env) {
    const raw = env?.PERPLEXITY_LONG_OUTPUT_CHARS;
    if (raw === undefined || String(raw).trim() === "")
        return DEFAULT_LONG_OUTPUT_CHARS;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0)
        return parsed;
    return DEFAULT_LONG_OUTPUT_CHARS;
}

/** Resolve the default directory used when saving output .txt files. */
export function resolveOutputDir(env = process.env) {
    const custom = env?.PERPLEXITY_OUTPUT_DIR;
    return custom && String(custom).trim()
        ? path.resolve(String(custom).trim())
        : DEFAULT_OUTPUT_DIR;
}

function buildSlug(query) {
    const cleaned = String(query ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
    return cleaned || "response";
}

function buildUniquePath(outputDir, query, suffix = "") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = buildSlug(query);
    let candidate = path.join(outputDir, `${stamp}-${slug}${suffix}.txt`);
    let counter = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(outputDir, `${stamp}-${slug}${suffix}-${counter++}.txt`);
    }
    return candidate;
}

function resolveTargetFilePath(outputFile, query, outputDir) {
    if (outputFile && String(outputFile).trim()) {
        const trimmed = String(outputFile).trim();
        const candidate = path.isAbsolute(trimmed)
            ? path.resolve(trimmed)
            : path.resolve(outputDir, trimmed);
        return path.extname(candidate) ? candidate : `${candidate}.txt`;
    }
    return buildUniquePath(outputDir, query);
}

function buildPreview(text, maxChars) {
    if (text.length <= maxChars)
        return { preview: text, truncated: false };
    const slice = text.slice(0, maxChars);
    const lastNewline = slice.lastIndexOf("\n");
    const cutoff = lastNewline >= Math.floor(maxChars * 0.4) ? lastNewline : maxChars;
    return { preview: text.slice(0, cutoff), truncated: true };
}

function pruneOldOutputs(outputDir) {
    try {
        if (!fs.existsSync(outputDir))
            return;
        const cutoff = Date.now() - STALE_OUTPUT_MAX_AGE_MS;
        for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".txt"))
                continue;
            const fullPath = path.join(outputDir, entry.name);
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs < cutoff) {
                fs.rmSync(fullPath, { force: true });
            }
        }
    }
    catch {
        // Best-effort cleanup; never fail a search response.
    }
}

function formatSourcesBlock(sources, includeSnippets = true) {
    if (!sources || sources.length === 0)
        return "";
    return "\n\nSources:\n" + sources.map((s, i) => {
        const num = s.index ?? i + 1;
        const dateTag = s.date || s.lastUpdated ? ` (${s.date || s.lastUpdated})` : "";
        const snippet = includeSnippets && s.snippet
            ? ` — "${String(s.snippet).slice(0, 180)}${String(s.snippet).length > 180 ? "..." : ""}"`
            : "";
        return `${num}. [${s.title}](${s.url})${dateTag}${snippet}`;
    }).join("\n");
}

function formatClaimsBlock(claims, verificationSummary = null) {
    if (!claims || claims.length === 0)
        return "";
    const durationNote = typeof verificationSummary?.durationMs === "number" ? `, ${verificationSummary.durationMs}ms` : "";
    const summaryLine = verificationSummary
        ? `Verification: supported=${verificationSummary.supported}, weak=${verificationSummary.weak}, unverified=${verificationSummary.unverified} (pages=${verificationSummary.pagesLoaded}/${verificationSummary.pagesChecked}${durationNote})\n`
        : "";
    const lines = claims.map((c) => {
        const refs = (c.citations ?? []).map((n) => `[${n}]`).join("");
        const urlList = (c.urls ?? []).join(", ");
        const cleanText = String(c.text ?? "").replace(/\s+/g, " ").trim();
        const trimmed = cleanText.length > 260 ? `${cleanText.slice(0, 260)}...` : cleanText;
        let verifyTag = "";
        if (c.verification?.status) {
            const v = c.verification;
            const detail = v.missingFacts?.length ? ` missing=[${v.missingFacts.join(", ")}]` : "";
            verifyTag = ` [${v.status}${v.reason && v.status !== "supported" ? `:${v.reason}` : ""}${detail}]`;
        }
        return `- ${trimmed}${refs ? ` -> ${refs}` : ""}${verifyTag}${urlList ? ` (${urlList})` : ""}`;
    }).join("\n");
    return `\n\nClaim Provenance:\n${summaryLine}${lines}`;
}

function formatAttachmentsBlock(attachments) {
    if (!attachments || attachments.length === 0)
        return "";
    return "\n\nAttachments:\n" + attachments.map((a, i) => `${i + 1}. ${a.name}${a.url ? ` (${a.url})` : ""}`).join("\n");
}

function formatThreadLine(threadUrl) {
    return threadUrl && threadUrl.replace(/\/$/, "") !== "https://www.perplexity.ai"
        ? `\n\nThread URL: ${threadUrl}`
        : "";
}

function buildFileDocument(result, { query, model, statusLabel, sourcesText, claimsText, attachmentsText }) {
    const cleanQuery = String(query ?? "").replace(/\s+/g, " ").trim();
    const querySummary = cleanQuery.length > 300 ? `${cleanQuery.slice(0, 300)}...` : cleanQuery;
    const headerLines = [
        "# Perplexity Web Search Output",
        `Generated: ${new Date().toISOString()}`,
        `Status: ${statusLabel || (result.partial ? "partial" : "complete")}`,
        `Backend: ${result.backend || "browser"}`,
        `Profile: ${result.profile || "default"}`,
        `Model: ${model && String(model).trim() ? String(model).trim() : (result.modelUsed || "(default)")}`,
        `Query: ${querySummary || "(none)"}`,
        `Thread URL: ${result.threadUrl || "(none)"}`,
        "",
        "---",
        "",
    ];
    return `${headerLines.join("\n")}${result.answer}${claimsText}${attachmentsText}${sourcesText}\n`;
}

/**
 * Persist or overwrite a partial answer checkpoint during long waits, timeouts, or cancellation.
 * Returns the checkpoint file path or null if partial text is empty or write fails.
 */
export function writeCheckpoint(partialState, options = {}) {
    const answer = partialState?.answer ?? "";
    if (!String(answer).trim())
        return null;
    const { query = "", model = "", statusLabel = "partial-checkpoint", existingPath = null, env = process.env } = options;
    const outputDir = resolveOutputDir(env);
    const targetPath = existingPath || buildUniquePath(outputDir, query, "-partial");
    const sourcesText = formatSourcesBlock(partialState?.sources);
    const claimsText = formatClaimsBlock(partialState?.claims);
    const attachmentsText = formatAttachmentsBlock(partialState?.attachments);
    const body = buildFileDocument(
        {
            answer,
            sources: partialState?.sources ?? [],
            claims: partialState?.claims ?? [],
            attachments: partialState?.attachments ?? [],
            threadUrl: partialState?.threadUrl ?? "",
            backend: partialState?.backend ?? "browser",
            profile: partialState?.profile ?? "default",
            modelUsed: partialState?.modelUsed ?? null,
            partial: true,
        },
        { query, model, statusLabel, sourcesText, claimsText, attachmentsText }
    );
    try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, body, "utf8");
        return targetPath;
    }
    catch {
        return null;
    }
}

/** Remove a temporary partial checkpoint once a search completes successfully. */
export function removeCheckpoint(checkpointPath) {
    if (!checkpointPath)
        return;
    try {
        fs.rmSync(checkpointPath, { force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Ignore cleanup failure
    }
}

/** Build structured response metadata included in tool results. */
export function buildResultMetadata(result, { model = "", outputFile = null, spooled = false } = {}) {
    const answer = result?.answer ?? "";
    const sources = result?.sources ?? [];
    const claims = result?.claims ?? [];
    const enrichedSourceCount = sources.filter((s) => Boolean(s.snippet || s.date || s.lastUpdated)).length;
    const meta = {
        ok: true,
        backend: result?.backend ?? "browser",
        profile: result?.profile ?? "default",
        modelRequested: model && String(model).trim() ? String(model).trim() : null,
        modelUsed: result?.modelUsed ?? null,
        chars: answer.length,
        lines: answer ? answer.split(/\r?\n/).length : 0,
        sourceCount: sources.length,
        enrichedSourceCount,
        citedClaimCount: claims.length,
        attachmentCount: result?.attachments?.length ?? 0,
        attachments: result?.attachments?.length ? result.attachments : undefined,
        partial: Boolean(result?.partial),
        timedOut: Boolean(result?.timedOut),
        spooled,
        outputFile: outputFile ?? null,
        durationMs: typeof result?.durationMs === "number" ? result.durationMs : null,
        threadUrl: result?.threadUrl || null,
    };
    if (typeof result?.turnCount === "number")
        meta.turnCount = result.turnCount;
    if (result?.virtualizedThread)
        meta.virtualizedThread = true;
    if (result?.cached) {
        meta.cached = true;
        meta.cacheAgeSeconds = result.cacheAgeSeconds ?? 0;
    }
    if (result?.verificationSummary)
        meta.verification = result.verificationSummary;
    if (result?.usage)
        meta.usage = result.usage;
    return meta;
}

/** Spool any document text to a UTF-8 .txt file with safe pruning & fallback handling. */
export function writeTextOutputFile({ fullDocument, query = "", outputFile = "", env = process.env } = {}) {
    const outputDir = resolveOutputDir(env);
    const explicitFile = Boolean(outputFile && String(outputFile).trim());
    const targetPath = resolveTargetFilePath(outputFile, query, outputDir);
    try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, fullDocument, "utf8");
        if (!explicitFile) {
            pruneOldOutputs(outputDir);
        }
        return { ok: true, targetPath, explicitFile };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[perplexity-web-mcp] Failed saving output file "${targetPath}": ${message}`);
        return { ok: false, targetPath, explicitFile, error: message };
    }
}

/** Build a truncated inline preview for any text body when spooled to file. */
export function buildTextPreview(text, maxChars = PREVIEW_CHARS) {
    return buildPreview(text, maxChars);
}

/**
 * Format a Perplexity result for MCP return, spooling long responses (or any response
 * when outputFile is requested) to a UTF-8 .txt file so agents can read it in slices.
 */
export function formatResult(result, options = {}) {
    if (!result.answer)
        return "No answer found. Perplexity may have changed its structure.";

    const { query = "", model = "", outputFile = "", env = process.env } = options;
    const sourcesText = formatSourcesBlock(result.sources);
    const claimsText = formatClaimsBlock(result.claims, result.verificationSummary);
    const attachmentsText = formatAttachmentsBlock(result.attachments);
    const threadText = formatThreadLine(result.threadUrl);
    const threshold = resolveLongOutputThreshold(env);
    const explicitFile = Boolean(outputFile && String(outputFile).trim());
    const exceedsThreshold = threshold > 0 && result.answer.length >= threshold;
    const notices = [];
    if (result.cached) {
        notices.push(`[Cached result (${result.cacheAgeSeconds ?? 0}s old); pass no_cache=true to force fresh query]`);
    }
    if (result.partial) {
        notices.push("[Partial answer: timeout reached before generation finished; returning accumulated text]");
    }
    const prefixNotice = notices.length > 0 ? `${notices.join("\n")}\n\n` : "";

    if (!explicitFile && !exceedsThreshold) {
        const inlineClaimsText = (result.claims?.length ?? 0) > 0 && (result.claims?.length ?? 0) <= 12
            ? claimsText
            : "";
        const meta = buildResultMetadata(result, { model, spooled: false });
        return `${prefixNotice}${result.answer}${inlineClaimsText}${attachmentsText}${sourcesText}${threadText}\n\nMetadata: ${JSON.stringify(meta)}`;
    }

    const fullDocument = buildFileDocument(result, {
        query,
        model,
        statusLabel: result.partial ? "partial-timeout" : "complete",
        sourcesText,
        claimsText,
        attachmentsText,
    });
    const writeRes = writeTextOutputFile({ fullDocument, query, outputFile, env });

    if (!writeRes.ok) {
        const meta = buildResultMetadata(result, { model, spooled: false });
        return `[Warning: could not save output file "${writeRes.targetPath}" (${writeRes.error}); returning inline]\n\n`
            + `${prefixNotice}${result.answer}${attachmentsText}${sourcesText}${threadText}\n\nMetadata: ${JSON.stringify(meta)}`;
    }

    const answerLines = result.answer.split(/\r?\n/).length;
    const totalFileLines = fullDocument.split(/\r?\n/).length;
    const { preview, truncated } = buildPreview(result.answer, PREVIEW_CHARS);
    const headerNotice = explicitFile
        ? (result.partial ? "[Partial output saved to file]" : "[Output saved to file]")
        : `[Long output saved to file for token efficiency (>= ${threshold} chars)]`;
    const meta = buildResultMetadata(result, { model, outputFile: writeRes.targetPath, spooled: true });

    return [
        ...(notices.length > 0 ? notices : []),
        headerNotice,
        `File: ${writeRes.targetPath}`,
        `Answer size: ${result.answer.length} chars (${answerLines} lines); total file: ${totalFileLines} lines`,
        "Read the full response and Claim Provenance section in slices with your file-reading tool.",
        "",
        "Preview:",
        preview + (truncated ? `\n[... truncated; read full output at ${writeRes.targetPath}]` : ""),
    ].join("\n") + `${attachmentsText}${sourcesText}${threadText}\n\nMetadata: ${JSON.stringify(meta)}`;
}
