# @aqsacloud/perplexity-web-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/Node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-FastMCP-purple.svg)](https://modelcontextprotocol.io/)

A production-hardened Model Context Protocol (MCP) stdio server and orchestration skill that connects AI coding assistants (**OpenCode**, **Claude Code**, **Cursor**, **Antigravity**) with **Perplexity AI**.

Supports multi-model consensus comparisons across Pro models (**GPT-6.1 Sol**, **Claude Sonnet 5.5**, **Gemini 4 Hydrogen**, **Grok 4.7**), active claim-to-source HTTP fact verification, TTL caching, disk output spooling, and an optional official REST API backend.

---

## ⚡ 60-Second Quickstart

Requires **Node.js >= 20**.

Run the automated setup command for your editor of choice:

```bash
# For OpenCode (V2 config)
npx -y @aqsacloud/perplexity-web-mcp setup --client opencode

# For Claude Code
npx -y @aqsacloud/perplexity-web-mcp setup --client claude

# For Cursor
npx -y @aqsacloud/perplexity-web-mcp setup --client cursor

# For Antigravity
npx -y @aqsacloud/perplexity-web-mcp setup --client antigravity
```

The setup command automatically installs Playwright Chromium, merges the MCP server configuration into your client's config file (creating a timestamped backup first), installs the `perplexity-orchestrator` skill, gives the client its own browser profile (`<data root>/profiles/<client>`), and prints the exact login command for that profile.

### Sign In Once

Run the login command for the client you configured (`setup` prints this exact line, including `--client`):

```bash
npx -y @aqsacloud/perplexity-web-mcp login --client opencode
```

A dedicated automation browser window titled **`>>> SIGN IN HERE <<< Perplexity`** will open. Sign into your Perplexity account (Free or Pro) **in that window**. Session cookies are stored locally in that client's profile:

- **npm / npx install:** `~/.perplexity-web-mcp/profiles/<client>/`
- **git clone:** `<repo>/profiles/<client>/` (git-ignored)
- **manual config without `--client`:** the shared default profile, `<data root>/.playwright/profile`

Treat the profile folder like a password: it holds your Perplexity session cookies. Never commit or share it. Repeat the login command once per client you configured.

Verify your installation at any time:

```bash
npx -y @aqsacloud/perplexity-web-mcp doctor --online --client opencode
```

> **Windows PowerShell Note:** If `npx` or `npm` fails with `PSSecurityException (running scripts is disabled)`, use `npx.cmd` / `npm.cmd` instead.

---

## 🛠️ MCP Tools Included

1. **`search`**: Query Perplexity with claim-level `[1]`, `[2]` citation provenance, optional live citation verification (`verify_claims: true`), TTL caching, and automatic long-output disk spooling (`>= 15,000` chars).
2. **`search_advanced`**: Filter sources across `web`, `academic`, or `social`.
3. **`compare_models`**: Query 2–5 frontier models sequentially by default (concurrently when multiple `PERPLEXITY_PROFILE_DIRS` profile slots or `backend: "api"` are configured), returning agreed facts, divergent specifics, and shared citations.
4. **`list_models`**: Discover currently available frontier models on your Perplexity tier.
5. **`set_default_model`**: Set a sticky default model (e.g. `GPT-6.1 Sol`, `Claude Sonnet 5.5`, `Best`).
6. **`health_check`**: Verify browser launch, Cloudflare status, composer input, and write permissions in ~5 seconds. Failure snapshots are written under the server's data directory (`~/.perplexity-web-mcp/diagnostics/` for npx installs; `<repo>/diagnostics/` for clones).
7. **`login`**: Verify or trigger interactive authentication for a browser profile.

---

## 💻 Manual Client Configuration

If you prefer configuring your editor manually instead of using `setup`:

### OpenCode (V2 Configuration)
In `~/.config/opencode/opencode.json` (global) or `./opencode.json` (workspace):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "perplexity-web": {
        "type": "local",
        "command": [
          "npx",
          "-y",
          "@aqsacloud/perplexity-web-mcp@1.5.2"
        ],
        "environment": {},
        "timeout": {
          "startup": 60000,
          "execution": 960000
        }
      }
    }
  }
}
```

### Claude Code
Add with the Claude CLI:

```bash
claude mcp add perplexity-web -- npx -y @aqsacloud/perplexity-web-mcp@1.5.2
```

Or in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "perplexity-web": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@aqsacloud/perplexity-web-mcp@1.5.2"],
      "env": {}
    }
  }
}
```

### Cursor
In `~/.cursor/mcp.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "perplexity-web": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@aqsacloud/perplexity-web-mcp@1.5.2"],
      "env": {}
    }
  }
}
```

### Antigravity
In `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "perplexity-web": {
      "command": "cmd.exe",
      "args": ["/c", "npx", "-y", "@aqsacloud/perplexity-web-mcp@1.5.2"],
      "env": {}
    }
  }
}
```

### Other Clients (Codex, Gemini CLI, VS Code, Windsurf, Cline, Zed, Continue)

