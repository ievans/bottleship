/**
 * GOG Galaxy install scripts (goggame-<id>.script) and shipped `regs.cmd` batch files carry
 * post-install registry writes that Inno's [Registry] section does not include — e.g.
 * LucasArts game keys, Microsoft Games keys.
 */

import type { RegistrySeed } from "./manifest-synth";

const ROOT_MAP: Record<string, string> = {
    HKEY_LOCAL_MACHINE: "HKLM",
    HKLM: "HKLM",
    HKEY_CURRENT_USER: "HKCU",
    HKCU: "HKCU",
    HKEY_CLASSES_ROOT: "HKCR",
    HKCR: "HKCR",
    HKEY_USERS: "HKU",
    HKU: "HKU",
};

function resolveAppPath(value: string, installRoot = "C:\\"): string {
    const normalized = value.replace(/\//g, "\\");
    if (/^\{app\}$/i.test(normalized)) {
        return installRoot.endsWith("\\") ? installRoot : `${installRoot}\\`;
    }
    const root = installRoot.replace(/\\$/, "");
    return normalized.replace(/\{app\}/gi, root);
}

function actionApplies(languages: unknown): boolean {
    if (!Array.isArray(languages) || languages.length === 0) return true;
    return languages.some((l) => l === "*" || l === "neutral");
}

function mapValueType(valueType: unknown): "REG_SZ" | "REG_DWORD" | null {
    const t = String(valueType ?? "string").toLowerCase();
    if (t === "dword" || t === "integer") return "REG_DWORD";
    if (t === "string" || t === "expandablestring" || t === "binary") return "REG_SZ";
    return null;
}

function parseScriptRegistryAction(
    args: Record<string, unknown>,
    installRoot: string,
): { root: string; path: string; name: string; type: "REG_SZ" | "REG_DWORD"; data: string | number } | null {
    if (args.deleteSubkeys) return null;
    const valueName = args.valueName;
    if (typeof valueName !== "string" || !valueName) return null;

    const rootRaw = String(args.root ?? "HKEY_LOCAL_MACHINE");
    const root = ROOT_MAP[rootRaw.toUpperCase()] ?? ROOT_MAP[rootRaw] ?? "HKLM";
    const subkey = String(args.subkey ?? "").replace(/\//g, "\\");
    if (!subkey || subkey.includes("{")) return null;

    const regType = mapValueType(args.valueType);
    if (!regType) return null;

    let rawData = String(args.valueData ?? "");
    if (regType === "REG_DWORD") {
        const n = parseInt(rawData, 10);
        if (!Number.isFinite(n)) return null;
        return { root, path: subkey, name: valueName, type: regType, data: n >>> 0 };
    }

    rawData = resolveAppPath(rawData, installRoot);
    if (rawData.includes("{")) return null;
    return { root, path: subkey, name: valueName, type: regType, data: rawData };
}

/** Parse one goggame-*.script JSON blob into registry seeds. */
export function parseGogScriptRegistry(
    scriptBytes: Uint8Array,
    installRoot = "C:\\",
): RegistrySeed[] {
    let parsed: { actions?: unknown[] };
    try {
        parsed = JSON.parse(new TextDecoder().decode(scriptBytes)) as { actions?: unknown[] };
    } catch {
        return [];
    }

    const byKey = new Map<string, RegistrySeed>();
    for (const item of parsed.actions ?? []) {
        if (!item || typeof item !== "object") continue;
        const row = item as { install?: { action?: string; arguments?: Record<string, unknown> }; languages?: unknown };
        if (!actionApplies(row.languages)) continue;
        const install = row.install;
        if (!install || install.action !== "setRegistry") continue;
        const args = install.arguments;
        if (!args || typeof args !== "object") continue;

        const entry = parseScriptRegistryAction(args, installRoot);
        if (!entry) continue;

        const seedKey = `${entry.root}\\${entry.path}`;
        let seed = byKey.get(seedKey);
        if (!seed) {
            seed = { root: entry.root, path: entry.path, values: [] };
            byKey.set(seedKey, seed);
        }
        const idx = seed.values.findIndex((v) => v.name.toLowerCase() === entry.name.toLowerCase());
        const value = { name: entry.name, type: entry.type, data: entry.data };
        if (idx >= 0) seed.values[idx] = value;
        else seed.values.push(value);
    }

    return [...byKey.values()];
}

/** Collect setRegistry seeds from all goggame-*.script files in an extracted map. */
export function synthesizeRegistryFromGogScripts(
    gameFiles: Map<string, Uint8Array>,
    installRoot = "C:\\",
): RegistrySeed[] {
    const byKey = new Map<string, RegistrySeed>();

    for (const [path, data] of gameFiles) {
        const base = path.split("/").pop() ?? "";
        if (!/^goggame-.*\.script$/i.test(base)) continue;
        for (const seed of parseGogScriptRegistry(data, installRoot)) {
            const seedKey = `${seed.root}\\${seed.path}`;
            const existing = byKey.get(seedKey);
            if (!existing) {
                byKey.set(seedKey, { ...seed, values: [...seed.values] });
                continue;
            }
            for (const v of seed.values) {
                const idx = existing.values.findIndex((e) => e.name.toLowerCase() === v.name.toLowerCase());
                if (idx >= 0) existing.values[idx] = v;
                else existing.values.push(v);
            }
        }
    }

    return [...byKey.values()];
}

function expandCmdVars(text: string, vars: Map<string, string>, scriptDir: string): string {
    return text
        .replace(/%~dp0/gi, scriptDir)
        .replace(/%([A-Za-z_][\w]*)(?::~(-?\d+)(?:,(-?\d+))?)?%/g, (whole, name: string, start?: string, len?: string) => {
            const value = vars.get(name.toLowerCase());
            if (value === undefined) return whole;
            if (start === undefined) return value;
            const from = Number(start);
            const begin = from < 0 ? Math.max(0, value.length + from) : Math.min(from, value.length);
            if (len === undefined) return value.slice(begin);
            const n = Number(len);
            const end = n < 0 ? value.length + n : begin + n;
            return value.slice(begin, Math.max(begin, end));
        });
}

function tokenizeCmd(line: string): string[] {
    const out: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2]);
    return out;
}

