# Security Policy

## Reporting Security Issues

Please **do not** open public GitHub issues for security vulnerabilities. Instead, report them via email to `security@aqsacloud.com` or via GitHub Private Vulnerability Reporting at:
https://github.com/AqsaCloudPk/Perplexity-Web-MCP-/security/advisories/new

We appreciate responsible disclosure and aim to acknowledge reports within 48 hours and release patches promptly.

---

## Security Model & Protections

`@aqsacloud/perplexity-web-mcp` connects local AI coding agents to Perplexity search results and optionally verifies citations against public web pages. Because search results and web pages are untrusted inputs, the server enforces several security boundaries:

### 1. SSRF & Outbound HTTP Protection (`dist/net-guard.js`, `dist/verify.js`)
When claim verification (`verify_claims: true`) is enabled, the server fetches cited external URLs. To prevent Server-Side Request Forgery (SSRF):
- **Protocol Allowlist**: Only `http:` and `https:` protocols are accepted. `file:`, `gopher:`, `data:`, and embedded user credentials (`user:pass@host`) are strictly rejected.
- **IP Range Blocklist**: Resolves DNS before connecting and drops connections to loopback (`127.0.0.0/8`, `::1`), RFC1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local / cloud metadata ranges (`169.254.169.254`, `169.254.0.0/16`, `fe80::/10`), carrier-grade NAT, test networks, and IPv6 unique local (`fc00::/7`).
- **Connect-Time Re-validation**: A custom socket lookup handler guards against DNS-rebinding (TOCTOU) attacks at connect time.
- **Manual Redirect Validation**: Redirects are not followed blindly. Each redirect hop (`max 5`) is parsed, checked, and resolved against the public address policy before following.
- **Resource Limits**: Response bodies are hard-capped at 3 MB per page and standard request timeouts apply.

### 2. Path Traversal & Arbitrary File Write Protection (`dist/output.js`)
Tools accept an optional `output_file` argument to write full answers to disk:
- **Sandbox Confinement**: By default, all relative and absolute paths are strictly validated and confined inside the configured output directory (`PERPLEXITY_OUTPUT_DIR` or `./outputs`).
- **Traversal Rejection**: Directory traversal sequences (`..`), NUL bytes, and symlink breakouts are rejected with an explicit `OutputPathError`.
- **Extension Enforcement**: Allowed extensions are limited to safe text formats (`.txt`, `.md`, `.json`).
- **Opt-in Override**: To allow writing to arbitrary absolute paths outside the outputs folder, the user must explicitly set `PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT=1`.
- **Targeted Pruning**: Auto-cleanup of old outputs only prunes files matching the server's own ISO timestamp pattern, protecting any custom or user-placed files.

### 3. Local Credentials & Session Isolation (`dist/auth.js`, `dist/paths.js`)
- Browser cookies and persistent session states are saved to `.playwright/profile` (or `~/.perplexity-web-mcp/.playwright/profile` when run via npm/npx).
- **Never commit or share the `.playwright/` folder.** It contains live authentication session tokens for your Perplexity account.
- The `.gitignore` file excludes `.playwright/`, `cache/`, `diagnostics/`, `outputs/`, and `config.json`.

---

## Disclaimer & Terms of Service

This is an **unofficial community tool** and is not affiliated with, endorsed by, or sponsored by Perplexity AI, Inc. Automating consumer web sessions may be restricted under Perplexity's Terms of Service. For production enterprise deployments, use the official Perplexity API backend (`backend: "api"` with `PERPLEXITY_API_KEY`).
