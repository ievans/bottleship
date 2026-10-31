import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lock } from "../build-wasm/lock";
import { releaseUrl, restoreFromRelease } from "../build-wasm/release";

const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
    const d = mkdtempSync(join(tmpdir(), "build-wasm-release-"));
    dirs.push(d);
    return d;
}
const digest = (text: string) => ({ sha256: createHash("sha256").update(text).digest("hex"), bytes: text.length });

/** Serves a tarball holding `files` and returns its URL. */
function serve(files: Record<string, string>): string {
    const src = dir();
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(join(src, rel, ".."), { recursive: true });
        writeFileSync(join(src, rel), text);
    }
    const archive = join(dir(), "wasm.tar.gz");
    spawnSync("tar", ["-czf", archive, "-C", src, ...Object.keys(files)]);
    const server = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(archive)) });
    servers.push(server);
    return `http://localhost:${server.port}/wasm.tar.gz`;
}
const lockOf = (outputs: Lock["outputs"]): Lock => ({ toolchain: {}, recipes: {}, outputs });

describe("restoreFromRelease", () => {
    test("installs files that match the lock", async () => {
        const root = dir();
        const url = serve({ "public/a.wasm": "good" });
        const lock = lockOf({ "public/a.wasm": digest("good") });
        expect(await restoreFromRelease(["public/a.wasm"], lock, { root, url })).toEqual(["public/a.wasm"]);
        expect(readFileSync(join(root, "public/a.wasm"), "utf8")).toBe("good");
    });

    test("never installs a file that differs from the lock", async () => {
        const root = dir();
        const url = serve({ "public/a.wasm": "tampered" });
        const lock = lockOf({ "public/a.wasm": digest("good") });
        expect(await restoreFromRelease(["public/a.wasm"], lock, { root, url })).toEqual([]);
        expect(existsSync(join(root, "public/a.wasm"))).toBe(false);
    });

    test("ignores outputs the lock doesn't list", async () => {
        const root = dir();
        const url = serve({ "public/a.wasm": "good" });
        expect(await restoreFromRelease(["public/a.wasm"], lockOf({}), { root, url })).toEqual([]);
    });

    test("falls back when the release is missing", async () => {
        const root = dir();
        const server = Bun.serve({ port: 0, fetch: () => new Response("", { status: 404 }) });
        servers.push(server);
        const lock = lockOf({ "public/a.wasm": digest("good") });
        const url = `http://localhost:${server.port}/wasm.tar.gz`;
        expect(await restoreFromRelease(["public/a.wasm"], lock, { root, url })).toEqual([]);
    });
});

test("releaseUrl keys on the lock's hash", () => {
    const hash = createHash("sha256").update("lock").digest("hex").slice(0, 16);
    expect(releaseUrl(new TextEncoder().encode("lock"))).toEndWith(`/wasm-${hash}/wasm.tar.gz`);
});
