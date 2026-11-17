import fs from "fs";
import path from "path";
import { resolveExecutionBackend, runApiSearch } from "./api.js";
import { checkSession } from "./auth.js";
import { ensureBrowser, newSearchPage, runWithProfileSlot } from "./browser.js";
import { buildCacheKey, getCachedResult, resolveCacheDir, resolveCacheTtlSeconds, setCachedResult } from "./cache.js";
import { resolveDiagnosticsDir, saveDiagnosticSnapshot } from "./diagnostics.js";
import { ErrorCode, PerplexityMcpError } from "./errors.js";
import { writeCheckpoint, removeCheckpoint, resolveOutputDir } from "./output.js";
import { resolveVerifyDefault, verifyClaims } from "./verify.js";
import { dataPath } from "./paths.js";

const CONFIG_PATH = dataPath("config.json");
const PERPLEXITY_HOME = "https://www.perplexity.ai/";
export const DEFAULT_TIMEOUT_MS = 900_000;
export const DEFAULT_MAX_SOURCES = 50;
const PROGRESS_INTERVAL_MS = 5_000;
const CHECKPOINT_INTERVAL_MS = 30_000;
const INPUT_SELECTOR = '#ask-input, main [role="textbox"][contenteditable="true"], [role="textbox"][contenteditable="true"], [role="textbox"], main textarea';

const SOURCE_ICON = {
    web: "#pplx-icon-world",
    academic: "#pplx-icon-books",
    social: "#pplx-icon-social",
};

const log = (msg) => console.error(`[perplexity-web-mcp] ${msg}`);

/** Resolve source link extraction limit from env (0 disables cap). */
export function resolveMaxSources(env = process.env) {
    const raw = env?.PERPLEXITY_MAX_SOURCES;
    if (raw === undefined || String(raw).trim() === "")
        return DEFAULT_MAX_SOURCES;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0)
        return parsed;
    return DEFAULT_MAX_SOURCES;
}

function throwIfAborted(signal, stage, profileId, extra = {}) {
    if (signal?.aborted) {
        throw new PerplexityMcpError(ErrorCode.CANCELLED, `Request cancelled during ${stage}.`, {
            stage,
            profile: profileId,
            ...extra,
        });
    }
}

async function emitProgress(onProgress, payload) {
    if (!onProgress)
        return;
    try {
        await onProgress(payload);
    }
    catch {
        // Progress notifications are best-effort
    }
}

/** Click a Playwright locator, falling back to force:true if minimized Chromium throttles rAF stability checks. */
async function safeClick(locator, timeoutMs = 5_000) {
    await locator.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 5_000) });
    try {
        await locator.click({ timeout: Math.min(timeoutMs, 1_200) });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/not stable|intercepts pointer events|Timeout/i.test(msg)) {
            throw err;
        }
        await locator.waitFor({ state: "visible", timeout: 2_000 });
        await locator.click({ force: true, timeout: timeoutMs });
    }
}

function resolveTargetUrl(threadUrl) {
    if (!threadUrl)
        return PERPLEXITY_HOME;
    let parsed;
    try {
        parsed = new URL(threadUrl);
    }
    catch {
        throw new PerplexityMcpError(ErrorCode.INVALID_PARAMS, `Invalid thread_url: "${threadUrl}"`, {
            stage: "validate_params",
        });
    }
    if (parsed.protocol !== "https:" || !/(^|\.)perplexity\.ai$/i.test(parsed.hostname)) {
        throw new PerplexityMcpError(ErrorCode.INVALID_PARAMS, `thread_url must point to https://www.perplexity.ai/... (got "${threadUrl}")`, {
            stage: "validate_params",
        });
    }
    return parsed.toString();
}

async function executeSearchQuery(query, timeoutMs, sources, model, threadUrl, runtimeOpts = {}) {
    const selectedBackend = resolveExecutionBackend({ backend: runtimeOpts.backend, threadUrl });
    const verifyClaimsOpt = typeof runtimeOpts.verifyClaims === "boolean"
        ? runtimeOpts.verifyClaims
        : resolveVerifyDefault();
    const cacheTtlSeconds = resolveCacheTtlSeconds();
    const allowCache = !threadUrl && !runtimeOpts.noCache && cacheTtlSeconds > 0;
    const modelForKey = model?.trim() || (selectedBackend === "browser" ? getDefaultModel() || "(default)" : "");
    const cacheKey = buildCacheKey({ backend: selectedBackend, model: modelForKey, sources, query });
    const sourceTag = sources ? ` sources=[${sources.join(",")}]` : "";

    if (allowCache) {
        const hit = getCachedResult(cacheKey, cacheTtlSeconds);
        if (hit) {
            log(`Cache hit (${selectedBackend}, age=${hit.ageSeconds}s): "${query.slice(0, 60)}"`);
            let cachedResult = {
                ...hit.result,
                cached: true,
                cacheAgeSeconds: hit.ageSeconds,
                durationMs: 0,
            };
            if (verifyClaimsOpt && cachedResult.claims?.length > 0 && !cachedResult.verificationSummary) {
                const verified = await verifyClaims(cachedResult.claims, {
                    signal: runtimeOpts.signal,
                    onProgress: runtimeOpts.onProgress,
                });
                cachedResult.claims = verified.claims;
                cachedResult.verificationSummary = verified.summary;
                setCachedResult(cacheKey, cachedResult, { ttlSeconds: cacheTtlSeconds });
            }
            return cachedResult;
        }
    }

    log(`Search (${selectedBackend}): "${query}"${sourceTag}${model ? ` model="${model}"` : ""}${runtimeOpts.profile ? ` profile="${runtimeOpts.profile}"` : ""}${threadUrl ? ` thread="${threadUrl}"` : ""} (timeout: ${timeoutMs}ms)`);
    let result = selectedBackend === "api"
        ? await runApiSearch(query, timeoutMs, {
            model,
            sources,
            maxSources: resolveMaxSources(),
            signal: runtimeOpts.signal,
            onProgress: runtimeOpts.onProgress,
        })
        : await runWithProfileSlot({ profile: runtimeOpts.profile, signal: runtimeOpts.signal }, (slot) =>
            runSearch(slot, query, timeoutMs, sources, model, threadUrl, runtimeOpts)
        );

    if (verifyClaimsOpt && result?.claims?.length > 0) {
        const verified = await verifyClaims(result.claims, {
            signal: runtimeOpts.signal,
            onProgress: runtimeOpts.onProgress,
        });
        result = {
            ...result,
            claims: verified.claims,
            verificationSummary: verified.summary,
        };
    }

    if (allowCache && result && !result.partial && !result.timedOut) {
        setCachedResult(cacheKey, result, { ttlSeconds: cacheTtlSeconds });
    }
    return result;
}

export async function search(query, timeoutMs, model, threadUrl, runtimeOpts = {}) {
    return executeSearchQuery(query, timeoutMs, null, model, threadUrl, runtimeOpts);
}

export async function searchWithSources(query, timeoutMs, sources, model, threadUrl, runtimeOpts = {}) {
    return executeSearchQuery(query, timeoutMs, sources, model, threadUrl, runtimeOpts);
}

export function getDefaultModel() {
    try {
        if (!fs.existsSync(CONFIG_PATH))
            return null;
        const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        return typeof data?.defaultModel === "string" && data.defaultModel.trim() ? data.defaultModel.trim() : null;
    }
    catch {
        return null;
    }
}

