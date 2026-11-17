# Changelog

All notable changes to `perplexity-web-orchestrator` (`@aqsacloud/perplexity-web-mcp`) are documented in this file.

## [1.5.0] - 2026-11-17

### Security & Hardening
- **SSRF Protection (`dist/net-guard.js`)**: Outbound citation verification now enforces strict public-only addressing. Resolves DNS before connection and drops connections to loopback (`127.0.0.0/8`, `::1`), RFC1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local / cloud metadata endpoints (`169.254.169.254`, `fe80::/10`), carrier-grade NAT, and IPv6 unique local. Custom socket lookup protects against connect-time DNS rebinding (TOCTOU).
- **Manual Redirect Validation (`dist/verify.js`)**: Switched from `redirect: "follow"` to `redirect: "manual"`. Every redirect hop (up to 5) is parsed, inspected, and validated against the public address policy before following.
- **Path Traversal Sandboxing (`dist/output.js`)**: Added `OutputPathError`. Restricts all `output_file` writes inside `PERPLEXITY_OUTPUT_DIR` (or `./outputs`). Traversal sequences (`..`), NUL bytes, and symlink escapes are rejected by default. Arbitrary absolute paths outside the outputs folder require explicit opt-in via `PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT=1`.
- **Targeted Output Pruning (`dist/output.js`)**: `pruneOldOutputs` now only prunes server-generated timestamped `.txt` files matching `OWN_OUTPUT_FILE_PATTERN`, leaving any user-placed or custom files untouched.

### Distribution & First-Run UX
- **Scoped Package Name**: Rebranded to `@aqsacloud/perplexity-web-mcp` for npm distribution with full repository, bugs, homepage, and provenance metadata in `package.json`.
- **Interactive Setup CLI (`dist/setup.js`, `dist/cli.js`)**: Added `npx @aqsacloud/perplexity-web-mcp setup --client <client>` supporting **OpenCode**, **Claude Code**, **Cursor**, and **Antigravity**. Automatically checks Node >= 20, verifies/installs Playwright Chromium, safely merges MCP configs with automatic `.bak` backups, and installs the orchestrator skill.
- **OpenCode V2 Specification**: Fully aligned with OpenCode V2 schema (`mcp.servers.<name>` with `type: "local"`, `command` array, `disabled` semantics, and proper `timeout: { startup: 60000, execution: 960000 }` avoiding false 5s timeouts).
- **Portable User Data Root (`dist/paths.js`)**: Centralized mutable data storage (browser profiles, cache, outputs) in `~/.perplexity-web-mcp` when installed via npm/npx, preserving login sessions across npm cache wipes while supporting custom overrides via `PERPLEXITY_DATA_DIR`.
- **Login Ergonomics (`dist/auth.js`)**: Increased interactive login timeout from 5 minutes to 15 minutes (`PERPLEXITY_LOGIN_TIMEOUT_MS`), added clear window title marker (`>>> SIGN IN HERE <<< Perplexity`), returned the profile directory path in the tool result, and provided `scripts/manual-login.mjs`.
- **Doctor Command (`dist/setup.js`)**: Added `npx @aqsacloud/perplexity-web-mcp doctor [--online]` to quickly verify prerequisites, dependencies, Chromium installation, profile writability, and live session health.
- **Fixed Skill Schema Mismatch**: Fixed `skills/perplexity-orchestrator/SKILL.md` signature for `health_check({ profile? })`.
- **CI / GitHub Actions**: Added `.github/workflows/ci.yml` matrix testing across Ubuntu, macOS, and Windows on Node 20, 22, and 24, along with `.github/workflows/release.yml` with provenance publishing.

## [1.4.0] - 2026-11-17

