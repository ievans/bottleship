#!/usr/bin/env bun
/**
 * Quality-gate check: every committed .wasm binary matches the digest recorded in
 * public/wasm.lock.json.
 *
 * These binaries execute in the page with no source next to them, so a PR that swaps one is
 * invisible in review. The lock turns a silent binary change into a reviewable diff of a text
 * file, and fails the gate when a binary changes without it. It proves "unchanged since the
 * lock was written", not "built from the stated source" — that needs a rebuild-and-compare.
 *
 * Also fails on a tracked .wasm the lock does not list, so a new binary cannot skip the lock.
 *
 * Usage: bun tools/validate-wasm-lock.ts [--update]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const LOCK = join(ROOT, "public", "wasm.lock.json");

interface Entry { sha256: string; bytes: number }
type Lock = Record<string, Entry>;

const tracked = spawnSync("git", ["ls-files", "-z", "--", "*.wasm"], { cwd: ROOT, encoding: "utf8" });
if (tracked.error || tracked.status !== 0) {
    console.error(`validate-wasm-lock: cannot list tracked files: ${tracked.error?.message ?? tracked.stderr}`);
    process.exit(1);
}
const paths = tracked.stdout.split("\0").filter(Boolean).sort();

function digest(path: string): Entry {
    const bytes = readFileSync(join(ROOT, path));
    return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

if (process.argv.includes("--update")) {
    const next: Lock = {};
    for (const path of paths) next[path] = digest(path);
    writeFileSync(LOCK, JSON.stringify(next, null, 2) + "\n");
    console.log(`validate-wasm-lock: wrote ${paths.length} entr${paths.length === 1 ? "y" : "ies"} to public/wasm.lock.json`);
    process.exit(0);
}

let lock: Lock;
try {
    lock = JSON.parse(readFileSync(LOCK, "utf8"));
} catch (e) {
    console.error(`validate-wasm-lock: cannot read public/wasm.lock.json: ${(e as Error).message}`);
    process.exit(1);
}

const problems: string[] = [];
for (const path of paths) {
    const want = lock[path];
    if (!want) { problems.push(`${path}: tracked but not in the lock`); continue; }
    const got = digest(path);
    if (got.sha256 !== want.sha256) problems.push(`${path}: sha256 ${got.sha256} != locked ${want.sha256}`);
    else if (got.bytes !== want.bytes) problems.push(`${path}: size ${got.bytes} != locked ${want.bytes}`);
}
for (const path of Object.keys(lock)) {
    if (!paths.includes(path)) problems.push(`${path}: in the lock but not tracked`);
}

if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    console.error("\nIf the binary change is intended, rebuild from source and run `bun tools/validate-wasm-lock.ts --update`; reviewers should treat the lock diff as the binary diff.");
    process.exit(1);
}
console.log(`validate-wasm-lock: OK (${paths.length} binaries match public/wasm.lock.json)`);
