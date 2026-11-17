/**
 * Command-line helpers: `setup`, `login`, `doctor`.
 *
 *   npx -y @aqsacloud/perplexity-web-mcp setup --client opencode
 *   npx -y @aqsacloud/perplexity-web-mcp login
 *   npx -y @aqsacloud/perplexity-web-mcp doctor [--online]
 *
 * Everything here is deliberately conservative: existing client configs are merged (never replaced),
 * a backup is written first, and unparseable files are left untouched with a manual snippet printed instead.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { isInstalledPackage, packageDir, resolveDataRoot } from "./paths.js";

const PKG = JSON.parse(fs.readFileSync(path.join(packageDir(), "package.json"), "utf8"));
export const SERVER_NAME = "perplexity-web";
export const SKILL_NAME = "perplexity-orchestrator";
export const CLIENTS = ["opencode", "claude", "cursor", "antigravity"];
const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const OPENCODE_EXECUTION_TIMEOUT_MS = 960_000; // slightly above the server's 900s default search timeout
const BOOLEAN_FLAGS = new Set(["dry-run", "project", "force", "skip-browser", "skip-deps", "no-skill", "absolute-node", "help", "online"]);

const out = (line = "") => console.log(line);
const ok = (line) => out(`[ok]   ${line}`);
const info = (line) => out(`[..]   ${line}`);
const warn = (line) => out(`[warn] ${line}`);
const bad = (line) => out(`[FAIL] ${line}`);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Minimal flag parser: `--flag`, `--key value`, `--key=value`. */
export function parseArgs(argv) {
    const opts = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            opts._.push(arg);
            continue;
        }
        const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
        if (BOOLEAN_FLAGS.has(key)) {
            opts[key] = inline === undefined ? true : inline !== "false";
        }
        else {
            opts[key] = inline === undefined ? argv[++i] : inline;
        }
    }
    return opts;
}

export class ConfigParseError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConfigParseError";
    }
}

/** Decide how clients should launch the server: `node <installed dist>` for clones, `npx` for installed packages. */
export function resolveMode(opts = {}) {
    const requested = String(opts.mode ?? "").toLowerCase();
    if (requested === "node" || requested === "npx")
        return requested;
    return isInstalledPackage() ? "npx" : "node";
}

export function buildServerSpec({ mode, platform = process.platform, absoluteNode = false, entry = path.join(packageDir(), "dist", "index.js") } = {}) {
    const env = { PERPLEXITY_HEADLESS: "false" };
    if (mode === "npx") {
        return platform === "win32"
            ? { command: "cmd.exe", args: ["/c", "npx", "-y", `${PKG.name}@latest`], env }
            : { command: "npx", args: ["-y", `${PKG.name}@latest`], env };
    }
    return { command: absoluteNode ? process.execPath : "node", args: [entry], env };
}

export function detectOpenCodeLayout(cfg) {
    const mcp = cfg?.mcp;
    if (isObj(mcp?.servers))
        return "v2";
    if (isObj(mcp) && Object.keys(mcp).some((k) => k !== "timeout" && k !== "servers"))
        return "legacy";
    return "v2";
}

/** Pure merge: returns a copy of `existing` with only the `perplexity-web` entry added/replaced. */
export function mergeClientConfig(client, existing, spec, { layout } = {}) {
    const cfg = isObj(existing) ? structuredClone(existing) : {};
    if (client === "opencode") {
        const effective = layout ?? detectOpenCodeLayout(cfg);
        cfg.$schema ??= OPENCODE_SCHEMA_URL;
        if (!isObj(cfg.mcp))
            cfg.mcp = {};
        const command = [spec.command, ...spec.args];
        if (effective === "v2") {
            // OpenCode V2: mcp.servers.<name>; `disabled` (not `enabled`); per-server timeout object in ms.
            if (!isObj(cfg.mcp.servers))
                cfg.mcp.servers = {};
            cfg.mcp.servers[SERVER_NAME] = {
                type: "local",
                command,
                environment: spec.env,
                timeout: { startup: 60_000, execution: OPENCODE_EXECUTION_TIMEOUT_MS },
            };
        }
        else {
            // Deprecated flat layout: mcp.<name> with `enabled` and an integer request timeout (default 5s is too short).
            cfg.mcp[SERVER_NAME] = { type: "local", command, enabled: true, environment: spec.env, timeout: OPENCODE_EXECUTION_TIMEOUT_MS };
        }
        return cfg;
    }
    if (!isObj(cfg.mcpServers))
        cfg.mcpServers = {};
    const entry = { command: spec.command, args: spec.args, env: spec.env };
    cfg.mcpServers[SERVER_NAME] = client === "antigravity" ? entry : { type: "stdio", ...entry };
    return cfg;
}

