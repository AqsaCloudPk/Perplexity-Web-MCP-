import { ensureBrowser, getFirstPage, revealBrowserWindow, hideOrMinimizeAfterAuth, runWithProfileSlot } from "./browser.js";
import { ErrorCode, PerplexityMcpError } from "./errors.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
const AUTH_CHECK_URL = "https://www.perplexity.ai/api/auth/session?version=2.18&source=default";
const POLL_INTERVAL_MS = 2000;
export const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const SIGN_IN_WINDOW_TITLE = ">>> SIGN IN HERE <<< Perplexity";
const log = (msg) => console.error(`[perplexity-web-mcp] ${msg}`);

/** Resolve how long `login` waits for the user: PERPLEXITY_LOGIN_TIMEOUT_MS (positive integer ms), default 15 minutes. */
export function resolveLoginTimeoutMs(env = process.env) {
    const raw = env?.PERPLEXITY_LOGIN_TIMEOUT_MS;
    if (raw === undefined || String(raw).trim() === "")
        return DEFAULT_LOGIN_TIMEOUT_MS;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOGIN_TIMEOUT_MS;
}

function formatDuration(ms) {
    return ms % 60000 === 0 ? `${ms / 60000} minute${ms === 60000 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`;
}

/** Check whether the given browser page has an active authenticated Perplexity session. */
export async function checkSession(page) {
    try {
        const response = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: "include" });
            return res.json();
        }, AUTH_CHECK_URL);
        return !!response?.user?.id;
    }
    catch {
        return false;
    }
}

/** Make the automation window easy to spot among the user's own browser windows. */
async function markSignInWindow(page) {
    try {
        await page.evaluate((title) => {
            document.title = title;
        }, SIGN_IN_WINDOW_TITLE);
    }
    catch {
        // Page may be mid-navigation (OAuth redirects); the next poll will retry.
    }
}

/** Verify authentication on the target profile, opening a visible login window if needed. */
export async function ensureAuthenticated({ profile, signal, env = process.env } = {}) {
    return runWithProfileSlot({ profile, signal }, async (slot) => {
        await ensureBrowser({ slot, headless: false });
        const page = await getFirstPage(slot);
        await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
        const alreadyAuthenticated = await checkSession(page);
        if (alreadyAuthenticated) {
            await hideOrMinimizeAfterAuth(page, slot);
            log(`Session active on profile "${slot.id}" (${slot.dir}).`);
            return { authenticated: true, alreadyAuthenticated: true, profile: slot.id, profileDir: slot.dir };
        }
        await revealBrowserWindow(page, slot);
        const timeoutMs = resolveLoginTimeoutMs(env);
        log(`No active session on profile "${slot.id}". Sign in to Perplexity in the browser window titled "${SIGN_IN_WINDOW_TITLE}" `
            + `(NOT your everyday Chrome/Edge: this is a separate automation browser). Waiting up to ${formatDuration(timeoutMs)}. Profile: ${slot.dir}`);
        await markSignInWindow(page);
        await waitForLogin(page, slot.id, signal, timeoutMs);
        await hideOrMinimizeAfterAuth(page, slot);
        log(`Login detected on profile "${slot.id}".`);
        return { authenticated: true, alreadyAuthenticated: false, profile: slot.id, profileDir: slot.dir };
    });
}

async function waitForLogin(page, profileId, signal, timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new PerplexityMcpError(ErrorCode.CANCELLED, "Login cancelled by client.", {
                stage: "login",
                profile: profileId,
            });
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const ok = await checkSession(page);
        if (ok)
            return;
        await markSignInWindow(page);
    }
    throw new PerplexityMcpError(ErrorCode.TIMEOUT, `Login timeout after ${formatDuration(timeoutMs)}. Re-run login (or raise PERPLEXITY_LOGIN_TIMEOUT_MS).`, {
        stage: "login",
        profile: profileId,
    });
}
