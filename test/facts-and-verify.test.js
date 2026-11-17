import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentWords, extractKeyFacts, factMatches, normalizeText, stripCitationMarkers } from "../dist/facts.js";
import { classifyClaim, htmlToText, fetchPageText, resolveVerifyDefault, verifyClaims } from "../dist/verify.js";

describe("facts.js", () => {
    it("strips citation markers cleanly", () => {
        assert.equal(stripCitationMarkers("Node.js v22.11.0 [1][2, 3] reached LTS [web:4]."), "Node.js v22.11.0 reached LTS.");
    });

    it("extracts dates, versions, numbers with units, quoted identifiers, and capitalized names", () => {
        const text = 'Node.js v22.11.0 [1] entered Active LTS on October 29, 2024 with a 400 KB limit and "StrictMode" enabled.';
        const facts = extractKeyFacts(text, { maxFacts: 15 });
        const keys = facts.map((f) => f.key);
        assert.ok(keys.includes("date:2024-10-29"), `missing date key in ${JSON.stringify(keys)}`);
        assert.ok(keys.includes("version:22.11.0"), `missing version key in ${JSON.stringify(keys)}`);
        assert.ok(keys.some((k) => k.startsWith("number:400:kb")), `missing 400 KB key in ${JSON.stringify(keys)}`);
        assert.ok(keys.includes("name:strictmode"), `missing quoted name without trailing punctuation in ${JSON.stringify(keys)}`);
        assert.ok(keys.includes("name:node.js"), `missing technical name node.js in ${JSON.stringify(keys)}`);
    });

    it("does not leak trailing punctuation inside quoted names or extract single-digit counters", () => {
        const facts = extractKeyFacts('Consider 2 options such as "ESM," or `strict`.');
        assert.ok(!facts.some((f) => f.type === "number" && f.numeric === "2"));
        assert.ok(facts.some((f) => f.key === "name:esm"));
        assert.ok(facts.some((f) => f.key === "name:strict"));
    });

    it("matches dates across ISO and month formats and respects number/version boundaries", () => {
        const [isoDateFact] = extractKeyFacts("Released 2024-04-24.");
        assert.equal(factMatches(isoDateFact, normalizeText("Officially shipped on April 24, 2024.")), true);
        assert.equal(factMatches(isoDateFact, normalizeText("Built on 24 Apr 2024.")), true);
        assert.equal(factMatches(isoDateFact, normalizeText("Built on April 25, 2024.")), false);

        const [num22] = extractKeyFacts("Version 22 introduces require(esm).");
        assert.equal(factMatches(num22, normalizeText("Node 22.11.0 supports require(esm).")), true);
        assert.equal(factMatches(num22, normalizeText("In 2022 there were 22,000 issues.")), false);

        const [ver31] = extractKeyFacts("Python 3.1");
        assert.equal(factMatches(ver31, normalizeText("Python 3.12 was released later.")), false);
        assert.equal(factMatches(ver31, normalizeText("Python 3.1 was released earlier.")), true);
    });

    it("extracts lowercased non-stopword contentWords (>=5 chars)", () => {
        const words = contentWords("These deterministic verification benchmarks check provenance against multiple sources.");
        assert.ok(words.includes("deterministic"));
        assert.ok(words.includes("verification"));
        assert.ok(!words.includes("these"));
        assert.ok(!words.includes("against"));
    });
});