export function resolveHome(env = process.env) {
    return env.PERPLEXITY_SETUP_HOME?.trim() || os.homedir();
}

/** Where each client keeps its MCP config and skills. `configPath: null` means "print a command instead of editing". */
export function clientTarget(client, { home, cwd, project }) {
    switch (client) {
        case "opencode":
            return {
                label: "OpenCode",
                configPath: project ? path.join(cwd, "opencode.json") : path.join(home, ".config", "opencode", "opencode.json"),
                skillRoot: project ? path.join(cwd, ".opencode", "skills") : path.join(home, ".config", "opencode", "skills"),
            };
        case "claude":
            return {
                label: "Claude Code",
                configPath: project ? path.join(cwd, ".mcp.json") : null,
                skillRoot: project ? path.join(cwd, ".claude", "skills") : path.join(home, ".claude", "skills"),
            };
        case "cursor":
            return {
                label: "Cursor",
                configPath: project ? path.join(cwd, ".cursor", "mcp.json") : path.join(home, ".cursor", "mcp.json"),
                skillRoot: project ? path.join(cwd, ".cursor", "skills") : path.join(home, ".cursor", "skills"),
            };
        case "antigravity":
            return {
                label: "Antigravity",
                configPath: path.join(home, ".gemini", "config", "mcp_config.json"),
                skillRoot: path.join(home, ".gemini", "config", "skills"),
            };
        default:
            throw new Error(`Unknown client "${client}". Use one of: ${CLIENTS.join(", ")}`);
    }
}

export function readJsonConfig(configPath) {
    if (!fs.existsSync(configPath))
        return { exists: false, data: {} };
    const text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    if (text.trim() === "")
        return { exists: true, data: {} };
    if (/\.jsonc$/i.test(configPath))
        throw new ConfigParseError(`${configPath} is JSONC (comments allowed); refusing to rewrite it automatically.`);
    try {
        return { exists: true, data: JSON.parse(text) };
    }
    catch (err) {
        throw new ConfigParseError(`${configPath} is not valid JSON (${err.message}).`);
    }
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeJsonConfig(configPath, data, { backup }) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let backupPath = null;
    if (backup && fs.existsSync(configPath)) {
        backupPath = `${configPath}.${timestamp()}.bak`;
        fs.copyFileSync(configPath, backupPath);
    }
    fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return backupPath;
}

function copySkill(skillRoot, { force, dryRun }) {
    const source = path.join(packageDir(), "skills", SKILL_NAME);
    const destination = path.join(skillRoot, SKILL_NAME);
    if (!fs.existsSync(source))
        return { status: "missing-source", destination };
    const destSkillFile = path.join(destination, "SKILL.md");
    if (fs.existsSync(destSkillFile)) {
        const same = fs.readFileSync(destSkillFile, "utf8") === fs.readFileSync(path.join(source, "SKILL.md"), "utf8");
        if (same)
            return { status: "up-to-date", destination };
        if (!force)
            return { status: "exists-differs", destination };
    }
    if (!dryRun)
        fs.cpSync(source, destination, { recursive: true, force: true });
    return { status: dryRun ? "would-copy" : "copied", destination };
}

