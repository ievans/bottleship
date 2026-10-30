import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const ROOT = join(import.meta.dir, "..", "..");
export const LOCK_PATH = join(import.meta.dir, "wasm.lock.json");

/** Every file each target must produce; the lock has to cover all of them. */
export const TARGET_OUTPUTS: Record<string, string[]> = {
    "dxt-kernel": ["public/dxt-kernel.wasm", "public/dxt-kernel-simd.wasm"],
    "unpack-streaming": ["public/unpack-streaming.wasm"],
    "unpack-buffered": [
        "public/unpack-buffered.wasm",
        ...["unpack_buffered.d.ts", "unpack_buffered.js", "unpack_buffered_bg.wasm", "unpack_buffered_bg.wasm.d.ts"]
            .flatMap(f => [`tools/build-unpack-buffered/pkg/${f}`, `tools/build-unpack-buffered/pkg-node/${f}`]),
    ],
    v86: ["public/v86.wasm"],
    "video-decoder": ["public/video-decoder.wasm"],
};

export interface Digest { sha256: string; bytes: number }
export interface Lock {
    /** Exact tool versions the digests were produced with; a different toolchain legitimately changes the bytes. */
    toolchain: Record<string, string>;
    /** Hashes of upstream scripts our recipes replicate, so a change there forces a re-review. */
    recipes: Record<string, string>;
    outputs: Record<string, Digest>;
}

export function digestFile(rel: string): Digest {
    const bytes = readFileSync(join(ROOT, rel));
    return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export function readLock(): Lock {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8"));
}

/** Differences between the files on disk and the lock; empty when every locked output matches. */
export function compareOutputs(lock: Lock, only?: readonly string[]): string[] {
    const problems: string[] = [];
    for (const rel of only ?? Object.values(TARGET_OUTPUTS).flat()) {
        const want = lock.outputs[rel];
        if (!want) {
            problems.push(`${rel}: no locked digest${existsSync(join(ROOT, rel)) ? ` (built: sha256 ${digestFile(rel).sha256}, ${digestFile(rel).bytes} bytes)` : ""}`);
            continue;
        }
        if (!existsSync(join(ROOT, rel))) { problems.push(`${rel}: missing (run \`bun run build:wasm\`)`); continue; }
        const got = digestFile(rel);
        if (got.sha256 !== want.sha256) problems.push(`${rel}: sha256 ${got.sha256} != locked ${want.sha256}`);
        else if (got.bytes !== want.bytes) problems.push(`${rel}: size ${got.bytes} != locked ${want.bytes}`);
    }
    return problems;
}