describe("verify.js", () => {
    it("htmlToText removes script/style/svg and decodes entities", () => {
        const html = "<html><head><style>.x{color:red}</style><script>var secret='bad';</script></head><body><!-- hidden --><h1>Hello &amp; Welcome</h1><p>Cost: &#36;100 &mdash; &#x27;ok&#x27;</p><svg><text>ignore</text></svg></body></html>";
        const plain = htmlToText(html);
        assert.match(plain, /Hello & Welcome/);
        assert.match(plain, /\$100 - 'ok'/);
        assert.doesNotMatch(plain, /secret|color:red|hidden|ignore/);
    });

    it("fetchPageText handles 200, 403/429 blocked, 404 http_error, binary types, JS shell, size cap, and abort", async () => {
        const longBody = "<html><body><main>" + "Node.js v22.11.0 entered Active LTS on October 29, 2024. ".repeat(6) + "</main></body></html>";
        const okRes = await fetchPageText("https://example.com/ok", {
            fetchImpl: async () => new Response(longBody, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
        });
        assert.equal(okRes.ok, true);
        assert.ok(okRes.chars >= 200);

        const blockedRes = await fetchPageText("https://example.com/blocked", {
            fetchImpl: async () => new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } }),
        });
        assert.deepEqual({ ok: blockedRes.ok, reason: blockedRes.reason, status: blockedRes.status }, { ok: false, reason: "blocked", status: 403 });

        const notFoundRes = await fetchPageText("https://example.com/missing", {
            fetchImpl: async () => new Response("nope", { status: 404, headers: { "content-type": "text/html" } }),
        });
        assert.equal(notFoundRes.reason, "http_error");

        const pdfRes = await fetchPageText("https://example.com/doc.pdf", {
            fetchImpl: async () => new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }),
        });
        assert.equal(pdfRes.reason, "unsupported_content_type");

        const jsShellRes = await fetchPageText("https://example.com/spa", {
            fetchImpl: async () => new Response("<html><body><div id='app'>Loading...</div></body></html>", { status: 200, headers: { "content-type": "text/html" } }),
        });
        assert.equal(jsShellRes.reason, "empty_or_js_rendered");

        const hugeChunk = new Uint8Array(1024 * 1024).fill(65); // 'A' * 1MB per chunk -> 5 chunks = 5MB
        let chunkIndex = 0;
        const stream = new ReadableStream({
            pull(controller) {
                if (chunkIndex++ < 5)
                    controller.enqueue(hugeChunk);
                else
                    controller.close();
            },
        });
        const cappedRes = await fetchPageText("https://example.com/huge", {
            fetchImpl: async () => new Response(stream, { status: 200, headers: { "content-type": "text/plain" } }),
        });
        assert.equal(cappedRes.ok, true);
        assert.ok(cappedRes.chars <= 3 * 1024 * 1024);

        const ac = new AbortController();
        ac.abort();
        const abortedRes = await fetchPageText("https://example.com/abort", {
            signal: ac.signal,
            fetchImpl: async () => { throw new Error("aborted"); },
        });
        assert.equal(abortedRes.reason, "cancelled");
    });

    it("classifyClaim and verifyClaims distinguish supported, weak, unverified, and aggregate counts", async () => {
        const claims = [
            { index: 1, text: "Node.js v22.11.0 entered Active LTS on October 29, 2024.", urls: ["https://docs.example.com/node"] },
            { index: 2, text: "Node.js v22.11.0 introduced a 999 MB buffer limit on May 1, 2026.", urls: ["https://docs.example.com/node"] },
            { index: 3, text: "Deno 9.9.9 shipped on January 5, 2030.", urls: ["https://docs.example.com/node"] },
            { index: 4, text: "Blocked source claim with 42 widgets.", urls: ["https://blocked.example.com/post"] },
            { index: 5, text: "Uncited claim.", urls: [] },
        ];

        const pages = new Map([
            ["https://docs.example.com/node", "<html><body><article>" + "Official release notes: Node.js 22.11.0 entered Active LTS on 2024-10-29 with long-term support guarantees. ".repeat(4) + "</article></body></html>"],
        ]);

        const progressEvents = [];
        const res = await verifyClaims(claims, {
            fetchImpl: async (url) => {
                if (pages.has(url))
                    return new Response(pages.get(url), { status: 200, headers: { "content-type": "text/html" } });
                return new Response("Cloudflare blocked", { status: 403, headers: { "content-type": "text/html" } });
            },
            onProgress: async (ev) => { progressEvents.push(ev); },
        });

        assert.equal(res.claims[0].verification.status, "supported");
        assert.equal(res.claims[1].verification.status, "weak");
        assert.equal(res.claims[2].verification.status, "unverified");
        assert.equal(res.claims[3].verification.status, "unverified");
        assert.match(res.claims[3].verification.reason, /source_unreachable:blocked/);
        assert.equal(res.claims[4].verification.status, "unverified");
        assert.equal(res.claims[4].verification.reason, "no_citation");

        assert.deepEqual(
            {
                checkedClaims: res.summary.checkedClaims,
                supported: res.summary.supported,
                weak: res.summary.weak,
                unverified: res.summary.unverified,
                pagesChecked: res.summary.pagesChecked,
                pagesLoaded: res.summary.pagesLoaded,
            },
            { checkedClaims: 5, supported: 1, weak: 1, unverified: 3, pagesChecked: 2, pagesLoaded: 1 }
        );
        assert.equal(progressEvents.length, 1);

        // Standalone classifyClaim check on keyword overlap fallback (no numbers/dates/names)
        const overlapPage = new Map([
            ["https://example.com/kw", { url: "https://example.com/kw", ok: true, text: "deterministic verification provenance across multiple retrieved benchmarks" }],
        ]);
        const kwClaim = classifyClaim({ text: "verification provenance checks benchmarks", urls: ["https://example.com/kw"] }, overlapPage);
        assert.equal(kwClaim.status, "supported");
        assert.equal(kwClaim.reason, "keyword_overlap");
    });

    it("resolveVerifyDefault parses env flags cleanly", () => {
        assert.equal(resolveVerifyDefault({}), false);
        assert.equal(resolveVerifyDefault({ PERPLEXITY_VERIFY_CLAIMS: "1" }), true);
        assert.equal(resolveVerifyDefault({ PERPLEXITY_VERIFY_CLAIMS: "true" }), true);
        assert.equal(resolveVerifyDefault({ PERPLEXITY_VERIFY_CLAIMS: "0" }), false);
    });
});