function canResolve(specifier) {
    try {
        createRequire(path.join(packageDir(), "package.json")).resolve(specifier);
        return true;
    }
    catch {
        return false;
    }
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" && /\.cmd$/i.test(command), ...options });
    return result.status === 0;
}

function ensureDependencies(dryRun) {
    if (canResolve("playwright")) {
        ok("Dependencies installed (playwright found).");
        return true;
    }
    if (isInstalledPackage()) {
        bad("Installed package is missing its dependencies. Reinstall: npm install -g " + PKG.name);
        return false;
    }
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    if (dryRun) {
        info(`Would run: ${npm} install --omit=dev (in ${packageDir()})`);
        return true;
    }
    info("Installing dependencies (npm install --omit=dev)...");
    if (!run(npm, ["install", "--omit=dev"], { cwd: packageDir() })) {
        bad("npm install failed. On Windows PowerShell, if npm is blocked by execution policy, use npm.cmd or run from cmd.exe.");
        return false;
    }
    ok("Dependencies installed.");
    return true;
}

async function chromiumInstalled() {
    try {
        const { chromium } = await import("playwright");
        return fs.existsSync(chromium.executablePath());
    }
    catch {
        return false;
    }
}

async function ensureChromium(dryRun) {
    if (await chromiumInstalled()) {
        ok("Playwright Chromium already installed.");
        return true;
    }
    if (dryRun) {
        info("Would run: playwright install chromium");
        return true;
    }
    const cli = path.join(path.dirname(createRequire(path.join(packageDir(), "package.json")).resolve("playwright/package.json")), "cli.js");
    info("Installing Playwright Chromium (one-time download, ~150 MB)...");
    if (!run(process.execPath, [cli, "install", "chromium"])) {
        bad("Chromium download failed. Retry: npx playwright install chromium" + (process.platform === "linux" ? " (Linux may also need: npx playwright install-deps chromium)" : ""));
        return false;
    }
    ok("Chromium installed.");
    return true;
}

export function loginCommandHint(mode) {
    if (mode === "npx") {
        return `${process.platform === "win32" ? "npx.cmd" : "npx"} -y ${PKG.name} login`;
    }
    return `node "${path.join(packageDir(), "dist", "cli.js")}" login`;
}

export function printSetupHelp() {
    out(`perplexity-web-mcp ${PKG.version}

Usage:
  perplexity-web-mcp                       Start the MCP server on stdio (what MCP clients run)
  perplexity-web-mcp setup --client <c>    Configure an MCP client (${CLIENTS.join(" | ")}; comma-separate for several)
  perplexity-web-mcp login [--profile p]   Open the automation browser and sign in to Perplexity once
  perplexity-web-mcp doctor [--online]     Diagnose installation, browser, profile and (with --online) the live session

setup options:
  --project          Write the project-level config in the current directory instead of the user-level one
  --dry-run          Show what would change without writing anything
  --mode node|npx    How the client launches the server (default: npx when installed from npm, node for a clone)
  --absolute-node    Use the absolute path of the current Node binary (helps GUI apps with a minimal PATH)
  --no-skill         Do not install the perplexity-orchestrator skill
  --force            Overwrite an existing, different copy of the skill
  --skip-deps        Skip 'npm install --omit=dev' (clone installs only)
  --skip-browser     Skip downloading Playwright Chromium

Windows PowerShell: if 'npx' is blocked by the execution policy (npx.ps1), use 'npx.cmd' or cmd.exe.`);
}

