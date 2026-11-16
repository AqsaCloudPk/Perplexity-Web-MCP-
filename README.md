# Perplexity Web Orchestrator (`perplexity-web-mcp`)

Portable MCP stdio server + `perplexity-orchestrator` skill bundle for connecting AI coding agents (**Claude Code**, **Cursor**, **OpenCode**, **Antigravity**, and other MCP clients) to your Perplexity web session via Playwright.

> **Privacy & Sharing Notice**: This bundle is sanitized — it contains **no** `.playwright/` session cookies, **no** `config.json`, and **no** user-specific file paths. `.gitignore` excludes `node_modules/`, `.playwright/`, and `config.json` so it can be shared safely as a Git repo or zip archive.

---

## Included Features

- **5 MCP Tools**: `list_models`, `set_default_model`, `search`, `search_advanced`, and `login`.
- **15-Minute Default Timeout (`900s`)**: Long reasoning prompts and Pro models get `900s` by default, configurable per request via `timeout_seconds` (up to `1800s` / 30 min) or globally via `--timeout=<seconds>`.
- **Non-Intrusive Minimized Browser**: Launches headed Chromium off-screen and minimizes it so interactive browsing stays out of your way while avoiding headless bot blocks.
- **Clean Lifecycle Management**: Cleans up stale Chromium profile locks on startup and shuts down cleanly on `stdin` close, `SIGINT`, `SIGTERM`, and `SIGHUP`.
- **Cancellation-Safe & Progress-Aware (`@modelcontextprotocol/sdk`)**: Listens to MCP `notifications/cancelled` (`AbortSignal`), aborts queued/in-flight waits cleanly, emits `notifications/progress` updates every `~5s`, and persists incremental `-partial.txt` checkpoints every `~30s` (or immediately on abort/timeout).
- **Claim-Level Citation Provenance**: Preserves inline `[1]`, `[2]` citation references inside answers (`data-pplx-citation-url` pills + anchor tags), maps claims to cited URLs (`Claim Provenance` section in `.txt` / compact answers), and hovers top citation cards (`<=1.8s` budget) to recover page titles, snippets, dates, and multi-source links.
- **Optional Official Agent API Hybrid (`PERPLEXITY_API_KEY`)**: Pass `backend: "api"` (or set `PERPLEXITY_API_KEY` with `backend: "auto"`) to call Perplexity's official `/v1/agent` endpoint directly (`1–5s` latency, official `search_results` snippets/dates, zero UI scraping/ToS exposure) while keeping Playwright Pro browser mode as the zero-extra-cost default.
- **Structured Typed Errors & Metadata JSON**: Returns typed JSON error payloads (`LOGIN_REQUIRED`, `CLOUDFLARE_CHALLENGE`, `SELECTOR_MISSING`, `MODEL_UNAVAILABLE`, `CANCELLED`, `TIMEOUT`, `INVALID_PARAMS`, `PROFILE_UNAVAILABLE`, `API_ERROR`), extracts up to `50` sources by default (`PERPLEXITY_MAX_SOURCES`) plus downloadable attachment links, and appends a compact `Metadata` JSON line.
- **Poolable Concurrent Browser Profiles**: Supports `PERPLEXITY_PROFILE_DIRS` (semicolon/comma-separated profile directories) and per-call `profile` arguments (`list_models`, `search`, `search_advanced`, `login`) with independent per-profile browser contexts and queues so multiple agents/calls can run in parallel.
- **Long-Output `.txt` File Spooling**: Answers at or above `15000` chars (or any query passed with `output_file`) automatically save to a UTF-8 `.txt` file (`./outputs/` by default) and return a compact preview, counts, sources, and `Thread URL` so coding agents can read large results in slices instead of overflowing context.
- **Portable Profile Path**: Defaults to `./.playwright/profile` inside this directory, or accepts `PERPLEXITY_PROFILE_DIR` to point each agent or workspace to a specific profile folder.
- **Cross-Agent Skill**: Includes `skills/perplexity-orchestrator/SKILL.md` implementing the **Discover -> Research -> Iterate (`thread_url`) -> Compare -> Test -> Adopt** workflow.

---

## Folder Structure

```text
perplexity-web-orchestrator/
├── dist/
│   ├── index.js       # MCP SDK stdio entry point (progress, cancellation, typed errors)
│   ├── browser.js     # Poolable Playwright profile manager, off-screen/minimized handling, cleanup
│   ├── auth.js        # Cancellation-safe session check & interactive login flow
│   ├── search.js      # Model/source selection, claim provenance, hover cards & streaming
│   ├── api.js         # Optional Perplexity official /v1/agent REST backend
│   ├── output.js      # Long-output .txt spooling, Claim Provenance, checkpoints, metadata
│   └── errors.js      # Typed PerplexityMcpError codes and normalization
├── configs/
│   ├── claude-code.mcp.json
│   ├── cursor.mcp.json
│   ├── opencode.json
│   └── antigravity.mcp_config.json
├── skills/
│   └── perplexity-orchestrator/
│       └── SKILL.md
├── .gitignore
├── LICENSE            # MIT (upstream quequiere/perplexity-web-mcp)
├── package.json
└── README.md
```

---

## Quick Setup

