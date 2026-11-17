import { chromium } from "playwright";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { ErrorCode, PerplexityMcpError } from "./errors.js";
import { dataPath } from "./paths.js";

const DEFAULT_PROFILE_DIR = dataPath(".playwright", "profile");
const DEFAULT_PROFILES_ROOT = dataPath(".playwright", "profiles");
const HEADLESS_MODE = !/^(0|false|no)$/i.test(process.env.PERPLEXITY_HEADLESS ?? "true");

const slots = new Map();
let poolInitialized = false;

function sanitizeProfileId(raw) {
    const cleaned = String(raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return cleaned || "default";
}

function getOrCreateSlot(id, dir, isDefaultPool = false) {
    const resolvedDir = path.resolve(dir);
    for (const existing of slots.values()) {
        if (existing.dir === resolvedDir) {
            if (isDefaultPool)
                existing.inPool = true;
            return existing;
        }
    }
    const cleanId = sanitizeProfileId(id);
    let slotId = cleanId;
    let n = 2;
    while (slots.has(slotId)) {
        slotId = `${cleanId}-${n++}`;
    }
    const slot = {
        id: slotId,
        dir: resolvedDir,
        inPool: isDefaultPool,
        context: null,
        contextHeadless: HEADLESS_MODE,
        queue: Promise.resolve(),
        busy: false,
        pendingCount: 0,
        lastUsedAt: 0,
    };
    slots.set(slotId, slot);
    return slot;
}

/** Initialize configured default/pooled profile slots from environment variables. */
export function ensurePoolInitialized(env = process.env) {
    if (poolInitialized)
        return;
    poolInitialized = true;
    const primaryDir = env?.PERPLEXITY_PROFILE_DIR?.trim()
        ? path.resolve(env.PERPLEXITY_PROFILE_DIR.trim())
        : DEFAULT_PROFILE_DIR;
    getOrCreateSlot("default", primaryDir, true);

    const poolDirsRaw = env?.PERPLEXITY_PROFILE_DIRS?.trim();
    if (poolDirsRaw) {
        const entries = poolDirsRaw
            .split(/[;,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        entries.forEach((dirEntry, idx) => {
            const base = path.basename(dirEntry) || `pool-${idx + 1}`;
            getOrCreateSlot(base, dirEntry, true);
        });
    }
}

/** Resolve or register a profile slot for explicit name/path or pick best pool slot. */
export function selectProfileSlot(preferredProfile, env = process.env) {
    ensurePoolInitialized(env);
    const trimmed = preferredProfile?.trim();
    if (trimmed) {
        if (slots.has(trimmed))
            return slots.get(trimmed);
        const cleanId = sanitizeProfileId(trimmed);
        if (slots.has(cleanId))
            return slots.get(cleanId);
        // Support passing either an explicit directory path or a logical profile name.
        const looksLikePath = path.isAbsolute(trimmed) || /[\\/]/.test(trimmed);
        const profilesRoot = env?.PERPLEXITY_PROFILES_ROOT?.trim()
            ? path.resolve(env.PERPLEXITY_PROFILES_ROOT.trim())
            : DEFAULT_PROFILES_ROOT;
        const targetDir = looksLikePath
            ? path.resolve(trimmed)
            : path.join(profilesRoot, cleanId);
        return getOrCreateSlot(cleanId, targetDir, false);
    }

    const poolSlots = Array.from(slots.values()).filter((s) => s.inPool);
    const candidates = poolSlots.length > 0 ? poolSlots : Array.from(slots.values());
    // Prefer an already-open idle slot, then any idle slot, then shortest queue.
    const idleOpen = candidates.find((s) => !s.busy && s.pendingCount === 0 && s.context !== null);
    if (idleOpen)
        return idleOpen;
    const idleClosed = candidates.find((s) => !s.busy && s.pendingCount === 0);
    if (idleClosed)
        return idleClosed;
    return candidates.slice().sort((a, b) => a.pendingCount - b.pendingCount || a.lastUsedAt - b.lastUsedAt)[0];
}

/** List current profile slots and their concurrency state. */
export function getPoolStatus(env = process.env) {
    ensurePoolInitialized(env);
    return Array.from(slots.values()).map((slot) => ({
        id: slot.id,
        dir: slot.dir,
        inPool: slot.inPool,
        exists: fs.existsSync(slot.dir),
        active: slot.context !== null,
        busy: slot.busy,
        queued: slot.pendingCount,
        headless: slot.contextHeadless,
    }));
}

function checkChromiumInstalled() {
    let exePath = "";
    try {
        exePath = chromium.executablePath();
    }
    catch {
        exePath = "";
    }
    if (!exePath || !fs.existsSync(exePath)) {
        throw new PerplexityMcpError(ErrorCode.PROFILE_UNAVAILABLE, "Playwright Chromium is not installed. Run: npx playwright install chromium", {
            stage: "browser_launch",
            recoverable: true,
        });
    }
}

function isForceCleanup() {
    return /^(1|true|yes)$/i.test(process.env.PERPLEXITY_FORCE_CLEANUP ?? "");
}

/** Parse newline-separated PID output (PowerShell). */
export function parsePidList(output) {
    return String(output ?? "")
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Parse `ps -A -o pid=,args=` output for Chromium processes bound to a profile directory. */
export function parsePosixProfileOwners(output, profileDir) {
    const resolved = path.resolve(profileDir);
    const needles = [`--user-data-dir=${resolved}`, `--user-data-dir="${resolved}"`];
    const pids = [];
    for (const line of String(output ?? "").split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (match && needles.some((needle) => match[2].includes(needle))) {
            pids.push(Number.parseInt(match[1], 10));
        }
    }
    return pids;
}

/** Live Chromium PIDs bound to profileDir, or null when the OS process list could not be inspected. */
export function findProfileOwners(profileDir) {
    const resolved = path.resolve(profileDir);
    try {
        if (process.platform === "win32") {
            const output = execFileSync("powershell.exe", [
                "-NoProfile",
                "-Command",
                '$p = $env:MCP_PROFILE_DIR; Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | Select-Object -ExpandProperty ProcessId',
            ], {
                env: { ...process.env, MCP_PROFILE_DIR: resolved },
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 15000,
            });
            return parsePidList(output);
        }
        const output = execFileSync("ps", ["-A", "-o", "pid=,args="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 15000,
        });
        return parsePosixProfileOwners(output, resolved);
    }
    catch {
        return null;
    }
}

function killProfileOwners(profileDir, pids) {
    if (process.platform === "win32") {
        try {
            // Stop only Playwright Chrome instances explicitly bound to this MCP profile dir.
            execFileSync("powershell.exe", [
                "-NoProfile",
                "-Command",
                '$p = $env:MCP_PROFILE_DIR; Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
            ], {
                env: { ...process.env, MCP_PROFILE_DIR: path.resolve(profileDir) },
                stdio: "ignore",
                timeout: 15000,
            });
        }
        catch {
            // Best effort; the retry below will surface a typed error if the lock is still held.
        }
        return;
    }
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch {
            // Already gone.
        }
    }
}

function removeProfileLocks(profileDir) {
    for (const lockName of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
        try {
            fs.rmSync(path.join(profileDir, lockName), { force: true });
        }
        catch {
            // Ignore.
        }
    }
}

/**
 * Recover from a profile Chromium refused to open. A live owner is never killed and its
 * locks are never removed unless PERPLEXITY_FORCE_CLEANUP=1; otherwise the caller gets a typed busy error.
 */
async function recoverProfileLock(profileDir, slotId, knownOwners = undefined) {
    const owners = knownOwners === undefined ? findProfileOwners(profileDir) : knownOwners;
    if (owners === null) {
        if (!isForceCleanup()) {
            throw new PerplexityMcpError(ErrorCode.PROFILE_UNAVAILABLE, `Profile "${slotId}" appears locked, and the server could not inspect running processes to confirm whether it is still in use. `
                + "Close the other MCP client/browser using this profile, or set PERPLEXITY_FORCE_CLEANUP=1 to remove the lock and retry.", {
                stage: "browser_launch",
                profile: slotId,
                recoverable: true,
            });
        }
        console.error(`[perplexity-web-mcp] Could not inspect processes using profile "${slotId}"; PERPLEXITY_FORCE_CLEANUP=1 is set, removing locks.`);
    }
    else if (owners.length > 0) {
        if (!isForceCleanup()) {
            throw new PerplexityMcpError(ErrorCode.PROFILE_UNAVAILABLE, `Profile "${slotId}" is in use by live Chromium process(es): ${owners.join(", ")}. `
                + "Close the other MCP client/browser using this profile, or set PERPLEXITY_FORCE_CLEANUP=1 to terminate it.", {
                stage: "browser_launch",
                profile: slotId,
                recoverable: true,
            });
        }
        console.error(`[perplexity-web-mcp] PERPLEXITY_FORCE_CLEANUP=1: terminating Chromium process(es) ${owners.join(", ")} for profile "${slotId}"...`);
        killProfileOwners(profileDir, owners);
        await new Promise((resolve) => setTimeout(resolve, 750));
    }
    else {
        console.error(`[perplexity-web-mcp] No live Chromium owner for profile "${slotId}"; removing stale locks and retrying...`);
    }
    removeProfileLocks(profileDir);
}

async function setWindowBounds(slot, page, bounds) {
    if (slot.contextHeadless)
        return;
    let cdp = null;
    try {
        cdp = await page.context().newCDPSession(page);
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", { windowId, bounds });
    }
    catch {
        // Ignore if target/window doesn't support window bounds
    }
    finally {
        await cdp?.detach().catch(() => { });
    }
}

export async function minimizeBrowserWindow(page, slot = null) {
    if (slot?.contextHeadless ?? HEADLESS_MODE) {
        if (!slot)
            return;
        if (slot.contextHeadless)
            return;
    }
    let cdp = null;
    try {
        cdp = await page.context().newCDPSession(page);
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    }
    catch {
        // Ignore
    }
    finally {
        await cdp?.detach().catch(() => { });
    }
}

export async function revealBrowserWindow(page, slot = null) {
    if (slot) {
        await setWindowBounds(slot, page, { windowState: "normal", left: 80, top: 80, width: 1280, height: 800 });
        return;
    }
    await minimizeOrRevealFallback(page);
}

async function minimizeOrRevealFallback(page) {
    let cdp = null;
    try {
        cdp = await page.context().newCDPSession(page);
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", {
            windowId,
            bounds: { windowState: "normal", left: 80, top: 80, width: 1280, height: 800 },
        });
    }
    catch {
        // Ignore
    }
    finally {
        await cdp?.detach().catch(() => { });
    }
}

async function openPersistentContext(profileDir, headless = HEADLESS_MODE) {
    fs.mkdirSync(profileDir, { recursive: true });
    const launchOpts = {
        headless,
        viewport: { width: 1280, height: 800 },
        args: [
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
            ...(headless ? [] : ["--window-position=-32000,-32000", "--no-focus-on-map"]),
        ],
    };
    if (headless) {
        launchOpts.channel = "chromium";
    }
    return chromium.launchPersistentContext(profileDir, launchOpts);
}

/** Launch or relaunch the Playwright persistent browser context for a profile slot. */
export async function launchSlotBrowser(slot, options = {}) {
    const headless = typeof options.headless === "boolean" ? options.headless : HEADLESS_MODE;
    checkChromiumInstalled();
    if (slot.context) {
        await slot.context.close().catch(() => { });
        slot.context = null;
    }
    slot.contextHeadless = headless;
    try {
        slot.context = await openPersistentContext(slot.dir, headless);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const knownLockError = /existing browser session|already in use|already running|ProcessSingleton|Singleton/i.test(msg);
        // Playwright sometimes reports a locked profile as a generic "Target page, context or browser
        // has been closed" after Chromium exits. Ask the OS before deciding whether this is recoverable.
        const ambiguousLockError = /Target page, context or browser has been closed/i.test(msg);
        const owners = knownLockError || ambiguousLockError ? findProfileOwners(slot.dir) : [];
        if (!knownLockError && (!ambiguousLockError || !owners || owners.length === 0)) {
            throw new PerplexityMcpError(ErrorCode.PROFILE_UNAVAILABLE, `Failed launching Chromium for profile "${slot.id}": ${msg}`, {
                stage: "browser_launch",
                profile: slot.id,
                cause: err,
            });
        }
        console.error(`[perplexity-web-mcp] Detected a locked profile "${slot.id}"; checking for a live owner...`);
        await recoverProfileLock(slot.dir, slot.id, owners);
        try {
            slot.context = await openPersistentContext(slot.dir, headless);
        }
        catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            throw new PerplexityMcpError(ErrorCode.PROFILE_UNAVAILABLE, `Failed launching Chromium for profile "${slot.id}" after stale-lock recovery: ${retryMsg}. `
                + "If another MCP client is using this profile, close it or set PERPLEXITY_FORCE_CLEANUP=1.", {
                stage: "browser_launch",
                profile: slot.id,
                cause: retryErr,
            });
        }
    }
    slot.context.on("close", () => {
        slot.context = null;
    });
    if (!headless) {
        const firstPage = slot.context.pages()[0];
        if (firstPage) {
            await minimizeBrowserWindow(firstPage, slot);
        }
    }
}