function splitRegKey(key: string): { root: string; path: string } | null {
    const i = key.indexOf("\\");
    const rootRaw = (i < 0 ? key : key.slice(0, i)).toUpperCase();
    const root = ROOT_MAP[rootRaw];
    if (!root) return null;
    return { root, path: i < 0 ? "" : key.slice(i + 1).replace(/\\+$/, "") };
}

/** Interpret the SET / REG ADD subset of a Windows batch file into registry seeds. */
export function parseRegsCmd(scriptBytes: Uint8Array, installRoot = "C:\\"): RegistrySeed[] {
    const scriptDir = installRoot.endsWith("\\") ? installRoot : `${installRoot}\\`;
    const vars = new Map<string, string>();
    const byKey = new Map<string, RegistrySeed>();

    for (const rawLine of new TextDecoder("windows-1252").decode(scriptBytes).split(/\r?\n/)) {
        const line = rawLine.trim().replace(/^@/, "");
        if (!line || line.startsWith("::") || /^rem(\s|$)/i.test(line)) continue;

        const set = /^set\s+(?:"([^=]+)=(.*)"|([^=\s]+)=(.*))$/i.exec(line);
        if (set) {
            vars.set((set[1] ?? set[3]).toLowerCase(), expandCmdVars(set[2] ?? set[4], vars, scriptDir));
            continue;
        }
        if (!/^reg\s+add\s/i.test(line)) continue;

        const args = tokenizeCmd(expandCmdVars(line, vars, scriptDir)).slice(2);
        const key = splitRegKey(args[0] ?? "");
        if (!key) continue;

        let name = "";
        let type = "REG_SZ";
        let data = "";
        for (let i = 1; i < args.length; i++) {
            const flag = args[i].toLowerCase();
            if (flag === "/v") name = args[++i] ?? "";
            else if (flag === "/ve") name = "";
            else if (flag === "/t") type = (args[++i] ?? "REG_SZ").toUpperCase();
            else if (flag === "/d") data = args[++i] ?? "";
        }

        let value: unknown = data;
        if (type === "REG_DWORD") {
            const n = /^0x/i.test(data) ? parseInt(data, 16) : parseInt(data, 10);
            if (!Number.isFinite(n)) continue;
            value = n >>> 0;
        } else if (type === "REG_BINARY") {
            if (!/^([0-9a-f]{2})*$/i.test(data)) continue;
            value = data.toLowerCase();
        } else if (type !== "REG_SZ" && type !== "REG_EXPAND_SZ") {
            continue;
        }

        const seedKey = `${key.root}\\${key.path}`;
        let seed = byKey.get(seedKey);
        if (!seed) {
            seed = { root: key.root, path: key.path, values: [] };
            byKey.set(seedKey, seed);
        }
        const entry = { name: name || "(Default)", type, data: value };
        const idx = seed.values.findIndex((v) => v.name.toLowerCase() === entry.name.toLowerCase());
        if (idx >= 0) seed.values[idx] = entry;
        else seed.values.push(entry);
    }

    return [...byKey.values()];
}

/** Collect `REG ADD` seeds from every regs.cmd in an extracted map. */
export function synthesizeRegistryFromRegsCmd(
    gameFiles: Map<string, Uint8Array>,
    installRoot = "C:\\",
): RegistrySeed[] {
    let merged: RegistrySeed[] = [];
    for (const [path, data] of gameFiles) {
        if (!/^regs\.cmd$/i.test(path.split("/").pop() ?? "")) continue;
        merged = mergeRegistrySeeds(merged, parseRegsCmd(data, installRoot));
    }
    return merged;
}

/** Merge registry seeds; later entries override same hive/path/value name. */
export function mergeRegistrySeeds(
    base: RegistrySeed | RegistrySeed[],
    extra: RegistrySeed[],
): RegistrySeed[] {
    const map = new Map<string, RegistrySeed>();

    const add = (seed: RegistrySeed) => {
        const key = `${seed.root}\\${seed.path}`;
        const existing = map.get(key);
        if (!existing) {
            map.set(key, { root: seed.root, path: seed.path, values: [...seed.values] });
            return;
        }
        for (const v of seed.values) {
            const idx = existing.values.findIndex((e) => e.name.toLowerCase() === v.name.toLowerCase());
            if (idx >= 0) existing.values[idx] = v;
            else existing.values.push(v);
        }
    };

    const list = Array.isArray(base) ? base : [base];
    for (const s of list) add(s);
    for (const s of extra) add(s);
    return [...map.values()];
}
