#!/usr/bin/env node
// Standalone login helper: opens the automation browser so you can sign in to Perplexity once.
//   node scripts/manual-login.mjs [--profile <name>]
import { runCommand } from "../dist/setup.js";

process.exit(await runCommand("login", process.argv.slice(2)));