Print a paste-ready stdio snippet (add `--client <name>` to include that client's isolated profile):

```bash
npx -y @aqsacloud/perplexity-web-mcp setup --print --client cursor
```

The output is wrapped in `mcpServers` for Claude/Cursor-style clients. Other clients use different shapes: OpenCode V2 uses `mcp.servers` with a `command` array and `environment`, and Zed uses `context_servers` with a nested `command` object. Use `setup --client opencode` to write OpenCode directly, or paste the inner server entry into your client's existing shape. Without `--client`, the snippet uses the shared default profile.

Client configs in this repository pin the exact version (`@1.5.2`) instead of a caret range. A caret is stripped by `cmd.exe` on Windows, which silently changes the resolved version; update the pin deliberately when you upgrade.

---

## 🔒 Security & Sandboxing

`@aqsacloud/perplexity-web-mcp` is hardened against untrusted web inputs and malicious prompts:

- **SSRF Protection (`dist/net-guard.js`)**: Outbound citation verification (`verify_claims`) checks every destination before connection. It rejects loopback (`127.0.0.1`, `::1`), private networks (`10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`), link-local / cloud metadata endpoints (`169.254.169.254`, `fe80::/10`), and validates all redirect hops manually. Connect-time DNS re-validation defeats DNS-rebinding attacks.
- **Path Traversal Sandboxing (`dist/output.js`)**: The `output_file` parameter restricts file writes strictly inside `PERPLEXITY_OUTPUT_DIR` (or `./outputs`). Traversal sequences (`..`), NUL bytes, and symlink breakouts throw `OutputPathError`. Writing to arbitrary absolute paths requires explicit opt-in (`PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT=1`).
- **Pruning Safety**: Stale output cleanup only prunes server-generated timestamped `.txt` files, never user-placed files.

For details, see [SECURITY.md](SECURITY.md).

---

## ❓ Troubleshooting & FAQ

### "I signed into my personal Chrome/Edge, but the tool still says unauthenticated"
Perplexity sessions in your everyday Chrome or Edge are **not** shared with the MCP server. Playwright runs in an isolated automation profile so it doesn't interfere with your personal browsing.

Sign in to the profile your client actually uses:

```bash
# The same --client you passed to setup
npx -y @aqsacloud/perplexity-web-mcp login --client opencode
```

and sign into the window titled **`>>> SIGN IN HERE <<< Perplexity`**. If you configured the client manually without `--client`, run `login` with no flag (shared default profile) or pass `--profile <name-or-path>`.

### "Why does a browser window open during searches?"
By default searches run **headless** (`PERPLEXITY_HEADLESS` defaults to `true`). The `login` command always opens a visible window so you can complete sign-in and any Cloudflare challenge.

If a headless session is challenged by Cloudflare Turnstile, set `PERPLEXITY_HEADLESS=false` in the server environment and restart the client. Visible mode launches Chromium off-screen or minimized, which lets the challenge complete without interrupting your desktop.

### "How do I use the official API instead of browser automation?"
Set your official Perplexity API key:
```bash
export PERPLEXITY_API_KEY="pplx-xxxxxxxxxxxxxxxx"
```
The server will automatically route queries to the official Perplexity Agent API (`/v1/agent`), providing sub-second latency with zero UI automation or Cloudflare involvement.

### "Can I run OpenCode + Cursor + Claude Code at the same time?"
When you use `setup --client <name>`, each client gets its own isolated browser profile directory (`~/.perplexity-web-mcp/profiles/<client>/` for npm/npx installs, `<repo>/profiles/<client>/` for clones), so multiple clients can run simultaneously without Chromium lock conflicts. If you configured manually, set `PERPLEXITY_PROFILE_DIR` to a unique path per client.

If another process is already using a profile, the server returns a typed `PROFILE_UNAVAILABLE` error instead of deleting its lock files or killing the browser. Close the other client/browser, or set `PERPLEXITY_FORCE_CLEANUP=1` to explicitly terminate the process holding that profile.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PERPLEXITY_DATA_DIR` | `~/.perplexity-web-mcp` (npm/npx) or repo root (clone) | Directory for browser profiles, cache, and outputs. |
| `PERPLEXITY_PROFILE_DIR` | `<data root>/.playwright/profile` | Browser profile directory. Setup generates a per-client path automatically. |
| `PERPLEXITY_PROFILE_DIRS` | *(unset)* | Semicolon/comma-separated list of profile directories for concurrent browser pool slots. |
| `PERPLEXITY_API_KEY` | *(unset)* | Enables official Perplexity REST API backend (`/v1/agent`). |
| `PERPLEXITY_BACKEND` | `"auto"` | Execution backend (`"auto"`, `"browser"`, or `"api"`). |
| `PERPLEXITY_HEADLESS` | `"true"` | Set to `"false"` to show the automation browser window (useful for debugging). |
| `PERPLEXITY_OUTPUT_DIR` | `./outputs` | Directory where answers ≥ 15,000 chars are spooled to `.txt`. |
| `PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT` | `"0"` | Set to `"1"` to allow `output_file` to write outside the outputs directory. |
| `PERPLEXITY_LOGIN_TIMEOUT_MS` | `900000` (15m) | Maximum wait time for interactive login. |
| `PERPLEXITY_CACHE_TTL_SECONDS` | `3600` (1h) | TTL for repeated query caching (`0` disables). |
| `PERPLEXITY_VERIFY_CLAIMS` | `"0"` | Set to `"1"` to enable claim verification by default. |
| `PERPLEXITY_FORCE_CLEANUP` | `"0"` | Set to `"1"` to terminate a live Chromium process holding the profile lock. Without it, a live owner returns `PROFILE_UNAVAILABLE`; stale locks are removed only when no owner exists. |

---

## ⚖️ Disclaimer

This is an **unofficial community project** and is not affiliated with, endorsed by, or sponsored by Perplexity AI, Inc. Use responsibly and in accordance with Perplexity's Terms of Service. For enterprise deployments, use the official API backend (`PERPLEXITY_API_KEY`).

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
