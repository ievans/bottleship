#!/usr/bin/env bun
/**
 * Quality-gate check: no .wasm is committed, and every built one matches tools/build-wasm/wasm.lock.json.
 *
 * Binaries are built from source by `bun run build:wasm` (tools/build-wasm/build.ts) with pinned
 * toolchains; the lock records the digest each build must produce. A tracked .wasm would bypass
 * that and ship bytes nobody can tie to source, so it fails here. Run after `build:wasm`.
 *
 * Usage: bun tools/validate-wasm-lock.ts
 */
import { spawnSync } from "node:child_process";
import { ROOT, compareOutputs, readLock } from "./build-wasm/lock";

const tracked = spawnSync("git", ["ls-files", "-z", "--", "*.wasm"], { cwd: ROOT, encoding: "utf8" });
if (tracked.error || tracked.status !== 0) {
    console.error(`validate-wasm-lock: cannot list tracked files: ${tracked.error?.message ?? tracked.stderr}`);
    process.exit(1);
}
const problems = tracked.stdout.split("\0").filter(Boolean).map(p => `${p}: committed binary — build it instead (bun run build:wasm)`);
problems.push(...compareOutputs(readLock()));

if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
}
console.log("validate-wasm-lock: OK (no committed .wasm; all built outputs match the lock)");