function saveDefaultModel(modelName) {
    const data = fs.existsSync(CONFIG_PATH)
        ? (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; } })()
        : {};
    if (modelName) {
        data.defaultModel = modelName;
    }
    else {
        delete data.defaultModel;
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function setDefaultModel(modelName, runtimeOpts = {}) {
    const trimmed = (modelName ?? "").trim();
    if (!trimmed || /^(none|clear|unset)$/i.test(trimmed)) {
        saveDefaultModel(null);
        return { defaultModel: null, profile: runtimeOpts.profile || "default" };
    }
    return runWithProfileSlot({ profile: runtimeOpts.profile, signal: runtimeOpts.signal }, async (slot) => {
        await ensureBrowser({ slot });
        const page = await newSearchPage(slot);
        try {
            log(`Setting default model to "${trimmed}" on profile "${slot.id}"...`);
            await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
            await dismissDialogs(page);
            await waitForComposer(page, slot.id, 15_000, runtimeOpts.signal);
            const chosen = await selectModel(page, trimmed, slot.id);
            saveDefaultModel(chosen);
            return { defaultModel: chosen, profile: slot.id };
        }
        finally {
            await page.close().catch(() => { });
        }
    });
}

export async function listModels(runtimeOpts = {}) {
    return runWithProfileSlot({ profile: runtimeOpts.profile, signal: runtimeOpts.signal }, async (slot) => {
        await ensureBrowser({ slot });
        const page = await newSearchPage(slot);
        try {
            log(`Listing available Perplexity models on profile "${slot.id}"...`);
            await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
            await dismissDialogs(page);
            await waitForComposer(page, slot.id, 15_000, runtimeOpts.signal);
            const { currentModel, models: allModels } = await openHydratedModelMenu(page, slot.id);
            const models = allModels.filter((m) => !m.disabled && !m.isMax);
            await page.keyboard.press("Escape").catch(() => { });
            return { profile: slot.id, currentModel, defaultModel: getDefaultModel(), models };
        }
        finally {
            await page.close().catch(() => { });
        }
    });
}

/** Probe login, blocking interstitials, search composer, add button, and model menu on Perplexity. */
export async function healthCheck({ profile, timeoutMs = 25_000, signal } = {}) {
    const startedAt = Date.now();
    return runWithProfileSlot({ profile, signal }, async (slot) => {
        const checks = [];
        let page = null;
        let blockingState = null;
        let models = [];
        let currentModel = null;

        try {
            const tLaunch = Date.now();
            await ensureBrowser({ slot });
            page = await newSearchPage(slot);
            checks.push({ name: "browser_launch", ok: true, ms: Date.now() - tLaunch });

            throwIfAborted(signal, "health_nav", slot.id);
            const tNav = Date.now();
            await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 15_000) });
            await dismissDialogs(page);
            checks.push({ name: "navigate", ok: true, ms: Date.now() - tNav, url: page.url() });

            // Check Cloudflare / anti-bot blocking first
            const probe = await page.evaluate(() => {
                const title = (document.title ?? "").trim();
                const bodyText = (document.body?.innerText ?? "").slice(0, 2000);
                const hasCfFrame = Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-running, .cf-turnstile, [data-cf-challenge]'));
                const isCfText = /just a moment|verify you are human|checking your browser|attention required/i.test(`${title}\n${bodyText}`);
                return { title, hasCfFrame, isCfText };
            }).catch(() => ({ title: "", hasCfFrame: false, isCfText: false }));
            const blocked = probe.hasCfFrame || probe.isCfText;
            if (blocked)
                blockingState = probe.title || "Cloudflare challenge";
            checks.push({ name: "cloudflare_clear", ok: !blocked, ...(blocked ? { detail: blockingState } : {}) });

            // Check authentication
            const tAuth = Date.now();
            const authenticated = await checkSession(page);
            checks.push({ name: "auth_session", ok: authenticated, ms: Date.now() - tAuth });

            // Check composer search box
            const tBox = Date.now();
            const searchBoxOk = await page.locator(INPUT_SELECTOR).first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
            checks.push({ name: "search_input", ok: searchBoxOk, ms: Date.now() - tBox });

            // Check + / attachments button
            const tAdd = Date.now();
            const addBtnOk = await page.evaluate((inputSel) => {
                const isVis = (el) => {
                    const r = el.getBoundingClientRect();
                    const cs = getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0;
                };
                return Array.from(document.querySelectorAll("button")).some((b) => {
                    if (!isVis(b) || b.closest('nav, aside, [class*="sidebar"]'))
                        return false;
                    const use = b.querySelector("use");
                    const href = use?.getAttribute("xlink:href") ?? use?.getAttribute("href") ?? "";
                    const label = `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`.trim();
                    return href === "#pplx-icon-plus" || /add files|attach|plugins|connectors|\bmore\b/i.test(label);
                });
            }, INPUT_SELECTOR).catch(() => false);
            checks.push({ name: "add_sources_button", ok: addBtnOk, ms: Date.now() - tAdd });

            // Check model selector menu + hydration
            const tMenu = Date.now();
            let modelMenuOk = false;
            let modelError = null;
            if (searchBoxOk && !blocked) {
                try {
                    const res = await openHydratedModelMenu(page, slot.id);
                    currentModel = res.currentModel;
                    models = res.models.filter((m) => !m.disabled && !m.isMax).map((m) => m.name);
                    await page.keyboard.press("Escape").catch(() => { });
                    modelMenuOk = models.length > 0;
                }
                catch (err) {
                    modelError = err instanceof Error ? err.message : String(err);
                }
            }
            checks.push({ name: "model_menu", ok: modelMenuOk, ms: Date.now() - tMenu, count: models.length, ...(modelError ? { error: modelError } : {}) });

            // Check writable local dirs (outputs, cache, diagnostics)
            const writable = [resolveOutputDir(), resolveCacheDir(), resolveDiagnosticsDir()].every((d) => {
                try {
                    fs.mkdirSync(d, { recursive: true });
                    return true;
                }
                catch {
                    return false;
                }
            });
            checks.push({ name: "local_dirs_writable", ok: writable });

            let status = "healthy";
            if (blocked || !searchBoxOk || !modelMenuOk)
                status = "unhealthy";
            else if (!authenticated)
                status = "unauthenticated";
            else if (!addBtnOk || !writable)
                status = "degraded";

            let snapshotFiles = null;
            if (status === "unhealthy" || status === "degraded") {
                snapshotFiles = await saveDiagnosticSnapshot(page, `health-${status}`, { profile: slot.id, checks });
            }

            return {
                ok: status === "healthy",
                status,
                profile: slot.id,
                authenticated,
                currentModel,
                defaultModel: getDefaultModel(),
                modelCount: models.length,
                models,
                checks,
                snapshotFiles,
                durationMs: Date.now() - startedAt,
            };
        }
        finally {
            await page?.close().catch(() => { });
        }
    });
}

async function captureFailureSnapshot(page, label, extra = {}) {
    return saveDiagnosticSnapshot(page, label, extra).catch(() => null);
}

/** Detect Cloudflare interstitials or unauthenticated login gates before treating failures as missing selectors. */
async function detectPageBlockingState(page, profileId) {
    const probe = await page.evaluate(() => {
        const title = (document.title ?? "").trim();
        const url = window.location.href;
        const bodyText = (document.body?.innerText ?? "").slice(0, 2000);
        const hasCfFrame = Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-running, .cf-turnstile, [data-cf-challenge]'));
        const isCfText = /just a moment|verify you are human|checking your browser|attention required/i.test(`${title}\n${bodyText}`);
        const hasComposer = Boolean(document.querySelector('#ask-input, main [role="textbox"][contenteditable="true"], [role="textbox"][contenteditable="true"], [role="textbox"], main textarea'));
        return { title, url, hasCfFrame, isCfText, hasComposer };
    }).catch(() => null);

    if (probe && (probe.hasCfFrame || (probe.isCfText && !probe.hasComposer))) {
        throw new PerplexityMcpError(
            ErrorCode.CLOUDFLARE_CHALLENGE,
            `Cloudflare anti-bot challenge detected on profile "${profileId}" (${probe.title || probe.url}). Run login({ profile: "${profileId}" }) or solve the check in the visible browser window.`,
            { stage: "page_ready", profile: profileId, recoverable: true, details: { title: probe.title, url: probe.url } }
        );
    }

    if (probe && !probe.hasComposer) {
        const authed = await checkSession(page);
        if (!authed) {
            throw new PerplexityMcpError(
                ErrorCode.LOGIN_REQUIRED,
                `Perplexity session on profile "${profileId}" is not signed in. Call login({ profile: "${profileId}" }) once to authenticate.`,
                { stage: "auth", profile: profileId, recoverable: true }
            );
        }
    }
}

async function waitForComposer(page, profileId, timeoutMs, signal) {
    throwIfAborted(signal, "page_ready", profileId);
    const initialBox = page.locator(INPUT_SELECTOR).first();
    try {
        await initialBox.waitFor({ state: "visible", timeout: timeoutMs });
    }
    catch (err) {
        throwIfAborted(signal, "page_ready", profileId);
        await detectPageBlockingState(page, profileId);
        const snapshotFiles = await captureFailureSnapshot(page, "missing-search-input", { profile: profileId, selector: INPUT_SELECTOR });
        throw new PerplexityMcpError(
            ErrorCode.SELECTOR_MISSING,
            `Search input box not visible on Perplexity (${INPUT_SELECTOR}): ${err instanceof Error ? err.message : String(err)}`,
            { stage: "page_ready", profile: profileId, recoverable: true, details: { selector: INPUT_SELECTOR, ...(snapshotFiles ? { snapshotFiles } : {}) }, cause: err }
        );
    }
}

