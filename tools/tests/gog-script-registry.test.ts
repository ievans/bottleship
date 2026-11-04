import { describe, expect, test } from "bun:test";
import { parseGogScriptRegistry, mergeRegistrySeeds, parseRegsCmd } from "@bottleship/repack/gog-script";
import { installerDirsToCreateDirs } from "@bottleship/repack/manifest-synth";

const SW_RACER_SCRIPT = {
    actions: [
        {
            install: {
                action: "setRegistry",
                arguments: {
                    root: "HKEY_LOCAL_MACHINE",
                    subkey: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer\\v1.0",
                    valueData: "{app}\\SWEP1RCR.EXE",
                    valueName: "Executable",
                    valueType: "string",
                },
            },
            languages: ["*"],
            name: "registryKey01",
        },
        {
            install: {
                action: "setRegistry",
                arguments: {
                    root: "HKEY_LOCAL_MACHINE",
                    subkey: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer\\v1.0",
                    valueData: "{app}",
                    valueName: "Install Path",
                    valueType: "string",
                },
            },
            languages: ["*"],
            name: "registryKey02",
        },
        {
            install: {
                action: "setRegistry",
                arguments: {
                    root: "HKEY_LOCAL_MACHINE",
                    subkey: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer\\v1.0",
                    valueData: "9",
                    valueName: "InstallType",
                    valueType: "dword",
                },
            },
            languages: ["*"],
            name: "registryKey11",
        },
        {
            install: {
                action: "setRegistry",
                arguments: {
                    deleteSubkeys: true,
                    root: "HKEY_LOCAL_MACHINE",
                    subkey: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer",
                },
            },
            languages: ["*"],
            name: "registryKey17",
        },
        {
            install: {
                action: "Execute",
                arguments: { executable: "{app}/ipx_reg.cmd" },
            },
            languages: ["*"],
            name: "AddIPXRegs",
        },
    ],
    productId: "1288119483",
};

describe("gog-script registry", () => {
    test("parses setRegistry actions with {app} expansion", () => {
        const bytes = new TextEncoder().encode(JSON.stringify(SW_RACER_SCRIPT));
        const seeds = parseGogScriptRegistry(bytes, "C:\\");

        const lucas = seeds.find((s) => s.path.includes("LucasArts"));
        expect(lucas).toBeDefined();
        expect(lucas!.root).toBe("HKLM");

        const exe = lucas!.values.find((v) => v.name === "Executable");
        expect(exe).toEqual({ name: "Executable", type: "REG_SZ", data: "C:\\SWEP1RCR.EXE" });

        const installPath = lucas!.values.find((v) => v.name === "Install Path");
        expect(installPath).toEqual({ name: "Install Path", type: "REG_SZ", data: "C:\\" });

        const installType = lucas!.values.find((v) => v.name === "InstallType");
        expect(installType).toEqual({ name: "InstallType", type: "REG_DWORD", data: 9 });
    });

    test("skips deleteSubkeys and non-registry actions", () => {
        const bytes = new TextEncoder().encode(JSON.stringify(SW_RACER_SCRIPT));
        const seeds = parseGogScriptRegistry(bytes, "C:\\");
        expect(seeds).toHaveLength(1);
        expect(seeds[0]!.values).toHaveLength(3);
    });

    test("mergeRegistrySeeds lets later script values override Inno metadata", () => {
        const inno = [{
            root: "HKLM",
            path: "SOFTWARE\\GOG.com\\Games\\1288119483",
            values: [{ name: "ver", type: "REG_SZ", data: "\uFFFD" }],
        }];
        const script = [{
            root: "HKLM",
            path: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer\\v1.0",
            values: [{ name: "Executable", type: "REG_SZ", data: "C:\\SWEP1RCR.EXE" }],
        }];
        const merged = mergeRegistrySeeds(inno, script);
        expect(merged).toHaveLength(2);
        expect(merged.some((s) => s.path.includes("LucasArts"))).toBe(true);
    });
});

describe("parseRegsCmd", () => {
    const CC2 = [
        "@echo off",
        "SET locpath=%~dp0",
        "SET locpath=%locpath:~0,-1%",
        'SET regpath="HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft Games\\Close Combat\\2.00"',
        '::echo %locpath%',
        'REG ADD %regpath% /v "PID" /t REG_SZ /d "67361-442" /f /reg:32',
        'REG ADD %regpath% /v "InstalledTo" /t REG_SZ /d "%locpath%" /f /reg:32',
        'REG ADD %regpath% /v "InstalledFrom" /t REG_SZ /d "%locpath%\\\\_cd\\\\" /f /reg:32',
        "REG ADD %regpath% /v \"IType\" /t REG_BINARY /d 01000000 /f /reg:32",
        "REG ADD %regpath% /v \"Count\" /t REG_DWORD /d 0x10 /f",
        "exit",
    ].join("\r\n");

    test("expands %~dp0 and substring variables, keeps binary as hex", () => {
        const [seed] = parseRegsCmd(new TextEncoder().encode(CC2), "C:\\");
        expect(seed.root).toBe("HKLM");
        expect(seed.path).toBe("SOFTWARE\\Microsoft\\Microsoft Games\\Close Combat\\2.00");
        const byName = Object.fromEntries(seed.values.map((v) => [v.name, v]));
        expect(byName.PID.data).toBe("67361-442");
        expect(byName.InstalledTo.data).toBe("C:");
        expect(byName.InstalledFrom.data).toBe("C:\\\\_cd\\\\");
        expect(byName.IType).toEqual({ name: "IType", type: "REG_BINARY", data: "01000000" });
        expect(byName.Count).toEqual({ name: "Count", type: "REG_DWORD", data: 16 });
    });

    test("ignores unrelated lines and unknown roots", () => {
        expect(parseRegsCmd(new TextEncoder().encode('echo hi\r\nREG ADD "BOGUS\\x" /v a /d b'), "C:\\")).toEqual([]);
    });
});

describe("installerDirsToCreateDirs", () => {
    test("keeps GOG [Dirs] entries that end in a backslash", () => {
        expect(
            installerDirsToCreateDirs([
                { name: "{app}" },
                { name: "{app}\\games\\battles\\" },
                { name: "{app}\\games\\save\\" },
                { name: "{app}\\temp\\" },
                { name: "{tmp}\\scratch\\" },
            ]),
        ).toEqual(["games\\battles", "games\\save", "temp"]);
    });
});
