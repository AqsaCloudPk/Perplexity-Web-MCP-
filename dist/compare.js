import { getPoolStatus } from "./browser.js";
import { normalizeError } from "./errors.js";
import { extractKeyFacts } from "./facts.js";
import { buildTextPreview, resolveLongOutputThreshold, writeTextOutputFile } from "./output.js";
import { search, searchWithSources } from "./search.js";

export const DEFAULT_COMPARE_MODELS = ["GPT-6.1 Sol", "Claude Sonnet 5.5", "Gemini 4 Hydrogen"];

/** Build an agreement/divergence comparison across successful model results using key facts & shared citations. */
export function analyzeComparison(entries) {
    const succeeded = entries.filter((e) => e.ok && e.result?.answer);
    const factMap = new Map(); // canonical fact key -> { type, value, models: Set<string> }
    const sourceMap = new Map(); // url -> { url, title, models: Set<string> }

    for (const entry of succeeded) {
        const facts = extractKeyFacts(entry.result.answer, { maxFacts: 25 });
        for (const f of facts) {
            const rec = factMap.get(f.key) ?? { key: f.key, type: f.type, value: f.value, models: new Set() };
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

    const agreedFacts = [];
    const modelUniqueFacts = [];
    for (const rec of factMap.values()) {
        const models = Array.from(rec.models);
        if (models.length >= 2) {
            agreedFacts.push({ type: rec.type, value: rec.value, models });
        }
        else if (rec.type === "number" || rec.type === "date" || rec.type === "version") {
            modelUniqueFacts.push({ type: rec.type, value: rec.value, model: models[0] });
        }
    }

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
        agreedFacts: agreedFacts.slice(0, 20),
        divergentOrUniqueFacts: modelUniqueFacts.slice(0, 20),
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

    if (analysis.agreedFacts.length > 0) {
        summarySection.push("", "### Agreed Key Facts (>= 2 models)");
        for (const f of analysis.agreedFacts) {
            summarySection.push(`- **${f.value}** (${f.type}) — [${f.models.join(", ")}]`);
        }
    }
    if (analysis.divergentOrUniqueFacts.length > 0) {
        summarySection.push("", "### Divergent / Single-Model Specifics (verify locally)");
        for (const f of analysis.divergentOrUniqueFacts) {
            summarySection.push(`- **${f.value}** (${f.type}) — only mentioned by ${f.model}`);
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
        agreedFactCount: analysis.agreedFacts.length,
        uniqueFactCount: analysis.divergentOrUniqueFacts.length,
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
