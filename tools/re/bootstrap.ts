/**
 * Cross-platform bootstrap for the warm RE service (`re start`).
 *
 * The service (re-service.py) needs three things: a Ghidra install (GHIDRA_INSTALL_DIR),
 * a JDK new enough for that Ghidra (its application.properties names the minimum — macOS ships
 * Java 8), and a python with pyghidra.
 * This module resolves each from, in order: an existing env/system install, a repo-local
 * copy under `.ghidra/` / `.ghidra-home/` (both gitignored), or a fresh download/venv
 * install into those dirs. Idempotent — a second call is a few stat()s. Works on
 * darwin/linux/win.
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { ZipArchive } from "@bottleship/formats/zip";
import { FileSource } from "../internal/file-source";
import { tryResolveArchiveExtractPath } from "../internal/archive-extract-path";

const REPO = join(import.meta.dir, "..", "..");
const GHIDRA_DIR = join(REPO, ".ghidra");        // gitignored
const HOME_DIR = join(REPO, ".ghidra-home");     // gitignored (JDK + venv + logs)
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".bat" : "";

export interface ReEnv {
    ghidraDir: string;
    javaHome: string;
    python: string;
    logFile: string;
}

function log(msg: string): void {
    console.error(`[re bootstrap] ${msg}`);
}

/** Parse the major version out of `java -version` stderr ("21.0.1" → 21, "1.8.0" → 8). */
function javaMajor(javaBin: string): number {
    try {
        const r = Bun.spawnSync([javaBin, "-version"], { stderr: "pipe", stdout: "pipe" });
        const text = new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout);
        const m = /version "(\d+)(?:\.(\d+))?/.exec(text);
        if (!m) return 0;
        const first = parseInt(m[1], 10);
        return first === 1 ? parseInt(m[2] ?? "0", 10) : first; // "1.8" → 8
    } catch { return 0; }
}

/**
 * Unpack a `.zip` with the repo's own reader — a bootstrap must not depend on a system
 * `unzip` (absent on stock Windows, and on a bare CI image). Every entry name goes through
 * the shared containment guard; ZIP mode bits are outside ZipEntry, so the POSIX launchers
 * (extensionless / `.sh`) get +x back explicitly or `analyzeHeadless` cannot run.
 */
async function unzipInto(zipPath: string, destDir: string): Promise<void> {
    const file = new FileSource(zipPath);
    const archive = new ZipArchive({
        size: file.size,
        readRange: async (start, end) => file.readRangeSync(start, end),
        readRangeSync: (start, end) => file.readRangeSync(start, end),
    });
    await archive.init();
    mkdirSync(destDir, { recursive: true });
    for (const entry of archive.listEntries()) {
        const resolved = tryResolveArchiveExtractPath(destDir, entry.name);
        if (!resolved.ok) {
            if (resolved.reason !== "empty") log(`skipping ${entry.name} (${resolved.reason})`);
            continue;
        }
        if (entry.isDirectory) { mkdirSync(resolved.path, { recursive: true }); continue; }
        mkdirSync(dirname(resolved.path), { recursive: true });
        writeFileSync(resolved.path, await archive.readEntry(entry));
        if (!IS_WIN && /^[^.]+$|\.sh$/.test(basename(resolved.path))) chmodSync(resolved.path, 0o755);
    }
}

function isValidGhidra(dir: string): boolean {
    return !!dir && existsSync(join(dir, "support", `analyzeHeadless${EXE}`));
}

function isValidJavaHome(home: string, minMajor: number): boolean {
    return !!home && javaMajor(join(home, "bin", IS_WIN ? "java.exe" : "java")) >= minMajor;
}

/** The JDK major a Ghidra install demands, from its own application.properties (the latest release moves it). */
function requiredJavaMajor(ghidraDir: string): number {
    try {
        const props = readFileSync(join(ghidraDir, "Ghidra", "application.properties"), "utf8");
        const m = /^application\.java\.min=(\d+)/m.exec(props);
        if (m) return parseInt(m[1], 10);
    } catch { /* fall through */ }
    return 21;
}

/** First child of `parent` whose name matches `re` (returns absolute path or null). */
function findChild(parent: string, re: RegExp): string | null {
    if (!existsSync(parent)) return null;
    for (const name of readdirSync(parent)) {
        if (re.test(name)) {
            const p = join(parent, name);
            if (statSync(p).isDirectory()) return p;
        }
    }
    return null;
}

