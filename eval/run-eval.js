import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const QUESTIONS_PATH = path.join(__dirname, "questions.json");
const RESULTS_DIR = path.join(ROOT_DIR, "eval-results");

function parseArgs(argv) {
    const opts = {
        limit: 0,
        category: "",
        model: "",
        backend: "auto",
        verify: false,
        timeoutSec: 120,
        server: path.join(ROOT_DIR, "dist/index.js"),
        profile: "",
        dryCheck: false,
    };
    for (const arg of argv) {
        if (arg.startsWith("--limit="))
            opts.limit = Number.parseInt(arg.split("=")[1], 10) || 0;
        else if (arg.startsWith("--category="))
            opts.category = arg.split("=")[1].trim().toLowerCase();
        else if (arg.startsWith("--model="))
            opts.model = arg.slice("--model=".length).trim();
        else if (arg.startsWith("--backend="))
            opts.backend = arg.split("=")[1].trim();
        else if (arg === "--verify")
            opts.verify = true;
        else if (arg.startsWith("--timeout="))
            opts.timeoutSec = Number.parseInt(arg.split("=")[1], 10) || 120;
        else if (arg.startsWith("--server="))
            opts.server = path.resolve(arg.slice("--server=".length).trim());
        else if (arg.startsWith("--profile="))
            opts.profile = arg.slice("--profile=".length).trim();
        else if (arg === "--dry-check")
            opts.dryCheck = true;
    }
    return opts;
}

function percentile(sortedNums, p) {
    if (sortedNums.length === 0)
        return 0;
    const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.ceil((p / 100) * sortedNums.length) - 1));
    return sortedNums[idx];
}

async function checkUrlReachable(url, timeoutMs = 6000) {
    const attempt = async (method) => {
        const res = await fetch(url, {
            method,
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
            headers: { "User-Agent": "perplexity-web-mcp-eval/1.4" },
        });
        await res.body?.cancel?.().catch(() => { });
        return { ok: res.ok || res.status === 403 || res.status === 401 || res.status === 429, status: res.status };
    };
    try {
        const head = await attempt("HEAD");
        if (head.ok || head.status !== 405)
            return { url, reachable: head.status >= 200 && head.status < 400, status: head.status };
        const get = await attempt("GET");
        return { url, reachable: get.status >= 200 && get.status < 400, status: get.status };
    }
    catch (err) {
        return { url, reachable: false, status: null, error: err?.name || "error" };
    }
}

function extractUrlsFromToolText(text) {
    const urls = new Set();
    const sourcesSection = text.split(/\n\nSources:\n/)[1]?.split(/\n\nThread URL:/)[0] ?? "";
    for (const m of sourcesSection.matchAll(/\((https?:\/\/[^\s)]+)\)/g)) {
        urls.add(m[1]);
    }
    return Array.from(urls);
}