async function getTurnCounts(page) {
    return page.evaluate(() => {
        const prosePanels = Array.from(document.querySelectorAll("main .prose"));
        for (const p of prosePanels) {
            p.setAttribute("data-mcp-old-prose", "1");
        }
        const lastProse = prosePanels.length > 0 ? prosePanels[prosePanels.length - 1] : null;
        const lastText = (lastProse?.textContent ?? "").trim();
        const lastProseSig = lastText ? `${lastText.length}:${lastText.slice(0, 200)}:${lastText.slice(-80)}` : "";
        const doneBtnCount = Array.from(document.querySelectorAll("main button")).filter((b) => {
            const aria = (b.getAttribute("aria-label") ?? "").toLowerCase();
            const txt = (b.textContent ?? "").trim();
            const rect = b.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && (aria === "fork" || /^finished\b/i.test(txt) || /\b\d+\s+sources?\b/i.test(txt));
        }).length;
        return { proseCount: prosePanels.length, doneBtnCount, lastProseSig };
    });
}

async function getThreadUrlFromPage(page) {
    const canonicalUrl = await page.evaluate(() =>
        document.querySelector('link[rel="canonical"]')?.getAttribute("href")
        ?? document.querySelector('meta[property="og:url"]')?.getAttribute("content")
        ?? null
    ).catch(() => null);
    const currentUrl = page.url();
    const isNonHome = (u) => typeof u === "string" && u.startsWith("https://www.perplexity.ai") && u.replace(/\/$/, "") !== "https://www.perplexity.ai";
    return isNonHome(currentUrl) ? currentUrl : (isNonHome(canonicalUrl) ? canonicalUrl : currentUrl);
}

async function runSearch(slot, query, timeoutMs, sources, model, threadUrl, runtimeOpts = {}) {
    const { signal, onProgress, outputFile = "" } = runtimeOpts;
    const startedAt = Date.now();
    const targetUrl = resolveTargetUrl(threadUrl);
    throwIfAborted(signal, "init", slot.id);

    await emitProgress(onProgress, { progress: 5, total: 100, message: `Launching browser on profile "${slot.id}"...` });
    await ensureBrowser({ slot });
    const page = await newSearchPage(slot);

    let streamingStarted = false;
    const preStreamAbortListener = () => {
        if (!streamingStarted) {
            void page.close().catch(() => { });
        }
    };
    signal?.addEventListener("abort", preStreamAbortListener, { once: true });

    let checkpointPath = null;
    try {
        throwIfAborted(signal, "navigating", slot.id);
        await emitProgress(onProgress, { progress: 12, total: 100, message: `Navigating to ${targetUrl}...` });
        log(`Navigating to ${targetUrl} (profile="${slot.id}")...`);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        await dismissDialogs(page);
        await waitForComposer(page, slot.id, 15_000, signal);

        if (threadUrl) {
            await page.locator("main .prose").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => { });
        }
        const initialCounts = threadUrl ? await getTurnCounts(page) : { proseCount: 0, doneBtnCount: 0 };

        const effectiveModel = model?.trim() || getDefaultModel();
        let modelUsed = null;
        if (effectiveModel) {
            throwIfAborted(signal, "selecting_model", slot.id);
            await emitProgress(onProgress, { progress: 20, total: 100, message: `Selecting model "${effectiveModel}"...` });
            log(`Selecting model: "${effectiveModel}"...`);
            modelUsed = await selectModel(page, effectiveModel, slot.id);
        }

        if (sources) {
            throwIfAborted(signal, "selecting_sources", slot.id);
            await emitProgress(onProgress, { progress: 25, total: 100, message: `Configuring sources [${sources.join(", ")}]...` });
            log(`Selecting sources: [${sources.join(", ")}]...`);
            await selectSources(page, sources, slot.id);
        }

        throwIfAborted(signal, "submitting", slot.id);
        await emitProgress(onProgress, { progress: 30, total: 100, message: "Submitting query..." });
        log("Typing query...");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(120);
        const searchBox = page.locator(INPUT_SELECTOR).first();
        await searchBox.waitFor({ state: "visible", timeout: 10_000 }).catch(async (err) => {
            await detectPageBlockingState(page, slot.id);
            const snapshotFiles = await captureFailureSnapshot(page, "missing-composer-submit", { profile: slot.id });
            throw new PerplexityMcpError(ErrorCode.SELECTOR_MISSING, `Composer box disappeared before typing query: ${err instanceof Error ? err.message : String(err)}`, {
                stage: "submitting",
                profile: slot.id,
                ...(snapshotFiles ? { details: { snapshotFiles } } : {}),
                cause: err,
            });
        });

        await safeClick(searchBox);
        await searchBox.fill(query);
        const currentText = await searchBox.evaluate((el) => ("value" in el ? el.value : el.textContent) ?? "").catch(() => "");
        if (!currentText.trim()) {
            await page.keyboard.insertText(query);
        }
        await page.waitForTimeout(80);
        await searchBox.press("Enter");
        await page.waitForTimeout(250);
        const remainingText = await searchBox.evaluate((el) => ("value" in el ? el.value : el.textContent) ?? "").catch(() => "");
        if (remainingText.trim()) {
            const submitBtn = page.locator('button[aria-label="Submit"]').first();
            if (await submitBtn.isVisible().catch(() => false) && await submitBtn.isEnabled().catch(() => false)) {
                await safeClick(submitBtn);
            }
        }

        streamingStarted = true;
        signal?.removeEventListener("abort", preStreamAbortListener);
        log("Waiting for answer to complete...");
        await emitProgress(onProgress, { progress: 35, total: 100, message: "Waiting for Perplexity response..." });

        const waitOutcome = await waitForAnswerComplete(page, timeoutMs, initialCounts, {
            signal,
            profileId: slot.id,
            query,
            model: modelUsed || effectiveModel,
            onProgress,
            onCheckpointCreated: (p) => { checkpointPath = p; },
        });
        checkpointPath = waitOutcome.checkpointPath ?? checkpointPath;

        await dismissDialogs(page);
        log("Extracting answer, sources, and claim provenance from DOM...");
        await emitProgress(onProgress, { progress: 94, total: 100, message: "Extracting answer and claim-level citations..." });

        const maxSources = resolveMaxSources();
        const extracted = await extractAnswerAndProvenance(page, maxSources);
        const renderedTurnCount = await page.evaluate(() => document.querySelectorAll("main .prose").length).catch(() => null);
        const virtualizedThread = Boolean(threadUrl && initialCounts.proseCount >= 2 && renderedTurnCount !== null && renderedTurnCount <= initialCounts.proseCount);
        const enrichedSources = await enrichCitationCards(page, extracted.sources, {
            signal,
            minProse: initialCounts.proseCount,
            maxSources,
        });
        const [attachments, finalThreadUrl] = await Promise.all([
            extractAttachments(page),
            getThreadUrlFromPage(page),
        ]);

        if (checkpointPath && !outputFile) {
            removeCheckpoint(checkpointPath);
        }

        await emitProgress(onProgress, { progress: 100, total: 100, message: "Done." });
        const durationMs = Date.now() - startedAt;
        log(`Done in ${durationMs}ms (profile="${slot.id}"). Answer: ${extracted.answer.length} chars, claims: ${extracted.claims.length}, sources: ${enrichedSources.length}, url: ${finalThreadUrl}`);
        return {
            answer: extracted.answer,
            sources: enrichedSources,
            claims: extracted.claims,
            attachments,
            threadUrl: finalThreadUrl,
            backend: "browser",
            profile: slot.id,
            modelUsed: modelUsed || null,
            turnCount: renderedTurnCount ?? undefined,
            virtualizedThread,
            partial: waitOutcome.timedOut,
            timedOut: waitOutcome.timedOut,
            durationMs,
        };
    }
    finally {
        signal?.removeEventListener("abort", preStreamAbortListener);
        await page.close().catch(() => { });
    }
}

