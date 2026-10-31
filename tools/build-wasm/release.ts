import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LOCK_PATH, ROOT, type Lock } from "./lock";

const RELEASES = "https://github.com/ievans/bottleship/releases/download";

/** The release CI publishes for a lock: see publish-wasm in .github/workflows/ci.yml. */
export function releaseUrl(lockBytes: Uint8Array): string {
    const tag = `wasm-${createHash("sha256").update(lockBytes).digest("hex").slice(0, 16)}`;
    return `${RELEASES}/${tag}/wasm.tar.gz`;
}

/**
 * Fills in outputs from CI's release, so a machine without the toolchains can still build. Only
 * files matching the lock are installed. Any failure leaves the caller to compile them instead.
 */
export async function restoreFromRelease(
    outputs: readonly string[],
    lock: Lock,
    { root = ROOT, url = releaseUrl(readFileSync(LOCK_PATH)) }: { root?: string; url?: string } = {},
): Promise<string[]> {
    const wanted = outputs.filter(o => lock.outputs[o]);
    if (wanted.length === 0) return [];
    const tmp = mkdtempSync(join(tmpdir(), "bottleship-wasm-"));
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const archive = join(tmp, "wasm.tar.gz");
        writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
        const tar = spawnSync("tar", ["-xzf", archive, "-C", tmp, "--", ...wanted], { encoding: "utf8" });
        if (tar.error || tar.status !== 0) throw new Error(`tar failed: ${tar.error?.message ?? tar.stderr}`);

        const restored: string[] = [];
        for (const rel of wanted) {
            const from = join(tmp, rel);
            if (!existsSync(from)) continue;
            const bytes = readFileSync(from);
            const { sha256, bytes: size } = lock.outputs[rel];
            if (bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== sha256) continue;
            mkdirSync(dirname(join(root, rel)), { recursive: true });
            copyFileSync(from, join(root, rel));
            restored.push(rel);
        }
        return restored;
    } catch (e) {
        console.log(`[build-wasm] no release to download (${e instanceof Error ? e.message : e}); compiling instead`);
        return [];
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
