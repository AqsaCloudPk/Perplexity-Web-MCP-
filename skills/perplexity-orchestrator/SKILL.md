---
name: perplexity-orchestrator
description: Orchestrate local workspace coding with live web research, architecture planning, and multi-model second opinions via the perplexity-web MCP server. Use when a task benefits from combining local editing and verification tools with Perplexity AI models or multi-turn Perplexity threads.
---

# Perplexity Web Orchestrator

Use this skill when working in any coding agent (**Claude Code**, **Cursor**, **OpenCode**, **Antigravity**, or similar MCP-enabled tools) alongside the `perplexity-web` MCP server.

## Available MCP Tools (`perplexity-web`)

- `list_models({ profile? })` — List the models currently selectable in the active Perplexity session plus browser profile pool status.
- `set_default_model({ model, profile? })` — Pin the default model for subsequent `search` / `search_advanced` calls in this server process.
- `search({ query, model?, thread_url?, timeout_seconds?, output_file?, profile?, backend?, verify_claims?, no_cache? })` — Run a Perplexity search/reasoning query (or continue a virtualized long thread via `thread_url`) with claim-level `[1]`, `[2]` citation provenance, optional live source verification (`verify_claims: true` labels each claim `supported` / `weak` / `unverified`), MCP progress notifications, cancellation-safe partial `.txt` checkpoints, typed error JSON (`LOGIN_REQUIRED`, `CLOUDFLARE_CHALLENGE`, `SELECTOR_MISSING`, `MODEL_UNAVAILABLE`, `CANCELLED`, `TIMEOUT`, `API_ERROR`), TTL caching (`PERPLEXITY_CACHE_TTL_SECONDS`, bypass with `no_cache: true`), optional `profile` concurrency routing (`PERPLEXITY_PROFILE_DIRS`), and optional `backend` (`"auto"`, `"browser"`, or `"api"` with `PERPLEXITY_API_KEY`). Default timeout is `900s` (15 minutes, max `1800s`). Responses `>= 15000` chars (or any response with `output_file`) automatically save to a UTF-8 `.txt` file including Claim Provenance and return the path + preview + `Metadata` JSON.
- `search_advanced({ query, sources, model?, thread_url?, timeout_seconds?, output_file?, profile?, backend?, verify_claims?, no_cache? })` — Run a search scoped to specific Perplexity sources (`web`, `academic`, `social`) with the same timeouts, provenance & verification options, cache controls, progress/cancellation safety, `.txt` handling, profile routing, and hybrid backend support.
- `compare_models({ query, models?, sources?, timeout_seconds?, output_file?, backend?, verify_claims?, no_cache? })` — Fan out one prompt across `2–5` models concurrently (across `PERPLEXITY_PROFILE_DIRS` browser pool slots or parallel API requests) and return consensus facts, single-model specifics, shared citations, and per-model answers.
- `health_check({ profile? })` — Verify Perplexity browser launch, login session, Cloudflare clear state, composer input, `+`/sources trigger, hydrated model selector, and local dirs, auto-saving `.html`/`.png`/`.json` failure snapshots under `./diagnostics/` when unhealthy.
- `login({ profile? })` — Open the browser session interactively for the default or specified profile so the user can authenticate with Perplexity if a query reports `LOGIN_REQUIRED` or `CLOUDFLARE_CHALLENGE`.

## Orchestration Workflow

1. **Discover Models First**
   - Call `list_models` when model choice matters or before selecting a specialized/reasoning model for a review.
   - Use exact model names returned by `list_models` (or set a default once with `set_default_model`).

2. **Route Deep Research & Second Opinions to Perplexity**
   - Use `search` for architecture trade-offs, unfamiliar SDK/framework APIs, debugging hypotheses, and second-opinion code reviews.
   - Use `search_advanced` with targeted `sources` (for example `["web"]` for up-to-date docs/changelogs or `["academic"]` for papers and formal specifications).

3. **Iterate via `thread_url`**
   - When digging deeper into the same topic or refining an architecture proposal, pass the returned `thread_url` into follow-up `search` / `search_advanced` calls instead of re-explaining background context.

4. **Compare -> Test -> Adopt**
   - **Specify constraints upfront**: Include target language, runtime/framework versions, error-handling expectations, edge cases, and output structure inside `query`.
   - **Manage long prompts cleanly**: Use `timeout_seconds` (up to `1800`) for complex reasoning tasks, or chunk multi-module designs across `thread_url` turns rather than cramming unrelated subsystems into one call.
   - **Compare before committing**: Use `compare_models` (or compare Perplexity's proposal against your baseline plan) to spot agreed key facts and single-model caveats, and pass `verify_claims: true` when dates, versions, or API claims need live source checking (`supported` / `weak` / `unverified`).
   - **Verify locally**: Never adopt generated code blindly. Implement or prototype locally and run syntax checks, unit tests, type checks, or benchmarks in the workspace before finalizing.

5. **Authentication & Health Handling**
   - Run `health_check` if Perplexity selectors fail or behavior looks degraded (auto-saves `.html`/`.png`/`.json` snapshots under `./diagnostics/`). If a tool call reports `LOGIN_REQUIRED` or `CLOUDFLARE_CHALLENGE`, call `login` and ask the user to sign in once in the browser window.
