import { getPoolStatus } from "./browser.js";
import { normalizeError } from "./errors.js";
import { extractKeyFacts, normalizeText, stripCitationMarkers, STOPWORDS } from "./facts.js";
import { buildTextPreview, resolveLongOutputThreshold, writeTextOutputFile } from "./output.js";
import { search, searchWithSources } from "./search.js";

export const DEFAULT_COMPARE_MODELS = ["GPT-6.1 Sol", "Claude Sonnet 5.5", "Gemini 4 Hydrogen"];

const CONSENSUS_STOPWORDS = new Set([
    ...STOPWORDS,
    "best", "useful", "fine", "option", "options", "rank", "ranking", "score", "rating",
    "personal", "public", "keep", "switch", "overall", "reason", "reasons",
    "claim", "claims", "answer", "answers", "response", "responses",
    "rating_personal", "rank_overall",
]);

const CONSENSUS_MIN_TOKENS = 5;
const CONSENSUS_MIN_CHARS = 30;
const CONSENSUS_THRESHOLD = 0.42;
const CONSENSUS_DEDUPE_THRESHOLD = 0.45;

/** Split an answer into prose-like sentences, removing ranking metadata, Markdown tables, and citation markers. */
export function splitConsensusSentences(text) {
    const lines = stripCitationMarkers(text)
        .replace(/^\s*(?:RATING|RANK|SCORE)[A-Z_]*\s*:.*$/gim, " ")
        .replace(/https?:\/\/\S+/gi, " ")
        .replace(/```[a-z]*\s*/gi, " ")
        .replace(/^\s*#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^\s*\d+\.\s+/gm, "")
        .replace(/\*{1,3}/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("|") && !/^[-=:\s]+$/.test(line));
    if (lines.length === 0)
        return [];
    const plain = lines
        .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
        .join(" ")
        .replace(/\s+/g, " ");
    return plain
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(])/)
        .map((s) => s.replace(/^[\s\-:]+|[\s\-:]+$/g, "").trim())
        .filter((s) => s.length >= CONSENSUS_MIN_CHARS)
        .filter((s, idx, arr) => arr.indexOf(s) === idx);
}

/** Token set used for sentence-level consensus (keeps versions, years, and meaningful numbers). */
export function consensusTokens(text) {
    const normalized = normalizeText(stripCitationMarkers(text)).replace(/https?:\/\/\S+/gi, " ");
    const tokens = new Set();
    for (const raw of normalized.match(/[a-z_][a-z0-9_.+-]*/g) ?? []) {
        const word = raw.replace(/[.+-]+$/g, "");
        if (word.length >= 3 && !CONSENSUS_STOPWORDS.has(word))
            tokens.add(word);
    }
    // Negative lookbehind avoids matching the "11.0" inside "v22.11.0" or "22.11.0".
    for (const number of normalized.match(/(?<![\w.])\d+(?:[.,]\d+)*(?:\s*(?:%|kb|mb|gb|tb|ms|seconds?|minutes?|hours?|days?|weeks?|months?|years?))?\b/g) ?? []) {
        tokens.add(number.replace(/\s+/g, " ").trim());
    }
    return tokens;
}

/** Jaccard similarity between two token sets. */
export function jaccardSimilarity(a, b) {
    if (!a?.size || !b?.size)
        return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let intersection = 0;
    for (const token of small) {
        if (large.has(token))
            intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/** Similarity tuned for paraphrased sentences: average of Jaccard and overlap coefficient. */
export function sentenceSimilarity(a, b) {
    if (!a?.size || !b?.size)
        return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let intersection = 0;
    for (const token of small) {
        if (large.has(token))
            intersection++;
    }
    const jaccard = intersection / (a.size + b.size - intersection);
    const overlap = intersection / small.size;
    return (jaccard + overlap) / 2;
}

/** Sentence-level consensus: shared claims, not isolated lexical tokens. */
export function extractAgreedClaims(entries, { maxClaims = 8, threshold = CONSENSUS_THRESHOLD } = {}) {
    const succeeded = entries.filter((e) => e.ok && e.result?.answer);
    if (succeeded.length < 2)
        return [];
    const perModel = succeeded.map((entry) => ({
        model: entry.model,
        sentences: splitConsensusSentences(entry.result.answer)
            .map((text) => ({ text, tokens: consensusTokens(text) }))
            .filter((s) => s.tokens.size >= CONSENSUS_MIN_TOKENS),
    }));

    const candidates = [];
    for (const source of perModel) {
        for (const sentence of source.sentences) {
            const models = [source.model];
            let bestSimilarity = 0;
            for (const other of perModel) {
                if (other.model === source.model)
                    continue;
                let best = 0;
                for (const candidate of other.sentences) {
                    best = Math.max(best, sentenceSimilarity(sentence.tokens, candidate.tokens));
                }
                if (best >= threshold) {
                    models.push(other.model);
                    bestSimilarity = Math.max(bestSimilarity, best);
                }
            }
            if (models.length >= 2) {
                candidates.push({ text: sentence.text, tokens: sentence.tokens, models, similarity: bestSimilarity });
            }
        }
    }

    candidates.sort((a, b) => b.similarity - a.similarity || b.tokens.size - a.tokens.size || b.text.length - a.text.length);
    const selected = [];
    for (const candidate of candidates) {
        const duplicate = selected.find((s) => sentenceSimilarity(s.tokens, candidate.tokens) >= CONSENSUS_DEDUPE_THRESHOLD
            || normalizeText(s.text) === normalizeText(candidate.text));
        if (duplicate) {
            for (const model of candidate.models) {
                if (!duplicate.models.includes(model))
                    duplicate.models.push(model);
            }
            duplicate.similarity = Math.max(duplicate.similarity, candidate.similarity);
            continue;
        }
        selected.push({ ...candidate, models: [...candidate.models] });
    }

    return selected.slice(0, maxClaims).map((claim) => ({
        text: claim.text.length > 320 ? `${claim.text.slice(0, 317)}...` : claim.text,
        models: claim.models,
        similarity: Number(claim.similarity.toFixed(2)),
    }));
}

/** Keep only divergent specifics that are useful: dates, versions, unit-bearing or 3+ digit numbers. */
export function isMeaningfulDivergentFact(fact) {
    if (!fact)
        return false;
    if (fact.type === "date" || fact.type === "version")
        return true;
    if (fact.type === "number") {
        return Boolean(fact.unit) || String(fact.numeric ?? fact.value ?? "").replace(/\D/g, "").length >= 3;
    }
    return false;
}

/** Build an agreement/divergence comparison across successful model results using sentence consensus & shared citations. */
export function analyzeComparison(entries) {
    const succeeded = entries.filter((e) => e.ok && e.result?.answer);
    const factMap = new Map(); // canonical fact key -> { type, value, numeric, unit, models: Set<string> }
    const sourceMap = new Map(); // url -> { url, title, models: Set<string> }

    for (const entry of succeeded) {
        const facts = extractKeyFacts(entry.result.answer, { maxFacts: 25 });
        for (const f of facts) {
            const rec = factMap.get(f.key) ?? {
                key: f.key,
                type: f.type,
                value: f.value,
                numeric: f.numeric,
                unit: f.unit,
                models: new Set(),
            };
            rec.models.add(entry.model);
            factMap.set(f.key, rec);
        }
        for (const s of entry.result.sources ?? []) {
            if (!s?.url)
                continue;
            const rec = sourceMap.get(s.url) ?? { url: s.url, title: s.title || s.domain || s.url, models: new Set() };
            rec.models.add(entry.model);
            sourceMap.set(s.url, rec);
        }
    }

    const agreedClaims = extractAgreedClaims(entries);
    const divergentFacts = [];
    for (const rec of factMap.values()) {
        const models = Array.from(rec.models);
        if (models.length === 1 && isMeaningfulDivergentFact(rec)) {
            divergentFacts.push({ type: rec.type, value: rec.value, model: models[0] });
        }
    }
    const typeOrder = { version: 0, date: 1, number: 2 };
    divergentFacts.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

    const sharedSources = [];
    for (const rec of sourceMap.values()) {
        if (rec.models.size >= 2) {
            sharedSources.push({ url: rec.url, title: rec.title, models: Array.from(rec.models) });
        }
    }
    sharedSources.sort((a, b) => b.models.length - a.models.length);

    return {
        totalModels: entries.length,
        succeededCount: succeeded.length,
        failedCount: entries.length - succeeded.length,
        agreedClaims,
        divergentFacts: divergentFacts.slice(0, 20),
        sharedSources: sharedSources.slice(0, 20),
        totalUniqueSources: sourceMap.size,
    };
}

/** Fan out one query across 2-5 Perplexity models concurrently when pool slots or API backend allow. */
export async function compareModels(
    {
        query,
        models = DEFAULT_COMPARE_MODELS,
        sources = null,
        timeoutMs = 900_000,
        backend = "auto",
        verifyClaims = undefined,
        noCache = false,
        signal,
        onProgress,
    },
    deps = {}
) {
    const searchFn = deps.searchFn ?? search;
    const searchWithSourcesFn = deps.searchWithSourcesFn ?? searchWithSources;
    const getPoolStatusFn = deps.getPoolStatusFn ?? getPoolStatus;

    const cleanModels = Array.from(new Set((Array.isArray(models) && models.length > 0 ? models : DEFAULT_COMPARE_MODELS).map((m) => String(m).trim()).filter(Boolean)));
    const pool = getPoolStatusFn();
    const poolIds = pool.filter((p) => p.inPool).map((p) => p.id);
    const activePoolIds = poolIds.length > 0 ? poolIds : ["default"];
    const startedAt = Date.now();

    if (onProgress) {
        await onProgress({
            progress: 5,
            total: 100,
            message: `Comparing ${cleanModels.length} models (${backend === "api" ? "API parallel" : `${activePoolIds.length} browser slot(s)`})...`,
        }).catch(() => { });
    }

    let completed = 0;
    const entries = await Promise.all(cleanModels.map(async (modelName, idx) => {
        const assignedProfile = backend === "api" ? undefined : activePoolIds[idx % activePoolIds.length];
        const t0 = Date.now();
        try {
            const opts = {
                profile: assignedProfile,
                backend,
                verifyClaims,
                noCache,
                signal,
            };
            const result = sources && sources.length > 0
                ? await searchWithSourcesFn(query, timeoutMs, sources, modelName, undefined, opts)
                : await searchFn(query, timeoutMs, modelName, undefined, opts);
            completed++;
            if (onProgress) {
                await onProgress({
                    progress: Math.min(95, 10 + Math.round((completed / cleanModels.length) * 85)),
                    total: 100,
                    message: `Finished ${modelName} (${completed}/${cleanModels.length})...`,
                }).catch(() => { });
            }
            return { model: modelName, profile: assignedProfile ?? "api", ok: true, durationMs: result.durationMs ?? (Date.now() - t0), result };
        }
        catch (err) {
            const normalized = normalizeError(err, "compare_models");
            completed++;
            if (onProgress) {
                await onProgress({
                    progress: Math.min(95, 10 + Math.round((completed / cleanModels.length) * 85)),
                    total: 100,
                    message: `${modelName} failed (${normalized.code}; ${completed}/${cleanModels.length})...`,
                }).catch(() => { });
            }
            return { model: modelName, profile: assignedProfile ?? "api", ok: false, durationMs: Date.now() - t0, error: normalized.toJSON().error };
        }
    }));

    if (onProgress) {
        await onProgress({ progress: 100, total: 100, message: "Comparison complete." }).catch(() => { });
    }

    const analysis = analyzeComparison(entries);
    return {
        query,
        models: cleanModels,
        sources,
        entries,
        analysis,
        parallelSlots: backend === "api" ? cleanModels.length : activePoolIds.length,
        durationMs: Date.now() - startedAt,
    };
}

/** Format a multi-model comparison as readable Markdown + structured Metadata JSON, spooling long outputs to .txt. */
export function formatComparison(comparison, { outputFile = "", env = process.env } = {}) {
    const { query, entries, analysis, parallelSlots, durationMs } = comparison;
    const rows = entries.map((e) => {
        if (!e.ok) {
            return `| ${e.model} | FAILED (${e.error?.code || "ERROR"}) | ${e.durationMs}ms | - | - | - | - | - |`;
        }
        const r = e.result;
        const ver = r.verificationSummary
            ? `${r.verificationSummary.supported}/${r.verificationSummary.checkedClaims} supported`
            : `${r.claims?.length ?? 0} claims`;
        const cacheTag = r.cached ? `hit (${r.cacheAgeSeconds ?? 0}s)` : "fresh";
        return `| ${e.model} | OK (${r.backend || "browser"}) | ${e.durationMs}ms | ${cacheTag} | ${r.answer.length} | ${r.sources?.length ?? 0} | ${ver} | ${r.threadUrl || "-"} |`;
    });

    const summarySection = [
        `## Multi-Model Comparison (${analysis.succeededCount}/${analysis.totalModels} succeeded, slots=${parallelSlots}, total=${durationMs}ms)`,
        "",
        "| Model | Status | Time | Cache | Chars | Sources | Claims | Thread URL |",
        "| --- | --- | ---: | --- | ---: | ---: | --- | --- |",
        ...rows,
    ];

    if (analysis.agreedClaims.length > 0) {
        summarySection.push("", "### Agreed Claims (similar across models)");
        for (const claim of analysis.agreedClaims) {
            const match = Math.round(claim.similarity * 100);
            summarySection.push(`- **${claim.text}** — [${claim.models.join(", ")}] (match ${match}%)`);
        }
    }
    else if (analysis.succeededCount >= 2) {
        summarySection.push("", "### Agreed Claims", "No sentence-level consensus found; compare the per-model answers below.");
    }
    if (analysis.divergentFacts.length > 0) {
        summarySection.push("", "### Divergent / Single-Model Specifics (verify locally)");
        for (const fact of analysis.divergentFacts) {
            summarySection.push(`- **${fact.value}** (${fact.type}) — only mentioned by ${fact.model}`);
        }
    }
    if (analysis.sharedSources.length > 0) {
        summarySection.push("", "### Shared Citations (>= 2 models)");
        for (const s of analysis.sharedSources) {
            summarySection.push(`- [${s.title}](${s.url}) — [${s.models.join(", ")}]`);
        }
    }

    const answerSections = [];
    for (const e of entries) {
        answerSections.push("", `---`, "", `## ${e.model}`);
        if (!e.ok) {
            answerSections.push(`Error (${e.error?.code}): ${e.error?.message}`);
            continue;
        }
        answerSections.push(e.result.answer);
        if (e.result.sources?.length > 0) {
            answerSections.push("", "Sources:");
            for (const [i, s] of e.result.sources.entries()) {
                answerSections.push(`${s.index ?? i + 1}. [${s.title}](${s.url})`);
            }
        }
    }

    const fullBody = [...summarySection, ...answerSections].join("\n");
    const threshold = resolveLongOutputThreshold(env);
    const explicitFile = Boolean(outputFile && String(outputFile).trim());
    const meta = {
        ok: analysis.succeededCount > 0,
        tool: "compare_models",
        models: comparison.models,
        succeededCount: analysis.succeededCount,
        failedCount: analysis.failedCount,
        agreedClaimCount: analysis.agreedClaims.length,
        divergentFactCount: analysis.divergentFacts.length,
        sharedSourceCount: analysis.sharedSources.length,
        totalUniqueSources: analysis.totalUniqueSources,
        parallelSlots,
        durationMs,
        spooled: false,
        outputFile: null,
    };

    if (!explicitFile && !(threshold > 0 && fullBody.length >= threshold)) {
        return `${fullBody}\n\nMetadata: ${JSON.stringify(meta)}`;
    }

    const docHeader = [
        "# Perplexity Multi-Model Comparison",
        `Generated: ${new Date().toISOString()}`,
        `Models: ${comparison.models.join(", ")}`,
        `Query: ${String(query ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}`,
        "",
        "---",
        "",
    ].join("\n");
    const writeRes = writeTextOutputFile({ fullDocument: `${docHeader}${fullBody}\n`, query: `compare-${query}`, outputFile, env });
    if (!writeRes.ok) {
        return `[Warning: could not save comparison file "${writeRes.targetPath}" (${writeRes.error}); returning inline]\n\n${fullBody}\n\nMetadata: ${JSON.stringify(meta)}`;
    }

    meta.spooled = true;
    meta.outputFile = writeRes.targetPath;
    const summaryText = summarySection.join("\n");
    const { preview, truncated } = buildTextPreview(fullBody, 2_000);
    return [
        explicitFile ? "[Comparison saved to file]" : `[Long comparison saved to file (>= ${threshold} chars)]`,
        `File: ${writeRes.targetPath}`,
        `Size: ${fullBody.length} chars (${fullBody.split(/\r?\n/).length} lines)`,
        "",
        summaryText,
        ...(truncated ? ["", `Read full individual model outputs at ${writeRes.targetPath}`] : ["", preview]),
        "",
        `Metadata: ${JSON.stringify(meta)}`,
    ].join("\n");
}
