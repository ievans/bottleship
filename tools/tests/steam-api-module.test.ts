import { describe, expect, test } from "bun:test";
import { steamApiModule } from "../../src/worker/api/steam_api.api";
import { SteamApi, STEAM_MATCHMAKING_LAYOUT, STEAM_APP_ID, slotHandlerName } from "../../src/worker/modules/steam_api";
import { STEAM_INTERFACES } from "../../src/worker/modules/steam/interfaces";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { resetD3D9SharedState } from "../../src/worker/modules/d3d9/shared-state";

const call = (m: SteamApi, name: string, args: number[] = [], mem = new Uint8Array(0)) =>
    m.exports[name]!({} as any, mem, args) as number;

describe("steam_api", () => {
    test("declares every export with a matching handler", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        for (const fn of steamApiModule.functions) {
            expect(typeof module.exports[fn.name]).toBe(`function`);
        }
        // And the reverse: nothing registered at runtime that the descriptor doesn't know
        // about. ISteam* keys are vtable slot handlers, not PE exports; their layout is
        // pinned against steam/interfaces.ts below.
        const declared = new Set(steamApiModule.functions.map((f) => f.name));
        for (const name of Object.keys(module.exports)) {
            if (name.startsWith("ISteam")) continue;
            expect(declared.has(name)).toBe(true);
        }
    });

    test("every flat export is plain cdecl — caller cleans up, no generated callee RET N", () => {
        for (const fn of steamApiModule.functions) {
            expect(fn.callingConvention).toBe("cdecl");
        }
    });

    test("SteamAPI_Init reports success", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        expect(call(module, "SteamAPI_Init")).toBe(1);
    });

    test("call-result (de)registration takes a pointer plus a 64-bit handle as 3 stack dwords", () => {
        const registerCallResult = steamApiModule.functions.find((f) => f.name === "SteamAPI_RegisterCallResult")!;
        const unregisterCallResult = steamApiModule.functions.find((f) => f.name === "SteamAPI_UnregisterCallResult")!;
        expect(registerCallResult.params.length).toBe(3);
        expect(unregisterCallResult.params.length).toBe(3);
    });

    test("callback (de)registration and call-result bookkeeping are harmless no-ops", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        for (const name of [
            "SteamAPI_RegisterCallback", "SteamAPI_UnregisterCallback",
            "SteamAPI_RegisterCallResult", "SteamAPI_UnregisterCallResult",
            "SteamAPI_RunCallbacks", "SteamGameServer_RunCallbacks",
            "SteamAPI_Shutdown", "SteamGameServer_Shutdown",
            "SteamAPI_SetMiniDumpComment", "SteamAPI_WriteMiniDump",
        ]) {
            expect(() => call(module, name, [0, 0, 0])).not.toThrow();
        }
    });

    test("without a process, every getter fails safe to NULL instead of throwing", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        for (const name of ["SteamUser", "SteamUtils", "SteamUGC", "SteamMatchmaking", "SteamGameServer"]) {
            expect(call(module, name)).toBe(0);
        }
    });
});

describe("steam_api — interface layouts", () => {
    // Slots and stack sizes rise.exe's own call sites pin, independently of the headers.
    test("the slots rise.exe calls are where its call sites expect them", () => {
        // rise.exe+0x10542b: call [edx+8] on SteamUser(), one pushed dword (the CSteamID return buffer).
        expect(STEAM_INTERFACES.ISteamUser017!.methods[2]).toEqual(["GetSteamID", 4, "struct8", ""]);
        // rise.exe+0x105438/0x105441: call [eax+0x24] on SteamUtils(), nothing pushed.
        expect(STEAM_INTERFACES.ISteamUtils007!.methods[9]!.slice(0, 2)).toEqual(["GetAppID", 0]);
        // Measured before these tables existed (#52, #53): slot 15 pops 2 dwords, slot 20 pops 4.
        expect(STEAM_MATCHMAKING_LAYOUT[15]).toBe(2);
        expect(STEAM_MATCHMAKING_LAYOUT[20]).toBe(4);
    });

    test("every slot pops whole dwords and has a unique handler", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        for (const [iface, { methods }] of Object.entries(STEAM_INTERFACES)) {
            const names = new Set<string>();
            methods.forEach((m, slot) => {
                expect(m[1] % 4).toBe(0);
                const key = slotHandlerName(iface, slot);
                expect(names.has(key)).toBe(false);
                names.add(key);
                expect(typeof module.exports[key]).toBe("function");
            });
        }
    });
});