async function runSetup(opts) {
    if (opts.help || !opts.client) {
        printSetupHelp();
        return opts.help ? 0 : 2;
    }
    const clients = String(opts.client).split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    const unknown = clients.filter((c) => !CLIENTS.includes(c));
    if (unknown.length > 0) {
        bad(`Unknown client: ${unknown.join(", ")}. Choose from: ${CLIENTS.join(", ")}`);
        return 2;
    }
    const dryRun = Boolean(opts["dry-run"]);
    const mode = resolveMode(opts);
    const spec = buildServerSpec({ mode, absoluteNode: Boolean(opts["absolute-node"]) });
    const home = resolveHome();
    const cwd = process.cwd();
    let failures = 0;

    out(`perplexity-web-mcp ${PKG.version} setup${dryRun ? " (dry run: nothing will be written)" : ""}`);
    ok(`Node ${process.versions.node} (>= 20 required)`);
    if (!opts["skip-deps"] && !ensureDependencies(dryRun))
        failures++;
    if (!opts["skip-browser"] && failures === 0 && !(await ensureChromium(dryRun)))
        failures++;

    for (const client of clients) {
        const target = clientTarget(client, { home, cwd, project: Boolean(opts.project) });
        out();
        out(`== ${target.label} ==`);
        if (target.configPath === null) {
            const claudeArgs = [spec.command, ...spec.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
            info(`Claude Code keeps user-level servers in ~/.claude.json, which this tool does not edit. Run:`);
            out(`       claude mcp add --scope user ${SERVER_NAME} -- ${claudeArgs}`);
            info("Or re-run with --project to write ./.mcp.json.");
        }
        else {
            try {
                const { exists, data } = readJsonConfig(target.configPath);
                const merged = mergeClientConfig(client, data, spec);
                const layoutNote = client === "opencode" ? ` (${detectOpenCodeLayout(data) === "v2" ? "V2 mcp.servers layout" : "legacy flat mcp layout"})` : "";
                if (dryRun) {
                    info(`Would ${exists ? "update" : "create"} ${target.configPath}${layoutNote}`);
                    out(JSON.stringify(client === "opencode" ? merged.mcp : merged.mcpServers, null, 2).split("\n").map((l) => `       ${l}`).join("\n"));
                }
                else {
                    const backupPath = writeJsonConfig(target.configPath, merged, { backup: true });
                    ok(`${exists ? "Updated" : "Created"} ${target.configPath}${layoutNote}`);
                    if (backupPath)
                        info(`Backup: ${backupPath}`);
                }
            }
            catch (err) {
                if (!(err instanceof ConfigParseError))
                    throw err;
                failures++;
                bad(err.message);
                info("Left untouched. Add this entry manually:");
                out(JSON.stringify(mergeClientConfig(client, {}, spec), null, 2).split("\n").map((l) => `       ${l}`).join("\n"));
            }
        }
        if (!opts["no-skill"]) {
            const res = copySkill(target.skillRoot, { force: Boolean(opts.force), dryRun });
            const messages = {
                copied: `Installed skill -> ${res.destination}`,
                "would-copy": `Would install skill -> ${res.destination}`,
                "up-to-date": `Skill already up to date (${res.destination})`,
                "exists-differs": `Skill exists and differs; kept yours (${res.destination}). Use --force to overwrite.`,
                "missing-source": "Skill source not found in this package; skipped.",
            };
            (res.status === "exists-differs" || res.status === "missing-source" ? warn : ok)(messages[res.status]);
        }
    }

    out();
    if (failures > 0) {
        bad(`Setup finished with ${failures} problem(s); see messages above.`);
        return 1;
    }
    out("Next steps:");
    out(`  1. Sign in to Perplexity once:   ${loginCommandHint(mode)}`);
    out("     (a separate automation browser opens; sign in THERE, not in your everyday Chrome/Edge)");
    out("  2. Restart your MCP client.");
    out('  3. Ask your agent: "run the perplexity-web health_check tool".');
    out("  Troubleshooting any time:        " + loginCommandHint(mode).replace(/ login$/, " doctor --online"));
    return 0;
}

async function runLogin(opts) {
    const { ensureAuthenticated } = await import("./auth.js");
    const { closeBrowser } = await import("./browser.js");
    try {
        const res = await ensureAuthenticated({ profile: opts.profile });
        out(res.alreadyAuthenticated ? "Already signed in." : "Signed in.");
        out(`Profile "${res.profile}" stored at: ${res.profileDir}`);
        out("Treat that folder like a password: it holds your Perplexity session cookies. Never commit or share it.");
        return 0;
    }
    catch (err) {
        bad(err?.message ?? String(err));
        return 1;
    }
    finally {
        await closeBrowser().catch(() => { });
    }
}

function dirWritable(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.write-test-${process.pid}`);
        fs.writeFileSync(probe, "x");
        fs.rmSync(probe, { force: true });
        return true;
    }
    catch {
        return false;
    }
}

async function runDoctor(opts) {
    let failed = 0;
    const check = (pass, passMsg, failMsg) => {
        if (pass)
            ok(passMsg);
        else {
            failed++;
            bad(failMsg);
        }
    };
    out(`perplexity-web-mcp ${PKG.version} doctor`);
    check(Number(process.versions.node.split(".")[0]) >= 20, `Node ${process.versions.node}`, `Node ${process.versions.node} is too old; need >= 20`);
    check(canResolve("playwright") && canResolve("@modelcontextprotocol/sdk/package.json"), "Dependencies resolvable", "Dependencies missing: run 'npm install --omit=dev' in the package folder (clone) or reinstall the package");
    check(await chromiumInstalled(), "Playwright Chromium installed", "Chromium missing: run 'npx playwright install chromium'");
    const root = resolveDataRoot();
    check(dirWritable(root), `Data directory writable: ${root}`, `Data directory not writable: ${root} (set PERPLEXITY_DATA_DIR)`);
    const profileDir = process.env.PERPLEXITY_PROFILE_DIR?.trim() ? path.resolve(process.env.PERPLEXITY_PROFILE_DIR.trim()) : path.join(root, ".playwright", "profile");
    if (fs.existsSync(profileDir))
        ok(`Browser profile exists: ${profileDir}`);
    else
        warn(`No browser profile yet (${profileDir}). Run the login command first.`);
    info(`Official API key: ${process.env.PERPLEXITY_API_KEY ? "configured" : "not set (browser backend only)"}`);
    info(`Absolute output paths: ${/^(1|true|yes|on)$/i.test(process.env.PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT ?? "") ? "ENABLED (PERPLEXITY_ALLOW_ABSOLUTE_OUTPUT)" : "disabled (output_file confined to the output directory)"}`);
    if (opts.online) {
        info("Running live health check (opens the automation browser)...");
        const { healthCheck } = await import("./search.js");
        const { closeBrowser } = await import("./browser.js");
        try {
            const report = await healthCheck({ profile: opts.profile });
            check(report.status === "healthy", `Live health: ${report.status} (authenticated=${report.authenticated}, models=${report.modelCount})`, `Live health: ${report.status} (authenticated=${report.authenticated})`);
            for (const c of report.checks.filter((x) => !x.ok))
                bad(`  ${c.name}: ${c.error ?? c.detail ?? "failed"}`);
            if (report.snapshotFiles)
                info(`Diagnostic snapshot: ${JSON.stringify(report.snapshotFiles)}`);
        }
        catch (err) {
            failed++;
            bad(`Live health check failed: ${err?.message ?? err}`);
        }
        finally {
            await closeBrowser().catch(() => { });
        }
    }
    else {
        info("Add --online to also test the live Perplexity session.");
    }
    return failed === 0 ? 0 : 1;
}

/** Entry used by dist/cli.js and scripts/manual-login.mjs. Returns a process exit code. */
export async function runCommand(command, argv = []) {
    const opts = parseArgs(argv);
    switch (command) {
        case "setup":
            return runSetup(opts);
        case "login":
            return runLogin(opts);
        case "doctor":
            return runDoctor(opts);
        case "version":
        case "--version":
        case "-v":
            out(PKG.version);
            return 0;
        default:
            printSetupHelp();
            return command === "help" || command === "--help" || command === "-h" ? 0 : 2;
    }
}