/** Ensure the browser context for a slot (or default slot) is running. */
export async function ensureBrowser(options = {}) {
    const slot = options.slot ?? selectProfileSlot(options.profile);
    if (!slot.context) {
        await launchSlotBrowser(slot, options);
    }
    else if (options.headless === false && slot.contextHeadless) {
        await launchSlotBrowser(slot, { headless: false });
    }
    return slot;
}

export async function hideOrMinimizeAfterAuth(page, slot = null) {
    if (slot) {
        if (HEADLESS_MODE && !slot.contextHeadless) {
            await launchSlotBrowser(slot, { headless: true });
            return;
        }
        await minimizeBrowserWindow(page, slot);
        return;
    }
    await minimizeBrowserWindow(page);
}

export async function newSearchPage(slot) {
    if (!slot?.context) {
        throw new PerplexityMcpError(ErrorCode.PROFILE_UNAVAILABLE, "Browser not initialized for profile slot.", {
            stage: "browser_page",
            profile: slot?.id,
        });
    }
    const page = await slot.context.newPage();
    await minimizeBrowserWindow(page, slot);
    return page;
}

export async function getFirstPage(slot) {
    if (!slot?.context) {
        throw new PerplexityMcpError(ErrorCode.PROFILE_UNAVAILABLE, "Browser not initialized for profile slot.", {
            stage: "browser_page",
            profile: slot?.id,
        });
    }
    const page = slot.context.pages()[0] ?? await slot.context.newPage();
    await minimizeBrowserWindow(page, slot);
    return page;
}

