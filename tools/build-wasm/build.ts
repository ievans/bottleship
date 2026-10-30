#!/usr/bin/env bun
/**
 * Reproducible build of every .wasm the app ships. None are committed: they are built here from
 * source with pinned toolchains and checked against wasm.lock.json, so the bytes on screen are a
 * function of the repo, not of whoever last committed a binary.
 *
 * Usage: bun tools/build-wasm/build.ts [target...] [--force] [--update]
 *   targets: dxt-kernel unpack-streaming unpack-buffered v86 video-decoder (default: all)
 *   --force   rebuild even when the outputs already match the lock
 *   --update  accept the result: rewrite the lock with this machine's output and toolchain
 */
import { spawnSync } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LOCK_PATH, ROOT, TARGET_OUTPUTS, compareOutputs, digestFile, readLock, type Lock } from "./lock";

const WORK = join(ROOT, ".build-wasm");
const WASM = "wasm32-unknown-unknown";

const args = process.argv.slice(2);
const force = args.includes("--force");
const update = args.includes("--update");
const requested = args.filter(a => !a.startsWith("--"));

function capture(cmd: string, argv: string[]): string {
    const r = spawnSync(cmd, argv, { encoding: "utf8" });
    if (r.error || r.status !== 0) throw new Error(`\`${cmd} ${argv.join(" ")}\` failed: ${r.error?.message ?? r.stderr}`);
    return (r.stdout + r.stderr).trim();
}

function run(cmd: string, argv: string[], cwd: string, env: Record<string, string> = {}): void {
    const r = spawnSync(cmd, argv, { cwd, stdio: "inherit", env: { ...process.env, LC_ALL: "C", TZ: "UTC", SOURCE_DATE_EPOCH: "0", ...env } });
    if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`\`${cmd} ${argv.join(" ")}\` exited ${r.status}`);
}

