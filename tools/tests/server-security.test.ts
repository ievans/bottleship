import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER = process.env.SERVER_UNDER_TEST ?? path.resolve(import.meta.dir, "../../deploy/server.ts");
const root = mkdtempSync(path.join(tmpdir(), "bs-server-"));
const dist = path.join(root, "dist");
const apps = path.join(root, "apps");
const outside = path.join(root, "outside.txt");

beforeAll(() => {
    mkdirSync(path.join(dist, "assets"), { recursive: true });
    mkdirSync(apps, { recursive: true });
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>x</title>");
    writeFileSync(path.join(dist, "assets", "app.js"), "export {}");
    writeFileSync(path.join(dist, "core.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    writeFileSync(path.join(dist, "manifest.webmanifest"), "{}");
    writeFileSync(path.join(apps, "ok.wgb"), new Uint8Array(4096).fill(7));
    writeFileSync(path.join(apps, "page.html"), "<script>alert(1)</script>");
    writeFileSync(path.join(apps, "notes.txt"), "not a bundle");
    writeFileSync(outside, "secret");
    symlinkSync(outside, path.join(apps, "escape.wgb"));
    symlinkSync(path.join(apps, "ok.wgb"), path.join(apps, "alias.wgb"));
    symlinkSync(path.join(apps, "page.html"), path.join(apps, "htmllink.wgb"));
    mkdirSync(path.join(apps, "dir.wgb"));
});

/** Raw request line, so the client cannot normalise the path before it is sent. */
async function rawStatus(base: string, rawPath: string): Promise<number> {
    const url = new URL(base);
    return await new Promise<number>((resolve, reject) => {
        let buf = "";
        void Bun.connect({
            hostname: url.hostname, port: Number(url.port),
            socket: {
                open(sock) { sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`); },
                data(_s, d) { buf += d.toString(); },
                close() { resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0)); },
                error(_s, e) { reject(e); },
            },
        });
    });
}

interface Running { base: string; stop(): Promise<void> }
const running: Running[] = [];
let nextPort = 20000 + Math.floor(Math.random() * 20000);

async function start(env: Record<string, string> = {}): Promise<Running> {
    const port = nextPort++;
    const proc = Bun.spawn(["bun", SERVER], {
        env: { ...process.env, PORT: String(port), BS_DIST_DIR: dist, BS_APPS_DIR: apps, ...env },
        stdout: "ignore", stderr: "ignore",
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
        await Bun.sleep(50);
    }
    const r = { base, stop: async () => { proc.kill(); await proc.exited; } };
    running.push(r);
    return r;
}
afterAll(async () => { for (const r of running) await r.stop(); });

const CSP_RO = "content-security-policy-report-only";
const CSP = "content-security-policy";

describe("security headers", () => {
    test("every kind of response carries the baseline headers", async () => {
        const { base } = await start();
        for (const p of ["/", "/assets/app.js", "/core.wasm", "/healthz", "/missing.png", "/apps/ok.wgb", "/apps/nope.wgb"]) {
            const r = await fetch(base + p);
            expect(r.headers.get("x-content-type-options")).toBe("nosniff");
            expect(r.headers.get("referrer-policy")).toBe("no-referrer");
            expect(r.headers.get("x-frame-options")).toBe("DENY");
            expect(r.headers.get("permissions-policy")).toContain("camera=()");
        }
    });
    test("403 and malformed-URL responses carry them too", async () => {
        const { base } = await start();
        const traversal = await fetch(`${base}/apps/..%2fdist%2findex.html`);
        expect(traversal.status).toBe(403);
        expect(traversal.headers.get("x-frame-options")).toBe("DENY");
        const bad = await fetch(`${base}/%E0%A4%A`);
        expect(bad.status).toBe(400);
        expect(bad.headers.get("x-content-type-options")).toBe("nosniff");
    });
    test("401 responses carry them", async () => {
        const { base } = await start({ BS_AUTH_USER: "u", BS_AUTH_PASS: "p" });
        const r = await fetch(`${base}/`);
        expect(r.status).toBe(401);
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });
    test("isolation headers the emulator needs are unchanged", async () => {
        const { base } = await start();
        const r = await fetch(base + "/");
        expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
        expect(r.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    });
    test("webmanifest and wasm are served with their real types", async () => {
        const { base } = await start();
        expect((await fetch(base + "/manifest.webmanifest")).headers.get("content-type")).toBe("application/manifest+json");
        expect((await fetch(base + "/core.wasm")).headers.get("content-type")).toBe("application/wasm");
    });
});

describe("Content-Security-Policy", () => {
    test("Report-Only by default, enforcing on request, absent when off", async () => {
        const def = await start();
        const r = await fetch(def.base + "/");
        expect(r.headers.get(CSP_RO)).toContain("'wasm-unsafe-eval'");
        expect(r.headers.get(CSP)).toBeNull();
        const enforce = await start({ BS_CSP_MODE: "enforce" });
        const e = await fetch(enforce.base + "/");
        expect(e.headers.get(CSP)).toContain("frame-ancestors 'none'");
        expect(e.headers.get(CSP_RO)).toBeNull();
        const off = await start({ BS_CSP_MODE: "off" });
        const o = await fetch(off.base + "/");
        expect(o.headers.get(CSP)).toBeNull();
        expect(o.headers.get(CSP_RO)).toBeNull();
        expect(o.headers.get("x-content-type-options")).toBe("nosniff");
    });
    test("the policy reaches scripts too (a worker takes its policy from its own response)", async () => {
        const { base } = await start();
        expect((await fetch(base + "/assets/app.js")).headers.get(CSP_RO)).toContain("worker-src 'self'");
    });
    test("BS_CSP replaces the policy and a bad mode refuses to start", async () => {
        const { base } = await start({ BS_CSP: "default-src 'none'" });
        expect((await fetch(base + "/")).headers.get(CSP_RO)).toBe("default-src 'none'");
        const bad = Bun.spawn(["bun", SERVER], { env: { ...process.env, PORT: String(nextPort++), BS_DIST_DIR: dist, BS_CSP_MODE: "enfroce" }, stdout: "ignore", stderr: "ignore" });
        expect(await bad.exited).not.toBe(0);
        // the same environment with a valid mode starts, so the exit above was the mode check
        const { base: ok } = await start({ BS_CSP_MODE: "report" });
        expect((await fetch(ok + "/healthz")).status).toBe(200);
    });
});

describe("/apps", () => {
    test("serves a bundle, inert if opened as a page, with Range", async () => {
        const { base } = await start();
        const r = await fetch(base + "/apps/ok.wgb");
        expect(r.status).toBe(200);
        expect((await r.arrayBuffer()).byteLength).toBe(4096);
        expect(r.headers.get("content-disposition")).toBe("attachment");
        expect(r.headers.get("content-security-policy")).toBe("sandbox");
        expect(r.headers.get(CSP_RO)).toBeNull();
        const part = await fetch(base + "/apps/ok.wgb", { headers: { Range: "bytes=10-19" } });
        expect(part.status).toBe(206);
        expect((await part.arrayBuffer()).byteLength).toBe(10);
        expect(part.headers.get("x-content-type-options")).toBe("nosniff");
    });
    test("only .wgb files: planted HTML and other types are not served", async () => {
        const { base } = await start();
        expect((await fetch(base + "/apps/page.html")).status).toBe(404);
        expect((await fetch(base + "/apps/notes.txt")).status).toBe(404);
    });
    test("a symlink out of the folder is not followed; one inside is", async () => {
        const { base } = await start();
        const esc = await fetch(base + "/apps/escape.wgb");
        expect(esc.status).toBe(404);
        expect(await esc.text()).not.toContain("secret");
        expect((await fetch(base + "/apps/alias.wgb")).status).toBe(200);
    });
    test("a directory named *.wgb is not a bundle, and traversal is refused", async () => {
        const { base } = await start();
        expect((await fetch(base + "/apps/dir.wgb")).status).toBe(404);
        for (const p of ["/apps/../outside.txt", "/apps/%2e%2e/outside.txt", "/apps/..%2foutside.txt", "/apps/%2e%2e%2foutside.txt"]) {
            const status = await rawStatus(base, p);
            expect(status).toBeGreaterThanOrEqual(400);
        }
    });
    test("an encoded /apps prefix gets the same treatment as the plain one", async () => {
        const { base } = await start();
        const r = await fetch(base + "/%61pps/ok.wgb");
        expect(r.status).toBe(200);
        expect(r.headers.get("content-security-policy")).toBe("sandbox");
        expect(r.headers.get("content-disposition")).toBe("attachment");
        expect(r.headers.get(CSP_RO)).toBeNull();
    });
    test("a link named .wgb that points at another file type is not served, however it is requested", async () => {
        const { base } = await start();
        for (const p of ["/apps/htmllink.wgb", "/%61pps/htmllink.wgb"]) {
            const r = await fetch(base + p);
            expect(r.status).toBe(404);
            expect(await r.text()).not.toContain("<script>");
        }
    });
    test("bundles are always application/octet-stream", async () => {
        const { base } = await start();
        expect((await fetch(base + "/apps/ok.wgb")).headers.get("content-type")).toBe("application/octet-stream");
    });
    test("a missing apps folder stops the server with a clear message instead of a stack trace", async () => {
        const proc = Bun.spawn(["bun", SERVER], { env: { ...process.env, PORT: String(nextPort++), BS_DIST_DIR: dist, BS_APPS_DIR: path.join(root, "nope") }, stdout: "ignore", stderr: "pipe" });
        expect(await proc.exited).toBe(1);
        expect(await new Response(proc.stderr).text()).toContain("does not exist or cannot be read");
    });
    test.skipIf(process.getuid?.() === 0)("an unreadable bundle is a logged 500, not a quiet 400", async () => {
        const { chmodSync } = await import("node:fs");
        writeFileSync(path.join(apps, "locked.wgb"), "x");
        chmodSync(path.join(apps, "locked.wgb"), 0o000);
        const { base } = await start();
        expect((await fetch(base + "/apps/locked.wgb")).status).toBe(500);
    });
});