/**
 * Acquire a per-profile lock slot while respecting an AbortSignal while waiting in the queue.
 * Requests routed to different profile slots execute concurrently.
 */
export async function runWithProfileSlot({ profile, signal } = {}, taskFn) {
    if (signal?.aborted) {
        throw new PerplexityMcpError(ErrorCode.CANCELLED, "Request cancelled before acquiring a browser slot.", {
            stage: "queue",
        });
    }
    const slot = selectProfileSlot(profile);
    slot.pendingCount++;
    let accounted = false;
    let cancelledWhileQueued = false;
    let abortHandler = null;

    const abortPromise = new Promise((_, reject) => {
        if (!signal)
            return;
        abortHandler = () => {
            cancelledWhileQueued = true;
            if (!accounted) {
                accounted = true;
                slot.pendingCount = Math.max(0, slot.pendingCount - 1);
            }
            reject(new PerplexityMcpError(ErrorCode.CANCELLED, "Request cancelled while waiting for browser slot.", {
                stage: "queue",
                profile: slot.id,
            }));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
    });

    const turnPromise = slot.queue
        .catch(() => { })
        .then(async () => {
        if (abortHandler && signal) {
            signal.removeEventListener("abort", abortHandler);
            abortHandler = null;
        }
        if (cancelledWhileQueued || signal?.aborted) {
            throw new PerplexityMcpError(ErrorCode.CANCELLED, "Request cancelled before starting.", {
                stage: "queue",
                profile: slot.id,
            });
        }
        slot.busy = true;
        try {
            return await taskFn(slot);
        }
        finally {
            slot.busy = false;
            slot.lastUsedAt = Date.now();
        }
    });

    slot.queue = turnPromise
        .catch(() => { })
        .finally(() => {
        if (!accounted) {
            accounted = true;
            slot.pendingCount = Math.max(0, slot.pendingCount - 1);
        }
    });

    try {
        return signal ? await Promise.race([turnPromise, abortPromise]) : await turnPromise;
    }
    finally {
        if (abortHandler && signal) {
            signal.removeEventListener("abort", abortHandler);
        }
    }
}

/** Close one profile's browser context or all open contexts during shutdown. */
export async function closeBrowser(profileId) {
    if (profileId) {
        const slot = slots.get(profileId) ?? slots.get(sanitizeProfileId(profileId));
        if (slot?.context) {
            await slot.context.close().catch(() => { });
            slot.context = null;
        }
        return;
    }
    await Promise.allSettled(Array.from(slots.values()).map(async (slot) => {
        if (slot.context) {
            await slot.context.close().catch(() => { });
            slot.context = null;
        }
    }));
}