function buildMarkdownReport(summary, rows) {
    const lines = [
        "# Perplexity MCP Benchmark Report",
        "",
        `- **Date**: ${summary.evaluatedAt}`,
        `- **Server**: \`${summary.server}\``,
        `- **Backend**: \`${summary.backend}\`${summary.model ? ` | **Model**: \`${summary.model}\`` : ""}${summary.verify ? " | **Claim Verification**: enabled" : ""}`,
        `- **Questions**: ${summary.succeeded}/${summary.total} passed (${summary.successRatePct}%), timeouts: ${summary.timedOut}`,
        `- **Latency (ms)**: min=${summary.latencyMs.min}, p50=${summary.latencyMs.p50}, p95=${summary.latencyMs.p95}, max=${summary.latencyMs.max}, mean=${summary.latencyMs.mean}`,
        `- **Citations**: ${summary.citations.totalExtracted} extracted across ${summary.succeeded} answers (avg ${summary.citations.avgPerSuccess}), reachable live URLs: ${summary.citations.urlsReachable}/${summary.citations.uniqueUrlsChecked} (${summary.citations.reachableRatePct}%)`,
        ...(summary.verification ? [`- **Claim Verification**: supported=${summary.verification.supported}, weak=${summary.verification.weak}, unverified=${summary.verification.unverified} (${summary.verification.supportedRatePct}% supported)`] : []),
        "",
        "| ID | Category | OK | TimedOut | Latency (ms) | Chars | Sources | Token Checks | Error |",
        "| --- | --- | :---: | :---: | ---: | ---: | ---: | --- | --- |",
        ...rows.map((r) => `| ${r.id} | ${r.category} | ${r.ok ? "YES" : "NO"} | ${r.timedOut ? "YES" : "no"} | ${r.durationMs} | ${r.chars} | ${r.sourceCount} | ${r.tokensMatched}/${r.tokensExpected} | ${r.errorCode || "-"} |`),
        "",
    ];
    return lines.join("\n");
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const allQuestions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf8"));
    let questions = opts.category
        ? allQuestions.filter((q) => q.category === opts.category)
        : allQuestions;
    if (opts.limit > 0)
        questions = questions.slice(0, opts.limit);

    if (questions.length === 0) {
        throw new Error(`No matching questions found in ${QUESTIONS_PATH}`);
    }
    for (const q of questions) {
        if (!q.id || !q.query || !q.category)
            throw new Error(`Invalid question entry: ${JSON.stringify(q)}`);
    }

    if (opts.dryCheck) {
        console.log(`EVAL_DRY_CHECK_OK: ${questions.length} questions validated across categories: ${Array.from(new Set(questions.map((q) => q.category))).join(", ")}`);
        return;
    }

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [opts.server],
        env: { ...process.env, ...(opts.profile ? { PERPLEXITY_PROFILE_DIR: opts.profile } : {}) },
        stderr: "pipe",
    });
    const client = new Client({ name: "perplexity-eval-runner", version: "1.4.0" }, { capabilities: {} });

    const rows = [];
    const allUrls = new Set();
    let verSupported = 0;
    let verWeak = 0;
    let verUnverified = 0;

    try {
        await client.connect(transport);
        console.log(`[eval] Running ${questions.length} questions against ${opts.server}...`);

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            const t0 = Date.now();
            try {
                const args = {
                    query: q.query,
                    backend: opts.backend,
                    timeout_seconds: opts.timeoutSec,
                    verify_claims: opts.verify,
                    no_cache: true,
                    ...(opts.model ? { model: opts.model } : {}),
                };
                const res = await client.callTool(
                    { name: "search", arguments: args },
                    undefined,
                    { timeout: (opts.timeoutSec + 20) * 1000 }
                );
                const rawText = res.content?.[0]?.text ?? "";
                const durationMs = Date.now() - t0;
                if (res.isError) {
                    let parsed = null;
                    try { parsed = JSON.parse(rawText); } catch { }
                    const code = parsed?.error?.code || "ERROR";
                    rows.push({
                        id: q.id,
                        category: q.category,
                        ok: false,
                        timedOut: code === "TIMEOUT",
                        durationMs,
                        chars: 0,
                        sourceCount: 0,
                        tokensMatched: 0,
                        tokensExpected: q.expectedTokens?.length ?? 0,
                        errorCode: code,
                    });
                    console.log(`  [${i + 1}/${questions.length}] ${q.id}: FAIL (${code}, ${durationMs}ms)`);
                    continue;
                }

                const metaMatch = rawText.match(/Metadata:\s*(\{.+\})$/m);
                const meta = metaMatch ? JSON.parse(metaMatch[1]) : null;
                let answerText = rawText;
                if (meta?.spooled && meta?.outputFile && fs.existsSync(meta.outputFile)) {
                    answerText = fs.readFileSync(meta.outputFile, "utf8");
                }
                const lower = answerText.toLowerCase();
                const expected = q.expectedTokens ?? [];
                const tokensMatched = expected.filter((t) => lower.includes(t.toLowerCase())).length;
                const urls = extractUrlsFromToolText(rawText);
                urls.forEach((u) => allUrls.add(u));

                if (meta?.verification) {
                    verSupported += meta.verification.supported ?? 0;
                    verWeak += meta.verification.weak ?? 0;
                    verUnverified += meta.verification.unverified ?? 0;
                }

                const chars = meta?.chars ?? rawText.length;
                const sourceCount = meta?.sourceCount ?? urls.length;
                const passed = chars >= (q.minChars ?? 80) && sourceCount >= (q.minSources ?? 0) && !meta?.timedOut;
                rows.push({
                    id: q.id,
                    category: q.category,
                    ok: passed,
                    timedOut: Boolean(meta?.timedOut),
                    durationMs,
                    chars,
                    sourceCount,
                    tokensMatched,
                    tokensExpected: expected.length,
                    errorCode: passed ? "" : (meta?.timedOut ? "PARTIAL_TIMEOUT" : "BELOW_MIN_THRESHOLD"),
                });
                console.log(`  [${i + 1}/${questions.length}] ${q.id}: ${passed ? "OK" : "WARN"} (${durationMs}ms, ${chars} chars, ${sourceCount} sources, tokens=${tokensMatched}/${expected.length})`);
            }
            catch (err) {
                const durationMs = Date.now() - t0;
                rows.push({
                    id: q.id,
                    category: q.category,
                    ok: false,
                    timedOut: /timeout|deadline/i.test(err?.message || ""),
                    durationMs,
                    chars: 0,
                    sourceCount: 0,
                    tokensMatched: 0,
                    tokensExpected: q.expectedTokens?.length ?? 0,
                    errorCode: "RPC_ERROR",
                });
                console.log(`  [${i + 1}/${questions.length}] ${q.id}: ERROR (${err?.message || err})`);
            }
        }
    }
    finally {
        await client.close().catch(() => { });
        await transport.close().catch(() => { });
    }

    const urlList = Array.from(allUrls).slice(0, 60);
    console.log(`[eval] Checking reachability of ${urlList.length} unique cited URLs...`);
    const urlChecks = await Promise.all(urlList.map((u) => checkUrlReachable(u)));
    const reachableCount = urlChecks.filter((u) => u.reachable).length;

    const okRows = rows.filter((r) => r.ok);
    const durations = okRows.map((r) => r.durationMs).sort((a, b) => a - b);
    const allDurations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
    const latSource = durations.length > 0 ? durations : allDurations;
    const totalSources = okRows.reduce((s, r) => s + r.sourceCount, 0);
    const verTotal = verSupported + verWeak + verUnverified;

    const summary = {
        evaluatedAt: new Date().toISOString(),
        server: opts.server,
        backend: opts.backend,
        model: opts.model || null,
        verify: opts.verify,
        total: rows.length,
        succeeded: okRows.length,
        failed: rows.length - okRows.length,
        timedOut: rows.filter((r) => r.timedOut).length,
        successRatePct: Number(((okRows.length / rows.length) * 100).toFixed(1)),
        latencyMs: {
            min: latSource[0] ?? 0,
            p50: percentile(latSource, 50),
            p95: percentile(latSource, 95),
            max: latSource[latSource.length - 1] ?? 0,
            mean: latSource.length ? Math.round(latSource.reduce((a, b) => a + b, 0) / latSource.length) : 0,
        },
        citations: {
            totalExtracted: totalSources,
            avgPerSuccess: okRows.length ? Number((totalSources / okRows.length).toFixed(2)) : 0,
            uniqueUrlsChecked: urlChecks.length,
            urlsReachable: reachableCount,
            reachableRatePct: urlChecks.length ? Number(((reachableCount / urlChecks.length) * 100).toFixed(1)) : 0,
        },
        ...(opts.verify && verTotal > 0 ? {
            verification: {
                supported: verSupported,
                weak: verWeak,
                unverified: verUnverified,
                supportedRatePct: Number(((verSupported / verTotal) * 100).toFixed(1)),
            },
        } : {}),
    };

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = path.join(RESULTS_DIR, `eval-${stamp}.json`);
    const mdPath = path.join(RESULTS_DIR, `eval-${stamp}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify({ summary, rows, urlChecks }, null, 2), "utf8");
    fs.writeFileSync(mdPath, buildMarkdownReport(summary, rows), "utf8");

    console.log("\n=== EVAL SUMMARY ===");
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Saved JSON: ${jsonPath}`);
    console.log(`Saved Report: ${mdPath}`);
    if (okRows.length === 0)
        process.exit(1);
}

main().catch((err) => {
    console.error("[eval] Fatal error:", err);
    process.exit(1);
});
