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

The setup command automatically installs Playwright Chromium, merges the MCP server configuration into your client's config file (creating a timestamped backup first), and installs the `perplexity-orchestrator` skill.

### Sign In Once

```bash
npx -y @aqsacloud/perplexity-web-mcp login
```

A dedicated automation browser window titled **`>>> SIGN IN HERE <<< Perplexity`** will open. Sign into your Perplexity account (Free or Pro). Your session cookies are stored securely on your local machine (`~/.perplexity-web-mcp/.playwright/profile`) and reused across restarts.

Verify your installation at any time:

```bash
npx -y @aqsacloud/perplexity-web-mcp doctor --online
```

> **Windows PowerShell Note:** If `npx` or `npm` fails with `PSSecurityException (running scripts is disabled)`, use `npx.cmd` / `npm.cmd` instead.

---

## 🛠️ MCP Tools Included

1. **`search`**: Query Perplexity with claim-level `[1]`, `[2]` citation provenance, optional live citation verification (`verify_claims: true`), TTL caching, and automatic long-output disk spooling (`>= 15,000` chars).
2. **`search_advanced`**: Filter sources across `web`, `academic`, or `social`.
3. **`compare_models`**: Query 2–5 frontier models concurrently across browser profile pools or parallel API calls, returning agreed facts, divergent specifics, and shared citations.
4. **`list_models`**: Discover currently available frontier models on your Perplexity tier.
5. **`set_default_model`**: Set a sticky default model (e.g. `GPT-6.1 Sol`, `Claude Sonnet 5.5`, `Best`).
6. **`health_check`**: Verify browser launch, Cloudflare status, composer input, and write permissions in ~2 seconds (auto-capturing failure snapshots under `./diagnostics/` if unhealthy).
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
          "@aqsacloud/perplexity-web-mcp@latest"
        ],
        "environment": {
          "PERPLEXITY_HEADLESS": "false"
        },
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
claude mcp add perplexity-web -- npx -y @aqsacloud/perplexity-web-mcp@latest
```

Or in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "perplexity-web": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@aqsacloud/perplexity-web-mcp@latest"],
      "env": {
        "PERPLEXITY_HEADLESS": "false"
      }
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
      "args": ["-y", "@aqsacloud/perplexity-web-mcp@latest"],
      "env": {
        "PERPLEXITY_HEADLESS": "false"
      }
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
      "args": ["/c", "npx", "-y", "@aqsacloud/perplexity-web-mcp@latest"],
      "env": {
        "PERPLEXITY_HEADLESS": "false"
      }
    }
  }
}
```

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
Perplexity sessions in your everyday Chrome or Edge are **not** shared with the MCP server. Playwright runs in an isolated automation browser profile (`~/.perplexity-web-mcp/.playwright/profile`) so it doesn't interfere with your personal browsing.

You must run the login command:
```bash
npx -y @aqsacloud/perplexity-web-mcp login
```
and sign into the window that opens with the title **`>>> SIGN IN HERE <<< Perplexity`**.

### "Why does a browser window open during searches?"
Perplexity uses Cloudflare Turnstile bot detection which blocks headless Chromium instances. To ensure searches never get blocked, the server launches a visible Chromium window off-screen or minimized.

### "How do I use the official API instead of browser automation?"
Set your official Perplexity API key:
```bash
export PERPLEXITY_API_KEY="pplx-xxxxxxxxxxxxxxxx"
```
The server will automatically route queries to the official Perplexity Agent API (`/v1/agent`), providing sub-second latency with zero UI automation or Cloudflare involvement.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PERPLEXITY_DATA_DIR` | `~/.perplexity-web-mcp` | Directory for browser profiles, cache, and outputs when installed via npm/npx. |
| `PERPLEXITY_API_KEY` | *(unset)* | Enables official Perplexity REST API backend (`/v1/agent`). |
| `PERPLEXITY_BACKEND` | `"auto"` | Execution backend (`"auto"`, `"browser"`, or `"api"`). |
| `PERPLEXITY_OUTPUT_DIR` | `./outputs` | Directory where answers $\ge 15,000$ chars are spooled to `.txt`. |
| `PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT` | `"0"` | Set to `"1"` to allow `output_file` to write outside the outputs directory. |
| `PERPLEXITY_LOGIN_TIMEOUT_MS` | `900000` (15m) | Maximum wait time for interactive login. |
| `PERPLEXITY_CACHE_TTL_SECONDS` | `3600` (1h) | TTL for repeated query caching (`0` disables). |
| `PERPLEXITY_VERIFY_CLAIMS` | `"0"` | Set to `"1"` to enable claim verification by default. |

---

## ⚖️ Disclaimer

This is an **unofficial community project** and is not affiliated with, endorsed by, or sponsored by Perplexity AI, Inc. Use responsibly and in accordance with Perplexity's Terms of Service. For enterprise deployments, use the official API backend (`PERPLEXITY_API_KEY`).

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
