import { describe, expect, test } from "bun:test";
import { copyrightYear, synthesizeManifest, synthesizeRegistry } from "@bottleship/repack/manifest-synth";
import type { InnoParseResult } from "@bottleship/formats/inno";

describe("gog-import/copyrightYear", () => {
    test("plain single year", () => {
        expect(copyrightYear("(C) 1999 Perfect Entertainment")).toBe(1999);
    });

    test("range picks the latest year (closest to release)", () => {
        expect(copyrightYear("© 1997-2002 Some Studio")).toBe(2002);
        expect(copyrightYear("Copyright 1998, 2000 Publisher")).toBe(2000);
    });

    test("no year / missing string", () => {
        expect(copyrightYear("All rights reserved")).toBeUndefined();
        expect(copyrightYear(undefined)).toBeUndefined();
        expect(copyrightYear("")).toBeUndefined();
    });

    test("ignores non-year numbers (versions, addresses)", () => {
        expect(copyrightYear("v1.44 build 4242, © 2001")).toBe(2001);
    });
});

function fakeParsed(header: Partial<Record<string, string>>): InnoParseResult {
    return {
        header: { appName: "Test Game", appVersion: "1.0", ...header },
        files: [],
        icons: [],
        registryEntries: [],
        version: { isUnicode: () => false },
    } as unknown as InnoParseResult;
}

function shortcut(filename: string, parameters: string) {
    return { name: "{group}\\Play", filename, parameters, workingDir: "{app}", iconFile: "", comment: "",
        appUserModelId: "", iconIndex: 0, showCommand: 1, closeOnExit: 0, hotkey: 0, options: 0 };
}

describe("gog-import/synthesizeManifest shortcut command line", () => {
    // Pre-Galaxy GOG installers (no goggame-*.info) start Cossacks: European Wars through a
    // playlist player that quits when it gets no arguments.
    const cossacks = ".\\videos\\cdv.avi .\\videos\\kz.avi .\\videos\\Logo.avi dmln.exe";

    test("the shortcut that picks the entrypoint also supplies its arguments", () => {
        const parsed = { ...fakeParsed({}), icons: [shortcut("{app}\\Cossacks.exe", cossacks)] } as unknown as InnoParseResult;
        const { manifest } = synthesizeManifest({ parsed, gameFiles: new Map() });
        expect(manifest.entrypoint).toBe("rom/Cossacks.exe");
        expect(manifest.args).toBe(cossacks);
    });

    test("{app} in parameters resolves; other unresolved constants drop the arguments", () => {
        const resolved = { ...fakeParsed({}), icons: [shortcut("{app}\\game.exe", "-data {app}\\data")] } as unknown as InnoParseResult;
        expect(synthesizeManifest({ parsed: resolved, gameFiles: new Map() }).manifest.args).toBe("-data C:\\data");
        const unresolved = { ...fakeParsed({}), icons: [shortcut("{app}\\game.exe", "-cd {src}")] } as unknown as InnoParseResult;
        expect(synthesizeManifest({ parsed: unresolved, gameFiles: new Map() }).manifest.args).toBeUndefined();
    });

    test("an explicit --exe does not inherit a shortcut's arguments", () => {
        const parsed = { ...fakeParsed({}), icons: [shortcut("{app}\\Cossacks.exe", cossacks)] } as unknown as InnoParseResult;
        const { manifest } = synthesizeManifest({ parsed, gameFiles: new Map(), cli: { exe: "dmcr.exe" } });
        expect(manifest.entrypoint).toBe("rom/dmcr.exe");
        expect(manifest.args).toBeUndefined();
    });
});

describe("gog-import/synthesizeManifest meta block", () => {
    test("emits manifest.meta with developer + year from the Inno header", () => {
        const { manifest } = synthesizeManifest({
            parsed: fakeParsed({ appPublisher: "Perfect Entertainment", appCopyright: "© 1999 Perfect Entertainment" }),
            gameFiles: new Map(),
            cli: { exe: "game.exe" },
        });
        expect(manifest.meta).toEqual({ developer: "Perfect Entertainment", year: 1999 });
    });

    test("omits meta entirely when the header has neither publisher nor a year", () => {
        const { manifest } = synthesizeManifest({
            parsed: fakeParsed({}),
            gameFiles: new Map(),
            cli: { exe: "game.exe" },
        });
        expect(manifest.meta).toBeUndefined();
    });

    test("partial meta: developer only", () => {
        const { manifest } = synthesizeManifest({
            parsed: fakeParsed({ appPublisher: "Some Studio" }),
            gameFiles: new Map(),
            cli: { exe: "game.exe" },
        });
        expect(manifest.meta).toEqual({ developer: "Some Studio" });
    });

    test("override.manifest.meta deep-merges over synthesized meta", () => {
        const { manifest } = synthesizeManifest({
            parsed: fakeParsed({ appPublisher: "Wrong Corp", appCopyright: "© 2000" }),
            gameFiles: new Map(),
            cli: { exe: "game.exe" },
            override: { manifest: { meta: { developer: "Right Corp", cover: "cover.png" } } },
        });
        expect(manifest.meta).toEqual({ developer: "Right Corp", year: 2000, cover: "cover.png" });
    });
});

describe("gog-import/synthesizeRegistry value types", () => {
    const ascii = (text: string) => new TextEncoder().encode(text);
    const entry = (type: number, name: string, value: Uint8Array) => ({ hive: 2, key: "Software\\Vendor\\Game", name, type, value });
    const seed = (entries: unknown[]) =>
        synthesizeRegistry({ ...fakeParsed({}), registryEntries: entries } as unknown as InnoParseResult)[0].values;

    // Inno stores a DWORD as its script text, not as four binary bytes.
    test("rtDWord is parsed from script text, decimal or $hex", () => {
        const values = seed([
            entry(3, "Flag", ascii("1")),
            entry(3, "Mask", ascii("$1F")),
            entry(6, "Wide", ascii("4096")),
        ]);
        expect(values).toEqual([
            { name: "Flag", type: "REG_DWORD", data: 1 },
            { name: "Mask", type: "REG_DWORD", data: 31 },
            { name: "Wide", type: "REG_DWORD", data: 4096 },
        ]);
    });

    test("rtBinary becomes a hex string typed REG_BINARY", () => {
        expect(seed([entry(4, "Blob", new Uint8Array([0, 0xab, 0x10]))]))
            .toEqual([{ name: "Blob", type: "REG_BINARY", data: "00ab10" }]);
    });

    test("strings keep REG_SZ", () => {
        expect(seed([entry(1, "Path", ascii("C:\\Game\0"))]))
            .toEqual([{ name: "Path", type: "REG_SZ", data: "C:\\Game" }]);
    });
});
