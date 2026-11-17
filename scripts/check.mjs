#!/usr/bin/env node
// Cross-platform syntax check of every runtime/script file (`node --check`). Used by `npm run check` and CI.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["dist", "scripts", "eval"];
const files = dirs.flatMap((d) => {
    const dir = path.join(root, d);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join(dir, f)) : [];
});

let failed = 0;
for (const file of files) {
    const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (res.status !== 0) {
        failed++;
        console.error(`FAIL ${path.relative(root, file)}\n${res.stderr}`);
    }
}
console.log(`Checked ${files.length} files, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