### Added
- **`compare_models` MCP tool** (`dist/compare.js`): Sends a single query to `2–5` Perplexity models concurrently (across `PERPLEXITY_PROFILE_DIRS` pool slots or parallel API calls), compares agreed key facts, single-model specifics, and shared citations, and auto-spools long comparisons to `./outputs/`.
- **`health_check` MCP tool** (`dist/search.js`): Performs a fast diagnostic pass across browser launch, Perplexity navigation, Cloudflare status, authenticated session, search input composer, `+`/sources trigger, hydrated model menu, and local cache/output/diagnostics writability.
- **Claim-to-source verification (`verify_claims`)** (`dist/facts.js`, `dist/verify.js`): Fetches cited pages (bounded HTTP streaming up to `3 MB` / page with SSRF-safe public URL limits), extracts dates, versions, numbers with units, and names, and labels each claim `supported`, `weak`, or `unverified`. Opt in per call via `verify_claims: true` or globally via `PERPLEXITY_VERIFY_CLAIMS=1`.
- **Automatic failure snapshots** (`dist/diagnostics.js`): Captures local git-ignored `.html`, `.png`, and `.json` snapshots under `./diagnostics/` (`PERPLEXITY_DIAGNOSTICS_DIR`) when selectors fail, empty `TIMEOUT`s occur, or `health_check` detects degraded/unhealthy state.
- **Repeated query cache** (`dist/cache.js`): Caches non-thread completed queries by backend + model + sources + normalized query for `3600s` (`PERPLEXITY_CACHE_TTL_SECONDS`, `0` disables), with per-call bypass via `no_cache: true`.
- **18-question evaluation benchmark (`npm run eval`)** (`eval/questions.json`, `eval/run-eval.js`): Measures success rate, min/p50/p95/max/mean latency, timeout rate, live citation URL reachability, and claim verification rates across coding, documentation, and current-events prompts.
- **Automated unit, DOM & stdio MCP test suite (`npm test`)** (`test/*.test.js`): Covers fact extraction, claim verification, caching, diagnostic snapshots, output formatting/spooling, multi-model comparison, API payload parsing, typed error normalization, profile concurrency/cancellation, headless virtualized-thread DOM detection, and end-to-end stdio MCP tool calls.

### Fixed
- **Long virtualized Perplexity thread timeouts**: Perplexity virtualizes older turns in long threads so DOM `.prose` count stays capped (e.g. `2 -> 2`). `getTurnCounts` and `waitForAnswerComplete` now mark pre-existing `.prose` elements (`data-mcp-old-prose="1"`) and track tail text signatures plus `Stop generating` button transitions, and expose `turnCount` and `virtualizedThread` in result metadata.
- **Guard empty verification duration**: `formatClaimsBlock` in `dist/output.js` omits `durationMs` when not a finite number instead of formatting `undefinedms`.
- **Code fence citation false positives**: `extractClaimsFromCitedText` in `dist/api.js` ignores `[n]` markers inside fenced Markdown code blocks.
- **Cache key default model alignment**: `executeSearchQuery` normalizes unset browser models consistently with `buildCacheKey` (`"(default)"`).
- **Windows checkpoint cleanup resilience**: `removeCheckpoint` retries transient `EBUSY` locks cleanly.

## [1.3.0] - 2026-11-16

### Added
- Claim-level `[1]`, `[2]` inline citation preservation and `Claim Provenance` mapping (`dist/search.js`, `dist/output.js`).
- Optional official Perplexity Agent API backend (`dist/api.js`, `PERPLEXITY_API_KEY`, `backend: "auto" | "browser" | "api"`).
- Typed structured MCP error payloads (`dist/errors.js`: `LOGIN_REQUIRED`, `CLOUDFLARE_CHALLENGE`, `SELECTOR_MISSING`, `MODEL_UNAVAILABLE`, `INVALID_PARAMS`, `TIMEOUT`, `CANCELLED`, `PROFILE_UNAVAILABLE`, `API_ERROR`, `INTERNAL_ERROR`).
- Concurrent poolable browser profiles (`PERPLEXITY_PROFILE_DIRS` / per-call `profile`) and native `@modelcontextprotocol/sdk` `AbortSignal` cancellation + progress notifications + `-partial.txt` checkpoints.
- Long-output auto-spooling (`>= 15000` chars) to `./outputs/` (`PERPLEXITY_OUTPUT_DIR`).

## [1.1.1] - Initial Upstream Baseline

- Base Playwright Perplexity MCP server (`list_models`, `set_default_model`, `search`, `search_advanced`, `login`) by `quequiere`.