async function ensureGhidra(): Promise<string> {
    // 1. Explicit env wins.
    const envDir = process.env.GHIDRA_INSTALL_DIR;
    if (envDir && isValidGhidra(envDir)) return envDir;

    // 2. Repo-local extracted install.
    const local = findChild(GHIDRA_DIR, /^ghidra_.*_PUBLIC$/);
    if (local && isValidGhidra(local)) return local;

    // 3. Extract an already-downloaded zip, else download the latest release.
    let zip = findChild(GHIDRA_DIR, /^ghidra_.*\.zip$/)
        ?? (existsSync(GHIDRA_DIR) ? readdirSync(GHIDRA_DIR).filter(f => /^ghidra_.*\.zip$/.test(f)).map(f => join(GHIDRA_DIR, f))[0] : undefined);
    if (!zip || !existsSync(zip)) {
        await Bun.$`mkdir -p ${GHIDRA_DIR}`;
        log("resolving latest Ghidra release…");
        const rel = await (await fetch("https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest")).json() as any;
        const asset = (rel.assets ?? []).find((a: any) => /ghidra_.*_PUBLIC_.*\.zip$/.test(a.name));
        if (!asset) throw new Error("could not find a Ghidra PUBLIC zip in the latest release");
        zip = join(GHIDRA_DIR, asset.name);
        log(`downloading ${asset.name} (~${Math.round((asset.size ?? 0) / 1e6)} MB)…`);
        await Bun.$`curl -sL -o ${zip} ${asset.browser_download_url}`;
    }
    log(`unpacking ${zip}…`);
    await unzipInto(zip, GHIDRA_DIR);
    const extracted = findChild(GHIDRA_DIR, /^ghidra_.*_PUBLIC$/);
    if (!extracted || !isValidGhidra(extracted)) throw new Error(`Ghidra unpack failed under ${GHIDRA_DIR}`);
    return extracted;
}

async function ensureJdk(minMajor: number): Promise<string> {
    // 1. A system/env JDK that's new enough.
    const envHome = process.env.JAVA_HOME;
    if (envHome && isValidJavaHome(envHome, minMajor)) return envHome;
    if (javaMajor(IS_WIN ? "java.exe" : "java") >= minMajor) {
        // On PATH — derive its home so we can pass JAVA_HOME explicitly to the service.
        try {
            const r = Bun.spawnSync([IS_WIN ? "where" : "which", "java"], { stdout: "pipe" });
            const bin = new TextDecoder().decode(r.stdout).trim().split(/\r?\n/)[0];
            if (bin) return join(bin, "..", ".."); // <home>/bin/java
        } catch { /* fall through to repo-local */ }
    }

    // 2. Repo-local Temurin (macOS nests the home under Contents/Home).
    const findHome = (): string | null => {
        if (!existsSync(HOME_DIR)) return null;
        for (const name of readdirSync(HOME_DIR)) {
            if (!/^jdk-?\d.*$/.test(name)) continue;
            const top = join(HOME_DIR, name);
            if (!statSync(top).isDirectory()) continue;
            const macHome = join(top, "Contents", "Home");
            const home = existsSync(macHome) ? macHome : top;
            if (isValidJavaHome(home, minMajor)) return home;
        }
        return null;
    };
    let home = findHome();
    if (home) return home;

    // 3. Extract an already-downloaded tarball, else download the required Temurin for this platform.
    await Bun.$`mkdir -p ${HOME_DIR}`;
    let tar = existsSync(HOME_DIR) ? readdirSync(HOME_DIR).filter(f => new RegExp(`temurin${minMajor}\\.(tar\\.gz|zip)$`).test(f)).map(f => join(HOME_DIR, f))[0] : undefined;
    if (!tar || !existsSync(tar)) {
        const os = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
        const arch = process.arch === "arm64" ? "aarch64" : "x64";
        const ext = os === "windows" ? "zip" : "tar.gz";
        tar = join(HOME_DIR, `temurin${minMajor}.${ext}`);
        log(`downloading Temurin JDK ${minMajor} (${os}/${arch})…`);
        await Bun.$`curl -sL -o ${tar} ${`https://api.adoptium.net/v3/binary/latest/${minMajor}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`}`;
    }
    log(`unpacking ${tar}…`);
    if (tar.endsWith(".zip")) await unzipInto(tar, HOME_DIR);
    else await Bun.$`tar -xzf ${tar} -C ${HOME_DIR}`;
    home = findHome();
    if (!home) throw new Error(`JDK ${minMajor} unpack failed under ${HOME_DIR}`);
    return home;
}

function hasPyghidra(python: string): boolean {
    try {
        const r = Bun.spawnSync([python, "-c", "import pyghidra"], { stdout: "pipe", stderr: "pipe" });
        return r.exitCode === 0;
    } catch { return false; }
}

/** Repo-local venv (created with pyghidra+capstone if missing); system python only if it already has pyghidra. */
async function ensurePython(): Promise<string> {
    const venvPy = join(HOME_DIR, "venv", IS_WIN ? "Scripts\\python.exe" : "bin/python");
    if (existsSync(venvPy)) return venvPy;

    const sys = IS_WIN ? "python" : "python3";
    if (hasPyghidra(sys)) return sys;

    log("creating python venv with pyghidra + capstone…");
    await Bun.$`${sys} -m venv ${join(HOME_DIR, "venv")}`;
    await Bun.$`${venvPy} -m pip install --quiet pyghidra capstone`;
    if (!existsSync(venvPy) || !hasPyghidra(venvPy)) {
        throw new Error(`venv setup failed under ${join(HOME_DIR, "venv")} — needs a system python 3.9+ on PATH`);
    }
    return venvPy;
}

/** Ensure Ghidra + its required JDK + a pyghidra-capable python are present; download/extract as needed. */
export async function ensureReEnv(): Promise<ReEnv> {
    const ghidraDir = await ensureGhidra();
    const javaHome = await ensureJdk(requiredJavaMajor(ghidraDir));
    const python = await ensurePython();
    return { ghidraDir, javaHome, python, logFile: join(HOME_DIR, "re-service.log") };
}