/** Absolute build paths otherwise leak into panic messages and debug info and make the bytes machine-dependent. */
function rustflags(srcRoot: string): Record<string, string> {
    const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
    const sysroot = capture("rustc", ["--print", "sysroot"]);
    const flags = [`--remap-path-prefix=${srcRoot}=/src`, `--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${sysroot}=/rustc`];
    return { CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"), RUSTFLAGS: "" };
}

const probes: Record<string, () => string> = {
    rustc: () => capture("rustc", ["--version"]),
    "wasm-bindgen": () => capture("wasm-bindgen", ["--version"]),
    clang: () => /clang version (\d+\.\d+\.\d+)/.exec(capture("clang", ["--version"]))?.[1] ?? "unknown",
};

interface Target { needs: string[]; build(): void }

const copy = (from: string, to: string): void => { mkdirSync(join(to, ".."), { recursive: true }); copyFileSync(from, to); };

function cargoWasm(crate: string): string {
    const dir = join(ROOT, "tools", crate);
    run("cargo", ["build", "--locked", "--release", "--lib", "--target", WASM], dir, { CARGO_TARGET_DIR: join(dir, "target"), ...rustflags(dir) });
    return join(dir, "target", WASM, "release");
}

const targets: Record<string, Target> = {
    "dxt-kernel": {
        needs: ["rustc"],
        build() {
            for (const simd of [false, true]) {
                const out = join(ROOT, "public", `dxt-kernel${simd ? "-simd" : ""}.wasm`);
                mkdirSync(join(ROOT, "public"), { recursive: true });
                run("rustc", [
                    "--edition=2021", "--crate-type=cdylib", `--target=${WASM}`,
                    "-C", "opt-level=3", "-C", "panic=abort", "-C", "lto=fat", "-C", "codegen-units=1",
                    "-C", `target-feature=${simd ? "+" : "-"}simd128`, "-C", "strip=symbols",
                    // The span validator compares against __heap_base, so it has to be an export.
                    "-C", "link-arg=--export=__heap_base", "-C", "link-arg=--max-memory=67108864",
                    `--remap-path-prefix=${ROOT}=/src`, "tools/build-dxt-kernel/lib.rs", "-o", out,
                ], ROOT);
            }
        },
    },
    "unpack-streaming": {
        needs: ["rustc"],
        build() { copy(join(cargoWasm("build-unpack-streaming"), "unpack_streaming.wasm"), join(ROOT, "public/unpack-streaming.wasm")); },
    },
    "unpack-buffered": {
        needs: ["rustc", "wasm-bindgen"],
        build() {
            const dir = join(ROOT, "tools", "build-unpack-buffered");
            const core = join(cargoWasm("build-unpack-buffered"), "unpack_buffered.wasm");
            rmSync(join(dir, "pkg"), { recursive: true, force: true });
            rmSync(join(dir, "pkg-node"), { recursive: true, force: true });
            run("wasm-bindgen", ["--target", "web", "--out-dir", "pkg/", core], dir);
            run("wasm-bindgen", ["--target", "nodejs", "--out-dir", "pkg-node/", core], dir);
            // The bindgen step rewrites the core, so ship its output, not the raw cargo artifact.
            copy(join(dir, "pkg/unpack_buffered_bg.wasm"), join(ROOT, "public/unpack-buffered.wasm"));
        },
    },
    v86: {
        needs: ["rustc", "clang"],
        build() {
            // Mirrors the wasm half of vendor/v86/build-wasm.sh (recipe hash in the lock); built in a
            // scratch copy so the submodule's tracked build/ directory is never touched.
            const src = join(WORK, "v86");
            rmSync(src, { recursive: true, force: true });
            cpSync(join(ROOT, "vendor/v86"), src, {
                recursive: true,
                filter: p => !/[\\/](\.git|build|target|closure-compiler|node_modules)$/.test(p),
            });
            mkdirSync(join(src, "build"), { recursive: true });
            for (const table of ["jit", "jit0f"]) run("node", ["gen/generate_jit.js", "--output-dir", "build/", "--table", table], src);
            for (const table of ["interpreter", "interpreter0f"]) run("node", ["gen/generate_interpreter.js", "--output-dir", "build/", "--table", table], src);
            for (const table of ["analyzer", "analyzer0f"]) run("node", ["gen/generate_analyzer.js", "--output-dir", "build/", "--table", table], src);
            run("node", ["gen/generate_flag_contracts.js"], src);
            run("clang", [
                "-c", "-Wall", "--target=wasm32", "-O3", "-flto", "-nostdlib", "-fvisibility=hidden",
                "-ffunction-sections", "-fdata-sections", "-DZSTDLIB_VISIBILITY=", "-o", "build/zstddeclib.o", "lib/zstd/zstddeclib.c",
            ], src);
            const wrapper = process.platform === "win32" ? "tools/rust-lld-wrapper.cmd" : "tools/rust-lld-wrapper";
            run("cargo", [
                "rustc", "--release", "--target", WASM, "--",
                "-C", `linker=${wrapper}`, "-C", "link-args=--import-table --global-base=4096", "-C", "link-args=build/zstddeclib.o",
                "-C", "target-feature=+bulk-memory", "-C", "target-feature=+multivalue", "-C", "target-feature=+simd128",
            ], src, rustflags(src));
            const built = join(src, "build", WASM, "release", "v86.wasm");
            run("node", ["tools/check-wasm-exports.mjs", built], src);
            copy(built, join(ROOT, "public/v86.wasm"));
        },
    },
    "video-decoder": {
        needs: [],
        build() {
            // The container fixes every path the FFmpeg configure step records and pins the emsdk image.
            const dir = join(ROOT, "tools", "build-ffmpeg-decoder");
            const out = join(WORK, "video-decoder");
            rmSync(out, { recursive: true, force: true });
            mkdirSync(out, { recursive: true });
            run("docker", ["build", "-t", "bottleship-ffmpeg-builder", dir], ROOT);
            run("docker", [
                "run", "--rm", "-v", `${ROOT}:/project`, "-v", `${out}:/out`, "-w", "/project",
                "-e", "BS_FFMPEG_BUILD_DIR=/ffbuild", "-e", "BS_FFMPEG_OUT_DIR=/out", "-e", "SOURCE_DATE_EPOCH=0",
                "bottleship-ffmpeg-builder", "bash", "tools/build-ffmpeg-decoder/build.sh",
            ], ROOT);
            copy(join(out, "video-decoder.wasm"), join(ROOT, "public/video-decoder.wasm"));
        },
    },
};

const v86Recipe = "vendor/v86/build-wasm.sh";
const sha256 = (rel: string): string => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");

const names = requested.length ? requested : Object.keys(targets);
for (const n of names) if (!targets[n]) { console.error(`unknown target "${n}" (have: ${Object.keys(targets).join(", ")})`); process.exit(2); }

const lock: Lock = existsSync(LOCK_PATH) ? readLock() : { toolchain: {}, recipes: {}, outputs: {} };
const problems: string[] = [];
const built: string[] = [];

for (const name of names) {
    const t = targets[name];
    if (!force && !update && compareOutputs(lock, TARGET_OUTPUTS[name]).length === 0) {
        console.log(`[build-wasm] ${name}: up to date`);
        continue;
    }
    for (const tool of t.needs) {
        const have = probes[tool]();
        if (!update && lock.toolchain[tool] && lock.toolchain[tool] !== have) {
            problems.push(`${name}: ${tool} is "${have}" but the lock was produced with "${lock.toolchain[tool]}" — use the pinned toolchain (rust-toolchain.toml / CI), or --update to re-pin`);
        }
        lock.toolchain[tool] = have;
    }
    if (problems.length) break;
    if (name === "v86") {
        const have = sha256(v86Recipe);
        if (!update && lock.recipes[v86Recipe] && lock.recipes[v86Recipe] !== have) {
            problems.push(`v86: ${v86Recipe} changed since the recipe in this tool was written — re-check that targets.v86 still mirrors it, then --update`);
            break;
        }
        lock.recipes[v86Recipe] = have;
    }
    console.log(`[build-wasm] ${name}: building`);
    t.build();
    built.push(name);
    if (update) for (const o of TARGET_OUTPUTS[name]) lock.outputs[o] = digestFile(o);
}

if (!update && !problems.length) {
    for (const name of built) problems.push(...compareOutputs(lock, TARGET_OUTPUTS[name]));
}
if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    console.error("\nOutput differs from wasm.lock.json. If the change is intended, run with --update and review the lock diff.");
    process.exit(1);
}
if (update) {
    const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(LOCK_PATH, JSON.stringify({ toolchain: sorted(lock.toolchain), recipes: sorted(lock.recipes), outputs: sorted(lock.outputs) }, null, 2) + "\n");
    console.log(`[build-wasm] wrote ${LOCK_PATH}`);
}
