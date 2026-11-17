import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPublicHost, isBlockedAddress, parsePublicUrl, BlockedAddressError } from "../dist/net-guard.js";
import { fetchPageText } from "../dist/verify.js";
import { writeTextOutputFile, OutputPathError, resolveOutputDir } from "../dist/output.js";
import { detectOpenCodeLayout, mergeClientConfig, parseArgs, buildServerSpec } from "../dist/setup.js";
import { resolveLoginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS } from "../dist/auth.js";

describe("security: net-guard.js & SSRF protection", () => {
    it("isBlockedAddress correctly blocks loopback, private, link-local, metadata, and IPv6 local addresses", () => {
        const blocked = [
            "127.0.0.1",
            "127.0.1.1",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254", // Cloud metadata
            "169.254.1.1",
            "0.0.0.0",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:a9fe:a9fe",
        ];
        for (const ip of blocked) {
            assert.equal(isBlockedAddress(ip), true, `Expected ${ip} to be blocked`);
        }
    });

    it("isBlockedAddress allows public internet IP addresses", () => {
        const allowed = [
            "8.8.8.8",
            "1.1.1.1",
            "140.82.121.4", // GitHub
            "2606:4700:4700::1111", // Cloudflare DNS
        ];
        for (const ip of allowed) {
            assert.equal(isBlockedAddress(ip), false, `Expected ${ip} to be allowed`);
        }
    });

    it("parsePublicUrl rejects invalid schemes, credentials, and internal hostnames", () => {
        assert.equal(parsePublicUrl("file:///etc/passwd").ok, false);
        assert.equal(parsePublicUrl("ftp://example.com/file").ok, false);
        assert.equal(parsePublicUrl("http://user:pass@example.com/").ok, false);
        assert.equal(parsePublicUrl("http://localhost:8080/").ok, false);
        assert.equal(parsePublicUrl("http://server.local/").ok, false);
        assert.equal(parsePublicUrl("http://api.internal/").ok, false);
        assert.equal(parsePublicUrl("http://127.0.0.1:3000/").ok, false);
        assert.equal(parsePublicUrl("http://169.254.169.254/latest/meta-data").ok, false);

        const ok = parsePublicUrl("https://example.com/docs/page");
        assert.equal(ok.ok, true);
        assert.equal(ok.host, "example.com");
    });

    it("assertPublicHost throws BlockedAddressError for private/metadata IPs or resolutions", async () => {
        await assert.rejects(
            async () => assertPublicHost("127.0.0.1"),
            (err) => err instanceof BlockedAddressError
        );

        await assert.rejects(
            async () => assertPublicHost("169.254.169.254"),
            (err) => err instanceof BlockedAddressError
        );

        // Test with simulated internal DNS resolution
        const fakeLookup = async () => [{ address: "10.0.0.5", family: 4 }];
        await assert.rejects(
            async () => assertPublicHost("internal-service.com", fakeLookup),
            (err) => err instanceof BlockedAddressError
        );
    });

    it("fetchPageText refuses to connect to blocked IPs or handle malicious redirects", async () => {
        // Direct attempt to loopback
        const loopbackRes = await fetchPageText("http://127.0.0.1:8080/secret");
        assert.equal(loopbackRes.ok, false);
        assert.equal(loopbackRes.reason, "blocked_address");

        // Direct attempt to cloud metadata service
        const metadataRes = await fetchPageText("http://169.254.169.254/latest/meta-data");
        assert.equal(metadataRes.ok, false);
        assert.equal(metadataRes.reason, "blocked_address");

        // Attempt redirecting to an internal IP
        const redirectRes = await fetchPageText("https://example.com/redirect-to-internal", {
            lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }], // example.com
            fetchImpl: async () => new Response(null, {
                status: 302,
                headers: { location: "http://127.0.0.1:9000/internal-admin" },
            }),
        });
        assert.equal(redirectRes.ok, false);
        assert.equal(redirectRes.reason, "blocked_address");
    });
});

