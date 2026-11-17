#!/usr/bin/env node
/**
 * Package entry point.
 *   no subcommand  -> run the MCP stdio server (dist/index.js), exactly as before
 *   setup | login | doctor | help | version -> CLI helpers (dist/setup.js)
 */
const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 20) {
    console.error(`perplexity-web-mcp requires Node.js >= 20 (found ${process.versions.node}).`);
    process.exit(1);
}

const COMMANDS = new Set(["setup", "login", "doctor", "help", "version", "--help", "-h", "--version", "-v"]);
const [command, ...rest] = process.argv.slice(2);

if (command && COMMANDS.has(command)) {
    const { runCommand } = await import("./setup.js");
    process.exit(await runCommand(command, rest));
}
else {
    await import("./index.js");
}