describe("steam_api — objects", () => {
    let originalProcess: unknown;
    let mem: Uint8Array;

    const installMockProcess = () => {
        const system = System.getInstance() as any;
        originalProcess = system.process;
        mem = new Uint8Array(0x100000);
        let next = 0x1000;
        const thunkGenerator = new ThunkGenerator();
        thunkGenerator.setBaseAddress(0x10000);
        system.process = {
            memory: {
                alloc: (size: number) => { const ptr = next; next += Math.max(4, size); return ptr; },
                allocAt: () => undefined,
                allocSystemBlock: (size: number) => { const ptr = next; next += Math.max(16, size); return ptr; },
                free: () => undefined,
                freeSystemBlock: () => {},
            },
            dispatcher: {
                registerModule: () => undefined,
                applyPendingRegistrations: () => undefined,
            },
            thunkGenerator,
            getCurrentMemory: () => mem,
        };
        Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
        resetD3D9SharedState();
        return system.process;
    };
    const restore = () => {
        (System.getInstance() as any).process = originalProcess;
        resetD3D9SharedState();
    };

    test("SteamUser() returns a real object, the same one on every call", () => {
        const process = installMockProcess();
        try {
            const module = new SteamApi();
            module.initialize(process);
            const first = call(module, "SteamUser", [], mem);
            expect(first).not.toBe(0);
            expect(call(module, "SteamUser", [], mem)).toBe(first);
            expect(call(module, "SteamUtils", [], mem)).not.toBe(first);
        } finally { restore(); }
    });

    test("GetSteamID writes an individual public-universe CSteamID through the hidden pointer", () => {
        const process = installMockProcess();
        try {
            const module = new SteamApi();
            module.initialize(process);
            const out = 0x8000;
            expect(call(module, "ISteamUser017_GetSteamID", [out], mem)).toBe(out);
            const hi = Mem.readUint32(out + 4)!;
            expect(hi >>> 24).toBe(1);            // universe: public
            expect((hi >>> 20) & 0xf).toBe(1);    // account type: individual
            expect(Mem.readUint32(out)).not.toBe(0);
        } finally { restore(); }
    });

    test("a Workshop query completes: a real call handle, and an empty OK result", () => {
        const process = installMockProcess();
        try {
            const module = new SteamApi();
            module.initialize(process);
            const query = call(module, "ISteamUGC002_CreateQueryUserUGCRequest", [], mem);
            expect(query).not.toBe(0);
            const handle = call(module, "ISteamUGC002_SendQueryUGCRequest", [query, 0], mem);
            expect(handle).not.toBe(0);
            const failed = 0x9000, result = 0x9100;
            expect(call(module, "ISteamUtils007_IsAPICallCompleted", [handle, 0, failed], mem)).toBe(1);
            expect(Mem.readUint32(failed)).toBe(0);
            expect(call(module, "ISteamUtils007_GetAPICallResult", [handle, 0, result, 24, 3401, failed], mem)).toBe(1);
            expect(Mem.readUint32(result)).toBe(query);      // m_handle
            expect(Mem.readUint32(result + 8)).toBe(1);      // m_eResult = k_EResultOK
            expect(Mem.readUint32(result + 12)).toBe(0);     // no results
        } finally { restore(); }
    });

    test("the user is logged on and owns the game", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        expect(call(module, "ISteamUser017_BLoggedOn")).toBe(1);
        expect(call(module, "ISteamUtils007_GetAppID")).toBe(STEAM_APP_ID);
        expect(call(module, "ISteamApps006_BIsSubscribedApp", [STEAM_APP_ID])).toBe(1);
    });
});