async function selectSources(page, sources, profileId) {
    const targetIcons = sources.map((s) => SOURCE_ICON[s]).filter(Boolean);
    if (targetIcons.length === 0)
        return;

    const foundAdd = await page.evaluate((inputSel) => {
        for (const el of document.querySelectorAll('button[data-mcp-add-btn="true"]')) {
            el.removeAttribute("data-mcp-add-btn");
        }
        const isVis = (el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0;
        };
        const isAddCandidate = (b) => {
            if (!isVis(b) || b.closest('nav, aside, [class*="sidebar"]'))
                return false;
            const use = b.querySelector("use");
            const href = use?.getAttribute("xlink:href") ?? use?.getAttribute("href") ?? "";
            if (href === "#pplx-icon-plus")
                return true;
            const label = `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`.trim();
            return /add files|attach|plugins|connectors|\bmore\b/i.test(label);
        };
        let btn = null;
        const input = document.querySelector(inputSel);
        if (input) {
            let cur = input.parentElement;
            for (let depth = 0; cur && cur !== document.body && depth < 6; depth++) {
                const btns = Array.from(cur.querySelectorAll("button")).filter((b) => isVis(b) && !b.closest('nav, aside, [class*="sidebar"]'));
                const hasToolbarMarkers = btns.some((b) => /dictation|voice|submit|search|model/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`));
                if (hasToolbarMarkers) {
                    btn = btns.find(isAddCandidate) ?? null;
                    if (btn)
                        break;
                }
                cur = cur.parentElement;
            }
        }
        if (!btn) {
            btn = Array.from(document.querySelectorAll("button")).find(isAddCandidate) ?? null;
        }
        if (!btn)
            return false;
        btn.setAttribute("data-mcp-add-btn", "true");
        return btn.getAttribute("aria-label") ?? btn.textContent?.trim() ?? "add-btn";
    }, INPUT_SELECTOR);

    if (!foundAdd) {
        const snapshotFiles = await captureFailureSnapshot(page, "missing-add-button", { profile: profileId });
        throw new PerplexityMcpError(ErrorCode.SELECTOR_MISSING, "Could not find the + (add) button on Perplexity", {
            stage: "selecting_sources",
            profile: profileId,
            ...(snapshotFiles ? { details: { snapshotFiles } } : {}),
        });
    }

    await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-mcp-pre="1"]')) {
            el.removeAttribute("data-mcp-pre");
        }
        for (const el of document.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                el.setAttribute("data-mcp-pre", "1");
            }
        }
    });

    const addTrigger = page.locator('button[data-mcp-add-btn="true"]').first();
    await safeClick(addTrigger);

    const connDeadline = Date.now() + 2_500;
    let connProbe = { ok: false, seen: [], directBoxes: 0, expanded: null, ctrlId: null };
    while (Date.now() < connDeadline) {
        connProbe = await page.evaluate(() => {
            for (const el of document.querySelectorAll('[data-mcp-conn-item="true"]')) {
                el.removeAttribute("data-mcp-conn-item");
            }
            const addBtn = document.querySelector('button[data-mcp-add-btn="true"]');
            const expanded = addBtn?.getAttribute("aria-expanded") ?? null;
            const ctrlId = addBtn?.getAttribute("aria-controls") ?? null;
            const seenSet = new Set();
            const candidates = [];
            const addIfVisible = (el) => {
                if (seenSet.has(el) || el.closest('nav, aside, [class*="sidebar"]'))
                    return;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0)
                    return;
                const cs = getComputedStyle(el);
                if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0)
                    return;
                seenSet.add(el);
                candidates.push(el);
            };
            const roots = [];
            if (ctrlId) {
                const ctrlEl = document.getElementById(ctrlId);
                if (ctrlEl)
                    roots.push(ctrlEl);
            }
            roots.push(...document.querySelectorAll('[data-radix-popper-content-wrapper], [data-floating-ui-portal], [role="menu"], [role="dialog"], [role="listbox"], [data-state="open"]'));
            for (const root of new Set(roots)) {
                for (const el of root.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="checkbox"], [role="switch"], [role="option"], [role="button"], button, a, label')) {
                    addIfVisible(el);
                }
            }
            for (const el of document.querySelectorAll('button:not([data-mcp-pre="1"]), a:not([data-mcp-pre="1"]), label:not([data-mcp-pre="1"]), [role="menuitem"]:not([data-mcp-pre="1"]), [role="menuitemcheckbox"]:not([data-mcp-pre="1"]), [role="checkbox"]:not([data-mcp-pre="1"]), [role="switch"]:not([data-mcp-pre="1"]), [role="option"]:not([data-mcp-pre="1"]), [role="button"]:not([data-mcp-pre="1"]), [tabindex]:not([data-mcp-pre="1"])')) {
                addIfVisible(el);
            }
            const directBoxes = candidates.filter((el) => {
                const role = el.getAttribute("role");
                return role === "menuitemcheckbox" || role === "checkbox" || role === "switch" || el.tagName === "INPUT";
            }).length;
            if (candidates.length === 0) {
                return { ok: false, seen: [], directBoxes, expanded, ctrlId, ready: false };
            }
            const item = candidates.find((el) => {
                const use = el.querySelector("use");
                const href = use?.getAttribute("xlink:href") ?? use?.getAttribute("href") ?? "";
                return href === "#pplx-icon-plug";
            }) ?? candidates.find((el) => /sources?|connectors?|connecteurs|set sources/i.test(`${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`));
            if (!item) {
                const seen = candidates.map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 15);
                return { ok: false, seen, directBoxes, expanded, ctrlId, ready: true };
            }
            item.setAttribute("data-mcp-conn-item", "true");
            return { ok: true, seen: [], directBoxes, expanded, ctrlId, ready: true };
        });
        if (connProbe.ok || connProbe.directBoxes > 0 || (connProbe.ready && connProbe.seen.length > 0))
            break;
        await page.waitForTimeout(150);
    }

    await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-mcp-pre="1"]')) {
            el.removeAttribute("data-mcp-pre");
        }
    });

    if (!connProbe.ok) {
        if (connProbe.directBoxes === 0) {
            const snapshotFiles = await captureFailureSnapshot(page, "missing-connectors-menu", { profile: profileId, seen: connProbe.seen });
            throw new PerplexityMcpError(
                ErrorCode.SELECTOR_MISSING,
                `Could not find Sources/Connectors menuitem after clicking "${foundAdd}"`,
                {
                    stage: "selecting_sources",
                    profile: profileId,
                    details: { expanded: connProbe.expanded, ctrlId: connProbe.ctrlId, seen: connProbe.seen, ...(snapshotFiles ? { snapshotFiles } : {}) },
                }
            );
        }
    }
    else {
        await safeClick(page.locator('[data-mcp-conn-item="true"]').first());
    }

    await page.locator('[role="menuitemcheckbox"], [role="checkbox"], [role="switch"], input[type="checkbox"]').first().waitFor({ state: "visible", timeout: 3_000 });

    const fallbackLabels = {
        "#pplx-icon-world": /\bweb\b/i,
        "#pplx-icon-books": /\bacademic|scholar/i,
        "#pplx-icon-social": /\bsocial|reddit/i,
    };
    const allIcons = Object.values(SOURCE_ICON);
    for (const icon of allIcons) {
        const shouldBeChecked = targetIcons.includes(icon);
        const state = await page.evaluate(({ iconId, labelPattern }) => {
            for (const el of document.querySelectorAll('[data-mcp-src-item="true"]')) {
                el.removeAttribute("data-mcp-src-item");
            }
            const boxes = Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="checkbox"], [role="switch"], input[type="checkbox"]'));
            const re = new RegExp(labelPattern, "i");
            const item = boxes.find((el) => {
                const use = el.querySelector("use");
                const href = use?.getAttribute("xlink:href") ?? use?.getAttribute("href") ?? "";
                return href === iconId;
            }) ?? boxes.find((el) => re.test((el.getAttribute("aria-label") ?? "") + " " + (el.textContent ?? "")));
            if (!item)
                return null;
            item.setAttribute("data-mcp-src-item", "true");
            const checked = ("checked" in item && typeof item.checked === "boolean" && item.checked)
                || item.getAttribute("aria-checked") === "true"
                || item.getAttribute("data-state") === "checked";
            return { checked };
        }, { iconId: icon, labelPattern: fallbackLabels[icon].source });
        if (!state)
            continue;
        if (state.checked !== shouldBeChecked) {
            await safeClick(page.locator('[data-mcp-src-item="true"]').first());
            await page.waitForTimeout(200);
        }
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
}

async function openModelMenu(page, profileId) {
    const markModelBtnScript = (inputSel) => {
        for (const el of document.querySelectorAll('button[data-mcp-model-btn="true"]')) {
            el.removeAttribute("data-mcp-model-btn");
        }
        const isVisible = (btn) => {
            const rect = btn.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0)
                return false;
            const cs = getComputedStyle(btn);
            return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0;
        };
        const isExcluded = (btn) => {
            if (!isVisible(btn))
                return true;
            if (btn.closest('nav, aside, [class*="sidebar"]'))
                return true;
            const aria = btn.getAttribute("aria-label") ?? "";
            const txt = (btn.textContent ?? "").trim();
            if (/add files|attach|dictation|voice|mic|submit|search|computer|connectors|session actions/i.test(aria + " " + txt))
                return true;
            const use = btn.querySelector("use");
            const href = use?.getAttribute("xlink:href") ?? use?.getAttribute("href") ?? "";
            return href === "#pplx-icon-plus";
        };
        const isMenuTrigger = (btn) => btn.getAttribute("aria-haspopup") === "menu"
            || btn.hasAttribute("aria-controls")
            || (btn.getAttribute("aria-label") ?? "") === "Model";
        const looksLikeModelBtn = (btn) => {
            const label = `${btn.getAttribute("aria-label") ?? ""} ${btn.textContent ?? ""}`.replace(/\s+/g, " ").trim();
            if (!label || label.length > 80)
                return false;
            return /\b(?:gpt|claude|gemini|grok|kimi|glm|nemotron|sonar|deepseek)\b/i.test(label)
                || /^model\b/i.test(label)
                || /^(?:model\s+)?best$/i.test(label);
        };
        const isComposerModelBtn = (btn) => !isExcluded(btn) && isMenuTrigger(btn) && ((btn.getAttribute("aria-label") ?? "") === "Model" || looksLikeModelBtn(btn));
        const pickCandidate = (btns) => {
            const menuCandidates = btns.filter((b) => !isExcluded(b) && isMenuTrigger(b));
            return menuCandidates.find((b) => (b.getAttribute("aria-label") ?? "") === "Model")
                ?? menuCandidates.find(looksLikeModelBtn)
                ?? menuCandidates[0]
                ?? null;
        };
        const input = document.querySelector(inputSel);
        if (input) {
            let cur = input.parentElement;
            for (let depth = 0; cur && cur !== document.body && depth < 6; depth++) {
                const btns = Array.from(cur.querySelectorAll("button"));
                const hasToolbarMarkers = btns.some((b) => isVisible(b) && /dictation|voice|submit|add files|attach|search/i.test((b.getAttribute("aria-label") ?? "") + " " + (b.textContent ?? "")));
                if (hasToolbarMarkers) {
                    const candidate = pickCandidate(btns);
                    if (candidate) {
                        candidate.setAttribute("data-mcp-model-btn", "true");
                        return true;
                    }
                }
                cur = cur.parentElement;
            }
        }
        const allButtons = Array.from(document.querySelectorAll("button"));
        const fallback = allButtons.find((b) => !isExcluded(b) && (b.getAttribute("aria-label") ?? "") === "Model")
            ?? allButtons.find(isComposerModelBtn);
        if (fallback) {
            fallback.setAttribute("data-mcp-model-btn", "true");
            return true;
        }
        return false;
    };

    let found = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        found = await page.evaluate(markModelBtnScript, INPUT_SELECTOR);
        if (found)
            break;
        await page.waitForTimeout(250);
    }
    if (!found) {
        await detectPageBlockingState(page, profileId);
        const snapshotFiles = await captureFailureSnapshot(page, "missing-model-button", { profile: profileId });
        throw new PerplexityMcpError(ErrorCode.SELECTOR_MISSING, "Could not find the Model selector button on Perplexity.", {
            stage: "selecting_model",
            profile: profileId,
            ...(snapshotFiles ? { details: { snapshotFiles } } : {}),
        });
    }
    let trigger = page.locator('button[data-mcp-model-btn="true"]').first();
    try {
        try {
            await safeClick(trigger, 5_000);
        }
        catch {
            await page.waitForTimeout(300);
            await page.evaluate(markModelBtnScript, INPUT_SELECTOR);
            trigger = page.locator('button[data-mcp-model-btn="true"]').first();
            await safeClick(trigger, 5_000);
        }
        const rawCurrent = (await trigger.innerText().catch(() => "")).trim() || (await trigger.getAttribute("aria-label").catch(() => "")) || "Model";
        const currentModel = rawCurrent.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^model$/i.test(s))[0] || rawCurrent;
        const controlsId = await trigger.getAttribute("aria-controls").catch(() => null);
        const menuLocator = controlsId
            ? page.locator(`[id="${controlsId}"]`)
            : page.locator('[role="menu"][data-state="open"]').last();
        await menuLocator.waitFor({ state: "visible", timeout: 5_000 });
        return { currentModel, menuLocator };
    }
    catch (err) {
        const snapshotFiles = await captureFailureSnapshot(page, "model-menu-open-failed", { profile: profileId });
        throw new PerplexityMcpError(
            ErrorCode.SELECTOR_MISSING,
            `Failed opening Model selector menu on profile "${profileId}": ${err instanceof Error ? err.message : String(err)}`,
            { stage: "selecting_model", profile: profileId, ...(snapshotFiles ? { details: { snapshotFiles } } : {}), cause: err }
        );
    }
}

async function readModelsFromOpenMenu(menuLocator) {
    return menuLocator.evaluate((menu) => {
        const items = Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]'));
        return items.map((el, index) => {
            const lines = (el.innerText ?? "")
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean);
            const name = lines[0] ?? "";
            const badgeLines = lines.slice(1);
            const isMax = badgeLines.some((l) => /^max$/i.test(l));
            const notes = badgeLines.join(" · ");
            const ariaDisabled = el.getAttribute("aria-disabled");
            const dataDisabled = el.getAttribute("data-disabled");
            const disabled = ariaDisabled === "true" || (dataDisabled !== null && dataDisabled !== "false") || isMax;
            const selected = el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked";
            return { index, name, notes, selected, disabled, isMax };
        }).filter((m) => m.name.length > 0);
    });
}

function findModelMatch(models, modelName) {
    const needle = modelName.trim().toLowerCase();
    return models.find((m) => m.name.toLowerCase() === needle)
        ?? models.find((m) => `${m.name} ${m.notes}`.toLowerCase() === needle)
        ?? models.find((m) => m.name.toLowerCase().includes(needle))
        ?? models.find((m) => `${m.name} ${m.notes}`.toLowerCase().includes(needle));
}

async function openHydratedModelMenu(page, profileId) {
    const deadline = Date.now() + 6_000;
    while (true) {
        const { currentModel, menuLocator } = await openModelMenu(page, profileId);
        const models = await readModelsFromOpenMenu(menuLocator);
        if (models.length > 1 || Date.now() + 600 >= deadline) {
            return { currentModel, menuLocator, models };
        }
        await page.keyboard.press("Escape").catch(() => { });
        await page.waitForTimeout(500);
    }
}

async function readActiveModelLabel(page) {
    return page.evaluate((inputSel) => {
        const isVisible = (btn) => {
            const rect = btn.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(btn).display !== "none" && getComputedStyle(btn).visibility !== "hidden";
        };
        const isMenu = (b) => b.getAttribute("aria-haspopup") === "menu" || b.hasAttribute("aria-controls") || (b.getAttribute("aria-label") ?? "") === "Model";
        const isCandidate = (b) => isVisible(b) && !b.closest('nav, aside, [class*="sidebar"]') && isMenu(b) && !/add files|attach|session actions/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`);
        const input = document.querySelector(inputSel);
        if (input) {
            let cur = input.parentElement;
            for (let d = 0; cur && cur !== document.body && d < 6; d++) {
                const match = Array.from(cur.querySelectorAll("button")).find(isCandidate);
                if (match)
                    return (match.innerText || "").trim();
                cur = cur.parentElement;
            }
        }
        const fallback = Array.from(document.querySelectorAll("button")).find((b) => isCandidate(b) && ((b.getAttribute("aria-label") ?? "") === "Model"));
        return fallback ? (fallback.innerText || "").trim() : "";
    }, INPUT_SELECTOR).catch(() => "");
}

async function selectModel(page, modelName, profileId) {
    // Skip expensive menu click+hydration when the composer chip already displays the requested model.
    const needle = modelName.trim().toLowerCase();
    const activeRaw = await readActiveModelLabel(page);
    if (activeRaw) {
        const activeLines = activeRaw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^model$/i.test(s));
        const primary = activeLines[0] ?? "";
        if (primary && primary.toLowerCase() === needle) {
            log(`Model "${primary}" already active; skipping menu open.`);
            return primary;
        }
    }

    const { menuLocator, models } = await openHydratedModelMenu(page, profileId);
    const availableModels = models.filter((m) => !m.disabled && !m.isMax);
    const match = findModelMatch(availableModels, modelName) ?? findModelMatch(models, modelName);
    const availableList = availableModels.map((m) => m.notes ? `${m.name} (${m.notes})` : m.name);
    if (!match) {
        await page.keyboard.press("Escape").catch(() => { });
        throw new PerplexityMcpError(
            ErrorCode.MODEL_UNAVAILABLE,
            `Model "${modelName}" not found. Available models: ${availableList.join(", ")}`,
            { stage: "selecting_model", profile: profileId, details: { requested: modelName, available: availableList } }
        );
    }
    if (match.disabled || match.isMax) {
        await page.keyboard.press("Escape").catch(() => { });
        throw new PerplexityMcpError(
            ErrorCode.MODEL_UNAVAILABLE,
            `Model "${match.name}" is excluded/unavailable on your current Perplexity plan (${match.notes || "Max/restricted"}). Available models: ${availableList.join(", ")}`,
            { stage: "selecting_model", profile: profileId, details: { requested: modelName, matched: match.name, available: availableList } }
        );
    }
    if (!match.selected) {
        const item = menuLocator.locator('[role="menuitemradio"], [role="menuitem"], [role="option"]').nth(match.index);
        await safeClick(item);
        await page.waitForTimeout(150);
    }
    await page.keyboard.press("Escape").catch(() => { });
    await page.waitForTimeout(100);
    return match.name;
}

async function dismissDialogs(page) {
    // Fast single-roundtrip check avoids multi-second locator timeouts when no overlays exist.
    const found = await page.evaluate(() => {
        const isVis = (b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(b).display !== "none" && getComputedStyle(b).visibility !== "hidden";
        };
        const consentBtns = Array.from(document.querySelectorAll('[data-testid="consent-dialog"] button'));
        const consent = consentBtns.find((b) => isVis(b) && /^(?:Decline optional|Got it|Accept all|Cookies nécessaires|Necessary cookies)$/i.test((b.textContent ?? "").trim()));
        if (consent) {
            consent.click();
            return "consent";
        }
        const btns = Array.from(document.querySelectorAll("button"));
        const cookie = btns.find((b) => isVis(b) && /^(?:Cookies nécessaires|Necessary cookies)$/i.test((b.textContent ?? "").trim()));
        if (cookie) {
            cookie.click();
            return "cookie";
        }
        const close = btns.find((b) => isVis(b) && (/^(?:Fermer)$/i.test((b.textContent ?? "").trim()) || /^(?:Close|Fermer)$/i.test((b.getAttribute("aria-label") ?? "").trim())) && b.closest('[role="dialog"], [data-testid="consent-dialog"]'));
        if (close) {
            close.click();
            return "close";
        }
        return null;
    }).catch(() => null);
    if (found) {
        log(`Dismissed ${found} overlay.`);
        await page.waitForTimeout(150);
    }
}

async function savePartialCheckpointSafe(page, fallbackText, opts, existingPath, statusLabel) {
    const extractWithTimeout = (promise, ms) => Promise.race([
        promise.catch(() => null),
        new Promise((res) => setTimeout(() => res(null), ms)),
    ]);
    const maxSources = resolveMaxSources();
    const [extracted, threadUrl] = await Promise.all([
        extractWithTimeout(extractAnswerAndProvenance(page, maxSources), 1500),
        extractWithTimeout(getThreadUrlFromPage(page), 800),
    ]);
    const answerText = (extracted?.answer && extracted.answer.trim()) ? extracted.answer : fallbackText;
    const savedPath = writeCheckpoint(
        {
            answer: answerText,
            sources: extracted?.sources || [],
            claims: extracted?.claims || [],
            threadUrl: threadUrl || "",
            backend: "browser",
            profile: opts.profileId,
            modelUsed: opts.model || null,
        },
        { query: opts.query, model: opts.model, statusLabel, existingPath }
    );
    if (savedPath && opts.onCheckpointCreated) {
        opts.onCheckpointCreated(savedPath);
    }
    return { savedPath, partialChars: (answerText || "").length, threadUrl: threadUrl || null };
}

async function waitForAnswerComplete(page, timeoutMs, initialCounts = { proseCount: 0, doneBtnCount: 0, lastProseSig: "" }, hooks = {}) {
    const { signal, profileId = "default", query = "", model = "", onProgress, onCheckpointCreated } = hooks;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastText = "";
    let lastChangedAt = startedAt;
    let lastProgressAt = startedAt;
    let lastCheckpointAt = startedAt;
    let lastCheckpointRaw = "";
    let checkpointPath = null;
    let sawStopBtn = false;

    const recordCheckpoint = (p) => {
        checkpointPath = p;
        if (onCheckpointCreated)
            onCheckpointCreated(p);
    };

    while (Date.now() < deadline) {
        if (signal?.aborted) {
            const snap = await savePartialCheckpointSafe(
                page,
                lastText,
                { profileId, query, model, onCheckpointCreated: recordCheckpoint },
                checkpointPath,
                "cancelled"
            );
            throw new PerplexityMcpError(
                ErrorCode.CANCELLED,
                snap.savedPath
                    ? `Request cancelled by MCP client; saved ${snap.partialChars} accumulated chars to checkpoint file.`
                    : "Request cancelled by MCP client before any answer text streamed.",
                {
                    stage: "streaming",
                    profile: profileId,
                    checkpointFile: snap.savedPath ?? undefined,
                    partialChars: snap.partialChars,
                    threadUrl: snap.threadUrl ?? undefined,
                }
            );
        }

        const state = await page.evaluate((baseline) => {
            const prosePanels = Array.from(document.querySelectorAll("main .prose"));
            let panel = null;
            if (prosePanels.length > baseline.proseCount) {
                panel = prosePanels[prosePanels.length - 1];
            }
            else if (prosePanels.length > 0) {
                // On virtualized long threads Perplexity unmounts older turns while rendering new ones,
                // so proseCount can stay flat (e.g. 2 -> 2). Detect freshly mounted or changed tail panels.
                const fresh = prosePanels.filter((p) => !p.hasAttribute("data-mcp-old-prose"));
                const candidate = fresh.length > 0 ? fresh[fresh.length - 1] : prosePanels[prosePanels.length - 1];
                const candText = (candidate?.textContent ?? "").trim();
                const candSig = candText ? `${candText.length}:${candText.slice(0, 200)}:${candText.slice(-80)}` : "";
                if (!baseline.lastProseSig || (candText.length > 0 && candSig !== baseline.lastProseSig)) {
                    panel = candidate;
                }
            }
            else if (baseline.proseCount === 0) {
                panel = document.querySelector('[role="tabpanel"]');
            }
            const text = (panel?.textContent ?? "").trim();
            const btns = Array.from(document.querySelectorAll("main button"));
            const hasStopBtn = btns.some((b) => {
                const rect = b.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0)
                    return false;
                const cs = getComputedStyle(b);
                if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0)
                    return false;
                const aria = (b.getAttribute("aria-label") ?? "").trim().toLowerCase();
                const txt = (b.textContent ?? "").trim().toLowerCase();
                return /\bstop\s*(?:generating|streaming|response|task|search)\b/.test(aria)
                    || aria === "stop"
                    || txt === "stop"
                    || txt === "stop generating";
            });
            const doneBtnCount = btns.filter((b) => {
                const aria = (b.getAttribute("aria-label") ?? "").toLowerCase();
                const txt = (b.textContent ?? "").trim();
                const rect = b.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0)
                    return false;
                return aria === "fork" || /^finished\b/i.test(txt) || /\b\d+\s+sources?\b/i.test(txt);
            }).length;
            const mainTxt = !text ? (document.querySelector("main")?.innerText ?? "") : "";
            const creditBlocked = !text && /you need more credits to continue|add credits to your account/i.test(mainTxt);
            return { text, hasStopBtn, doneBtnCount, creditBlocked };
        }, initialCounts).catch(() => ({ text: lastText, hasStopBtn: false, doneBtnCount: initialCounts.doneBtnCount, creditBlocked: false }));

        if (state.creditBlocked && !lastText) {
            const snapshotFiles = await captureFailureSnapshot(page, "credits-required", { profile: profileId, query: query.slice(0, 120) });
            const threadUrl = await getThreadUrlFromPage(page).catch(() => null);
            throw new PerplexityMcpError(
                ErrorCode.MODEL_UNAVAILABLE,
                "Perplexity task requires additional account credits ('You need more credits to continue'). Switch models or top up credits in Perplexity.",
                {
                    stage: "streaming",
                    profile: profileId,
                    recoverable: true,
                    threadUrl: threadUrl ?? undefined,
                    ...(snapshotFiles ? { details: { snapshotFiles } } : {}),
                }
            );
        }
        if (state.hasStopBtn)
            sawStopBtn = true;
        if (state.text !== lastText) {
            lastText = state.text;
            lastChangedAt = Date.now();
        }
        const now = Date.now();
        const idleMs = now - lastChangedAt;
        if (state.text.length > 0 && !state.hasStopBtn) {
            if ((state.doneBtnCount > initialCounts.doneBtnCount || sawStopBtn) && idleMs >= 600) {
                return { timedOut: false, checkpointPath };
            }
            if (idleMs >= 1500) {
                return { timedOut: false, checkpointPath };
            }
        }
        if (state.text.length > 0 && state.doneBtnCount > initialCounts.doneBtnCount && idleMs >= 3000) {
            return { timedOut: false, checkpointPath };
        }

        if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
            lastProgressAt = now;
            const elapsedMs = now - startedAt;
            const elapsedSec = Math.round(elapsedMs / 1000);
            const pct = Math.min(95, 35 + Math.round((elapsedMs / Math.max(timeoutMs, 1)) * 55));
            await emitProgress(onProgress, {
                progress: pct,
                total: 100,
                message: state.text.length > 0
                    ? `Streaming answer (${elapsedSec}s elapsed, ${state.text.length} chars)...`
                    : `Thinking / searching web (${elapsedSec}s elapsed)...`,
            });
        }

        if (now - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS && lastText.length > 0 && lastText !== lastCheckpointRaw) {
            lastCheckpointAt = now;
            lastCheckpointRaw = lastText;
            await savePartialCheckpointSafe(
                page,
                lastText,
                { profileId, query, model, onCheckpointCreated: recordCheckpoint },
                checkpointPath,
                "partial-checkpoint"
            );
        }

        await page.waitForTimeout(250);
    }

    if (!lastText) {
        await detectPageBlockingState(page, profileId);
        const snapshotFiles = await captureFailureSnapshot(page, "answer-timeout", { profile: profileId, query: query.slice(0, 120) });
        const threadUrl = await getThreadUrlFromPage(page).catch(() => null);
        throw new PerplexityMcpError(ErrorCode.TIMEOUT, `Timed out after ${timeoutMs}ms waiting for Perplexity answer`, {
            stage: "streaming",
            profile: profileId,
            threadUrl: threadUrl ?? undefined,
            ...(snapshotFiles ? { details: { snapshotFiles } } : {}),
        });
    }
    log("Timeout reached with partial answer; returning accumulated text.");
    return { timedOut: true, checkpointPath };
}