### 1. Prerequisites (For New Machines / Shared Recipients)

Requires **Node.js >= 20**. Inside the copied directory:

```bash
npm install --omit=dev
npx playwright install chromium
```

*(If you are using `G:/perplexity-web-orchestrator` directly on the machine where it was prepared, `node_modules` and Chromium are already installed.)*

---

### 2. First-Time Perplexity Login

The first time any agent calls a `perplexity-web` tool, or when you explicitly run `login`, a Chromium window opens on `https://www.perplexity.ai/` so you can sign in once. Session cookies are stored locally in `.playwright/profile` (git-ignored) unless overridden by `PERPLEXITY_PROFILE_DIR`.

---

### 3. Connect Your Coding Agent

Replace `G:/perplexity-web-orchestrator` below if you cloned or moved this folder somewhere else.

#### Claude Code
- **MCP config**: Copy [`configs/claude-code.mcp.json`](configs/claude-code.mcp.json) into your project's `.mcp.json` or merge the `perplexity-web` entry into `~/.claude.json`, **or** run:
  ```bash
  claude mcp add perplexity-web -- node G:/perplexity-web-orchestrator/dist/index.js
  ```
- **Skill**: Copy `skills/perplexity-orchestrator/` into:
  - Global: `~/.claude/skills/perplexity-orchestrator/SKILL.md`
  - Project: `.claude/skills/perplexity-orchestrator/SKILL.md`

#### Cursor
- **MCP config**: Merge [`configs/cursor.mcp.json`](configs/cursor.mcp.json) into `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).
- **Skill**: Copy `skills/perplexity-orchestrator/` into `.cursor/skills/perplexity-orchestrator/SKILL.md` (or `~/.cursor/skills/perplexity-orchestrator/SKILL.md`).

#### OpenCode
- **MCP config**: Merge [`configs/opencode.json`](configs/opencode.json) into `~/.config/opencode/opencode.json` (global) or `./opencode.json` (project).
- **Skill**: Copy `skills/perplexity-orchestrator/` into:
  - Global: `~/.config/opencode/skills/perplexity-orchestrator/SKILL.md`
  - Project: `.opencode/skills/perplexity-orchestrator/SKILL.md`

#### Antigravity
- **MCP config**: Merge [`configs/antigravity.mcp_config.json`](configs/antigravity.mcp_config.json) into `~/.gemini/config/mcp_config.json`.
- **Skill**: Copy `skills/perplexity-orchestrator/` into `~/.gemini/config/skills/perplexity-orchestrator/SKILL.md`.

---

## Environment Variables & CLI Options

| Option | Default | Description |
| --- | --- | --- |
| `--timeout=<seconds>` | `900` (15 min) | CLI flag overriding the default search timeout in `dist/index.js`. |
| `PERPLEXITY_PROFILE_DIR` | `./.playwright/profile` | Override directory used to store default Chromium profile & Perplexity cookies. |
| `PERPLEXITY_PROFILE_DIRS` | *(unset)* | Semicolon/comma-separated list of profile directories for automatic concurrent multi-browser pooling. |
| `PERPLEXITY_PROFILES_ROOT` | `./.playwright/profiles` | Base folder for named `profile` arguments (e.g. `profile: "worker-2"`). |
| `PERPLEXITY_MAX_SOURCES` | `50` | Maximum cited links extracted per answer (`0` extracts all unique links). |
| `PERPLEXITY_OUTPUT_DIR` | `./outputs` | Directory where long responses (`>= 15000` chars), checkpoints, and relative `output_file` outputs are saved as `.txt`. |
| `PERPLEXITY_LONG_OUTPUT_CHARS` | `15000` | Character threshold for automatic `.txt` spooling (`0` disables auto-spooling while still honoring `output_file`). |
| `PERPLEXITY_HEADLESS` | `"false"` | Set `"true"` for headless Chromium (note: Perplexity/Cloudflare may require headed login first). |
| `PERPLEXITY_API_KEY` | *(unset)* | Optional official Perplexity API key; enables fast `backend: "api"` (`/v1/agent`) or automatic API routing in `"auto"` mode. |
| `PERPLEXITY_API_MODEL` | `"sonar"` | Default model ID when using `backend: "api"`. |
| `PERPLEXITY_API_EFFORT` | `"medium"` | Effort level (`fast`, `low`, `medium`, `high`, `xhigh`) for the `/v1/agent` endpoint. |
| `PERPLEXITY_BACKEND` | `"auto"` | Default backend policy (`auto`, `browser`, or `api`). |

---

## Running Multiple Agents Safely

Chromium locks a profile directory so **only one active browser process can use a given `PERPLEXITY_PROFILE_DIR` at a time**.

- **Option A (Simplest):** Point all agents at `G:/perplexity-web-orchestrator`, log in once, and run Perplexity queries from one active agent session at a time.
- **Option B (Parallel agents):** Give a second agent its own `PERPLEXITY_PROFILE_DIR` in its MCP `env` block (e.g., `G:/perplexity-profiles/claude-code`) and run `login` once for that agent.

---

## License & Attribution

Licensed under the [MIT License](LICENSE). Built on top of [`perplexity-web-mcp`](https://github.com/quequiere/perplexity-web-mcp) by `quequiere`.
