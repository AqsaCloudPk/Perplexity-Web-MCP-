import { ensureBrowser, getFirstPage, revealBrowserWindow, hideOrMinimizeAfterAuth, runWithProfileSlot } from "./browser.js";
import { ErrorCode, PerplexityMcpError } from "./errors.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
const AUTH_CHECK_URL = "https://www.perplexity.ai/api/auth/session?version=2.18&source=default";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const log = (msg) => console.error(`[perplexity-web-mcp] ${msg}`);

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

/** Verify authentication on the target profile, opening a visible login window if needed. */
export async function ensureAuthenticated({ profile, signal } = {}) {
    return runWithProfileSlot({ profile, signal }, async (slot) => {
        await ensureBrowser({ slot, headless: false });
        const page = await getFirstPage(slot);
        await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
        const alreadyAuthenticated = await checkSession(page);
        if (alreadyAuthenticated) {
            await hideOrMinimizeAfterAuth(page, slot);
            log(`Session active on profile "${slot.id}".`);
            return { authenticated: true, alreadyAuthenticated: true, profile: slot.id };
        }
        await revealBrowserWindow(page, slot);
        log(`No active session on profile "${slot.id}". Please log in to Perplexity in the browser window...`);
        await waitForLogin(page, slot.id, signal);
        await hideOrMinimizeAfterAuth(page, slot);
        log(`Login detected on profile "${slot.id}".`);
        return { authenticated: true, alreadyAuthenticated: false, profile: slot.id };
    });
}

async function waitForLogin(page, profileId, signal) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
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
    }
    throw new PerplexityMcpError(ErrorCode.TIMEOUT, "Login timeout after 5 minutes.", {
        stage: "login",
        profile: profileId,
    });
}