/**
 * Extract formatted answer text preserving inline [1], [2] citation references,
 * sentence-level claim->source provenance, and deduplicated source URLs from both
 * Perplexity citation chips ([data-pplx-citation-url]) and anchor tags.
 */
async function extractAnswerAndProvenance(page, maxSources = DEFAULT_MAX_SOURCES) {
    return page.evaluate((limit) => {
        const prosePanels = document.querySelectorAll("main .prose");
        const panel = prosePanels.length > 0
            ? prosePanels[prosePanels.length - 1]
            : document.querySelector('[role="tabpanel"]');
        if (!panel) {
            return { answer: "", sources: [], claims: [] };
        }

        const sources = [];
        const urlToIndex = new Map();
        const registerUrl = (rawUrl, hintTitle = "") => {
            if (!rawUrl || typeof rawUrl !== "string")
                return null;
            let cleanUrl = rawUrl.trim();
            if (!/^https?:\/\//i.test(cleanUrl) || cleanUrl.includes("perplexity.ai"))
                return null;
            if (urlToIndex.has(cleanUrl)) {
                return urlToIndex.get(cleanUrl);
            }
            if (limit > 0 && sources.length >= limit)
                return null;
            let domain = "";
            try {
                domain = new URL(cleanUrl).hostname;
            }
            catch {
                domain = "";
            }
            const idx = sources.length + 1;
            const title = (hintTitle || domain || cleanUrl).replace(/\s+/g, " ").trim();
            sources.push({ index: idx, title, url: cleanUrl, ...(domain ? { domain } : {}) });
            urlToIndex.set(cleanUrl, idx);
            return idx;
        };

        function collectCitationUrls(el) {
            const urls = [];
            const selfUrl = el.getAttribute("data-pplx-citation-url") || el.getAttribute("href");
            if (selfUrl)
                urls.push({ url: selfUrl, title: el.getAttribute("aria-label") || "" });
            for (const sub of Array.from(el.querySelectorAll('[data-pplx-citation-url], a[href^="http"]'))) {
                const u = sub.getAttribute("data-pplx-citation-url") || sub.getAttribute("href");
                if (u)
                    urls.push({ url: u, title: sub.getAttribute("aria-label") || "" });
            }
            return urls;
        }

        function getTextAndCitations(el, claimIndicesSet, claimUrlsSet) {
            let text = "";
            for (const node of Array.from(el.childNodes)) {
                if (node.nodeType === Node.TEXT_NODE) {
                    text += node.textContent ?? "";
                }
                else if (node.nodeType === Node.ELEMENT_NODE) {
                    const child = node;
                    const isCitationChip = child.hasAttribute("data-pplx-citation")
                        || child.hasAttribute("data-pplx-citation-url")
                        || child.classList?.contains("citation");
                    if (isCitationChip) {
                        const rawCitations = collectCitationUrls(child);
                        const chipIndices = [];
                        for (const item of rawCitations) {
                            const idx = registerUrl(item.url, item.title);
                            if (idx !== null) {
                                if (!chipIndices.includes(idx))
                                    chipIndices.push(idx);
                                claimIndicesSet?.add(idx);
                                claimUrlsSet?.add(item.url);
                            }
                        }
                        if (chipIndices.length > 0) {
                            const marker = `[${chipIndices.join(",")}]`;
                            text = text.replace(/\s+$/, "") + ` ${marker}`;
                        }
                        continue;
                    }
                    if (child.tagName === "A") {
                        const href = child.getAttribute("href") || "";
                        const anchorText = (child.textContent ?? "").trim();
                        const idx = registerUrl(href, anchorText);
                        if (idx !== null) {
                            claimIndicesSet?.add(idx);
                            claimUrlsSet?.add(href);
                        }
                        text += anchorText;
                        continue;
                    }
                    const style = window.getComputedStyle(child);
                    const isLeafUiBadge = style.cursor === "pointer"
                        && (child.textContent?.trim().length ?? 0) < 40
                        && !child.querySelector('a, [data-pplx-citation], [data-pplx-citation-url], .citation, strong, em, code');
                    if (isLeafUiBadge && (child.tagName === "BUTTON" || /\+\d+$/.test((child.textContent ?? "").trim()))) {
                        continue;
                    }
                    text += getTextAndCitations(child, claimIndicesSet, claimUrlsSet);
                }
            }
            return text;
        }

        const parts = [];
        const claims = [];
        const seen = new Set();
        const seenTables = new Set();

        const recordBlockClaims = (text, blockCitations) => {
            if (blockCitations.size === 0)
                return;
            // Split multi-sentence blocks at sentence punctuation right after inline [n] markers so each claim binds cleanly.
            const segments = text.split(/(?<=\[\d+(?:,\d+)*\][.!?]?)\s+(?=[A-Z0-9"'`(])/).map((s) => s.trim()).filter(Boolean);
            const units = segments.length > 1 ? segments : [text];
            for (const unit of units) {
                const segRefs = Array.from(unit.matchAll(/\[(\d+(?:,\d+)*)\]/g));
                const citeNums = [];
                const seenNums = new Set();
                if (segRefs.length > 0) {
                    for (const m of segRefs) {
                        for (const numStr of m[1].split(",")) {
                            const n = Number.parseInt(numStr.trim(), 10);
                            if (Number.isFinite(n) && !seenNums.has(n)) {
                                seenNums.add(n);
                                citeNums.push(n);
                            }
                        }
                    }
                }
                else {
                    for (const n of blockCitations) {
                        if (!seenNums.has(n)) {
                            seenNums.add(n);
                            citeNums.push(n);
                        }
                    }
                }
                if (citeNums.length > 0) {
                    claims.push({
                        index: claims.length + 1,
                        text: unit,
                        citations: citeNums,
                        urls: citeNums.map((n) => sources[n - 1]?.url).filter(Boolean),
                    });
                }
            }
        };

        panel.querySelectorAll("h1, h2, h3, h4, p, li, pre code, tr").forEach((el) => {
            if (el.tagName !== "TR" && el.closest("tr"))
                return;
            if (el.tagName === "P" && el.closest("li"))
                return;
            if (el.tagName === "LI" && el.querySelector("li"))
                return;
            const tag = el.tagName.toLowerCase();
            if (tag === "tr") {
                const rowCitations = new Set();
                const cells = Array.from(el.querySelectorAll("th, td"))
                    .map((cell) => getTextAndCitations(cell, rowCitations).trim().replace(/\s+/g, " "))
                    .filter(Boolean);
                const rowText = cells.join(" | ");
                if (rowText && !seen.has(rowText)) {
                    seen.add(rowText);
                    const tableEl = el.closest("table");
                    const isFirstRow = tableEl ? !seenTables.has(tableEl) : false;
                    if (tableEl && isFirstRow) {
                        seenTables.add(tableEl);
                        parts.push(`\n| ${rowText} |`);
                        parts.push(`| ${cells.map(() => "---").join(" | ")} |`);
                    }
                    else {
                        parts.push(`| ${rowText} |`);
                    }
                    if (rowCitations.size > 0) {
                        recordBlockClaims(`| ${rowText} |`, rowCitations);
                    }
                }
                return;
            }
            if (tag === "code") {
                const codeText = (el.textContent ?? "").replace(/^\n+|\n+$/g, "");
                if (!codeText.trim() || seen.has(codeText))
                    return;
                seen.add(codeText);
                const langMatch = (el.className || "").match(/language-([a-z0-9_+-]+)/i);
                const lang = langMatch ? langMatch[1] : "";
                parts.push(`\`\`\`${lang}\n${codeText}\n\`\`\``);
                return;
            }
            const blockCitations = new Set();
            const text = getTextAndCitations(el, blockCitations).trim().replace(/\s+/g, " ");
            if (!text || seen.has(text))
                return;
            seen.add(text);
            if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
                parts.push(`\n## ${text}\n`);
            }
            else if (tag === "li") {
                parts.push(`- ${text}`);
                recordBlockClaims(text, blockCitations);
            }
            else {
                parts.push(text);
                recordBlockClaims(text, blockCitations);
            }
        });

        // Harvest any remaining citations or external links in the turn/main area not yet registered inline.
        for (const el of Array.from(panel.querySelectorAll("[data-pplx-citation-url]"))) {
            registerUrl(el.getAttribute("data-pplx-citation-url"), el.getAttribute("aria-label") || "");
        }
        const turnLinks = Array.from(panel.querySelectorAll('a[href^="http"]'));
        const mainLinks = Array.from(document.querySelectorAll('main a[href^="http"]'));
        for (const link of [...turnLinks, ...mainLinks]) {
            registerUrl(link.href, link.textContent?.trim() || link.getAttribute("aria-label")?.trim() || "");
        }

        const answer = parts.length === 0 ? (panel.textContent ?? "").trim() : parts.join("\n").trim();
        return { answer, sources, claims };
    }, maxSources);
}

/**
 * Best-effort hover enrichment over top inline citation pills (<=5 pills, <=1.8s total budget)
 * to recover page titles, snippets, dates, and multi-source secondary URLs from Radix popovers.
 */
async function enrichCitationCards(page, sources, { signal, minProse = 0, maxSources = DEFAULT_MAX_SOURCES, maxHover = 5 } = {}) {
    if (!Array.isArray(sources) || signal?.aborted)
        return sources;

    const pillCount = await page.evaluate((minP) => {
        const prosePanels = document.querySelectorAll("main .prose");
        const panel = prosePanels.length > minP ? prosePanels[prosePanels.length - 1] : prosePanels[prosePanels.length - 1];
        if (!panel)
            return 0;
        const seenUrls = new Set();
        let idx = 0;
        for (const old of document.querySelectorAll('[data-mcp-cite-idx]')) {
            old.removeAttribute("data-mcp-cite-idx");
        }
        for (const el of Array.from(panel.querySelectorAll('[data-pplx-citation][data-pplx-citation-url]'))) {
            const url = el.getAttribute("data-pplx-citation-url") || "";
            if (!url || seenUrls.has(url))
                continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0)
                continue;
            seenUrls.add(url);
            el.setAttribute("data-mcp-cite-idx", String(idx++));
        }
        return idx;
    }, minProse).catch(() => 0);

    if (pillCount === 0)
        return sources;

    const byUrl = new Map(sources.map((s) => [s.url, s]));
    const budgetDeadline = Date.now() + 1_800;
    const targetCount = Math.min(pillCount, maxHover);

    try {
        for (let i = 0; i < targetCount; i++) {
            if (signal?.aborted || Date.now() >= budgetDeadline)
                break;
            const pill = page.locator(`[data-mcp-cite-idx="${i}"]`).first();
            const isVis = await pill.isVisible().catch(() => false);
            if (!isVis)
                continue;
            await pill.hover({ force: true, timeout: 400 }).catch(() => { });
            await page.waitForTimeout(160);
            const cardData = await page.evaluate(() => {
                const pops = Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper] [data-state="open"], [role="dialog"], [role="tooltip"]'))
                    .filter((el) => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0
                        && !el.closest('[data-testid="consent-dialog"]')
                        && !el.querySelector('[data-testid="consent-dialog"]');
                });
                if (pops.length === 0)
                    return null;
                const pop = pops[pops.length - 1];
                const anchors = Array.from(pop.querySelectorAll('a[href^="http"]')).filter((a) => !a.href.includes("perplexity.ai"));
                if (anchors.length === 0)
                    return null;
                const primaryUrl = anchors[0].href;
                const lines = (pop.innerText ?? "")
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter((s) => s && !/^(?:\d+\/\d+|\d+\s+sources?|trusted)$/i.test(s) && !/is trusted for|rate this source|learn more/i.test(s));
                // Heuristic: after optional domain tag line, first descriptive line is title, following line(s) snippet
                const filtered = lines.filter((l) => l.length > 2);
                const domainHint = filtered[0] && !/\s/.test(filtered[0]) ? filtered.shift() : "";
                const title = filtered[0] || domainHint || "";
                const snippet = filtered.slice(1).join(" ").replace(/\s+/g, " ").trim().slice(0, 320);
                const dateMatch = (pop.innerText ?? "").match(/\b(?:20\d{2}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b/i);
                return {
                    primaryUrl,
                    extraUrls: Array.from(new Set(anchors.map((a) => a.href))),
                    title,
                    snippet,
                    date: dateMatch ? dateMatch[0] : "",
                };
            }).catch(() => null);

            if (cardData) {
                const target = byUrl.get(cardData.primaryUrl);
                if (target) {
                    if (cardData.title && (target.title === target.domain || target.title === target.url || target.title.length < cardData.title.length)) {
                        target.title = cardData.title;
                    }
                    if (cardData.snippet && !target.snippet) {
                        target.snippet = cardData.snippet;
                    }
                    if (cardData.date && !target.date) {
                        target.date = cardData.date;
                    }
                }
                for (const u of cardData.extraUrls || []) {
                    if (!byUrl.has(u) && (maxSources === 0 || sources.length < maxSources)) {
                        let domain = "";
                        try {
                            domain = new URL(u).hostname;
                        }
                        catch {
                            domain = "";
                        }
                        const added = {
                            index: sources.length + 1,
                            title: domain || u,
                            url: u,
                            ...(domain ? { domain } : {}),
                        };
                        sources.push(added);
                        byUrl.set(u, added);
                    }
                }
            }
        }
    }
    finally {
        await page.mouse.move(0, 0).catch(() => { });
        await page.keyboard.press("Escape").catch(() => { });
    }
    return sources;
}

async function extractAttachments(page) {
    return page.evaluate(() => {
        const found = [];
        const seen = new Set();
        const prosePanels = document.querySelectorAll("main .prose");
        const scope = (prosePanels.length > 0 ? prosePanels[prosePanels.length - 1].parentElement : null) || document.querySelector("main") || document.body;
        if (!scope)
            return found;
        for (const link of Array.from(scope.querySelectorAll('a[download], a[href^="blob:"], a[href*="pplx-file"], a[href*="/files/"]'))) {
            const url = link.getAttribute("href") || "";
            const name = (link.getAttribute("download") || link.textContent || "").trim().replace(/\s+/g, " ") || "attachment";
            const key = `${name}|${url}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            found.push({ name, url });
        }
        return found;
    }).catch(() => []);
}