describe("security: output.js & path traversal protection", () => {
    const tmpDir = path.join(os.tmpdir(), `perplexity-test-output-${Date.now()}`);

    it("writes relative files safely within outputDir", () => {
        fs.mkdirSync(tmpDir, { recursive: true });
        const res = writeTextOutputFile({
            fullDocument: "test content",
            query: "test query",
            outputFile: "safe-report.txt",
            env: { PERPLEXITY_OUTPUT_DIR: tmpDir },
        });
        assert.equal(res.ok, true);
        assert.ok(res.targetPath.startsWith(tmpDir));
        assert.equal(fs.existsSync(res.targetPath), true);
        assert.equal(fs.readFileSync(res.targetPath, "utf8"), "test content");
    });

    it("rejects path traversal attempts (.. escapes)", () => {
        const res = writeTextOutputFile({
            fullDocument: "evil content",
            query: "exploit",
            outputFile: "../evil.txt",
            env: { PERPLEXITY_OUTPUT_DIR: tmpDir },
        });
        assert.equal(res.ok, false);
        assert.match(res.error, /path traversal rejected/i);
    });

    it("rejects absolute paths by default", () => {
        const absTarget = path.join(os.tmpdir(), "unauthorized-absolute.txt");
        const res = writeTextOutputFile({
            fullDocument: "evil content",
            query: "exploit",
            outputFile: absTarget,
            env: { PERPLEXITY_OUTPUT_DIR: tmpDir },
        });
        assert.equal(res.ok, false);
        assert.match(res.error, /must be a relative path/i);
    });

    it("allows absolute paths only when PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT=1 is set", () => {
        const absTarget = path.join(tmpDir, "allowed-subdir", "allowed-absolute.txt");
        const res = writeTextOutputFile({
            fullDocument: "allowed content",
            query: "allowed",
            outputFile: absTarget,
            env: {
                PERPLEXITY_OUTPUT_DIR: tmpDir,
                PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT: "1",
            },
        });
        assert.equal(res.ok, true);
        assert.equal(fs.existsSync(res.targetPath), true);
        assert.equal(fs.readFileSync(res.targetPath, "utf8"), "allowed content");
    });
});

describe("setup CLI & config ergonomics", () => {
    it("detectOpenCodeLayout correctly identifies v2 vs legacy config", () => {
        const v2Config = { mcp: { servers: { test: {} } } };
        assert.equal(detectOpenCodeLayout(v2Config), "v2");

        const legacyConfig = { mcp: { "perplexity-web": { enabled: true } } };
        assert.equal(detectOpenCodeLayout(legacyConfig), "legacy");

        const emptyConfig = {};
        assert.equal(detectOpenCodeLayout(emptyConfig), "v2");
    });

    it("mergeClientConfig for OpenCode writes correct v2 structure with execution timeout", () => {
        const spec = buildServerSpec({ mode: "npx" });
        const merged = mergeClientConfig("opencode", {}, spec, { layout: "v2" });

        assert.ok(merged.mcp);
        assert.ok(merged.mcp.servers);
        assert.ok(merged.mcp.servers["perplexity-web"]);
        const entry = merged.mcp.servers["perplexity-web"];
        assert.equal(entry.type, "local");
        assert.ok(Array.isArray(entry.command));
        assert.equal(entry.timeout.execution, 960000);
        assert.equal(entry.timeout.startup, 60000);
        assert.equal(entry.enabled, undefined, "V2 schema must not contain deprecated 'enabled'");
    });

    it("mergeClientConfig for Claude and Cursor creates stdio entries", () => {
        const spec = buildServerSpec({ mode: "npx" });
        const claudeCfg = mergeClientConfig("claude", {}, spec);
        assert.equal(claudeCfg.mcpServers["perplexity-web"].type, "stdio");

        const cursorCfg = mergeClientConfig("cursor", {}, spec);
        assert.equal(cursorCfg.mcpServers["perplexity-web"].type, "stdio");
    });

    it("resolveLoginTimeoutMs defaults to 15 minutes and accepts custom env", () => {
        assert.equal(resolveLoginTimeoutMs({}), DEFAULT_LOGIN_TIMEOUT_MS);
        assert.equal(DEFAULT_LOGIN_TIMEOUT_MS, 15 * 60 * 1000);

        const custom = resolveLoginTimeoutMs({ PERPLEXITY_LOGIN_TIMEOUT_MS: "600000" });
        assert.equal(custom, 600000);
    });

    it("parseArgs correctly handles flags with and without values", () => {
        const parsed = parseArgs(["--client", "opencode", "--dry-run", "--mode=npx", "--skip-browser"]);
        assert.equal(parsed.client, "opencode");
        assert.equal(parsed["dry-run"], true);
        assert.equal(parsed.mode, "npx");
        assert.equal(parsed["skip-browser"], true);
    });
});
