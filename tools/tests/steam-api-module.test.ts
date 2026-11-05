import { describe, expect, test } from "bun:test";
import { steamApiModule } from "../../src/worker/api/steam_api.api";
import { SteamApi, STEAM_MATCHMAKING_LAYOUT } from "../../src/worker/modules/steam_api";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { resetD3D9SharedState } from "../../src/worker/modules/d3d9/shared-state";

// SteamMatchmaking is excluded here: rise.exe dereferences its result unchecked (see
// modules/steam_api.ts's class doc comment), so it now answers a real, minimal vtable
// object instead of NULL. Its own behavior is pinned in the describe block below.
const INTERFACE_GETTERS = [
    "SteamClient", "SteamUtils", "SteamUser", "SteamUserStats", "SteamFriends",
    "SteamUGC", "SteamApps", "SteamMatchmakingServers",
    "SteamGameServer", "SteamNetworking",
];

describe("steam_api", () => {
    test("declares every export with a matching handler", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        for (const fn of steamApiModule.functions) {
            expect(typeof module.exports[fn.name]).toBe(`function`);
        }
        // And the reverse: nothing registered at runtime that the descriptor doesn't know
        // about, which would otherwise bind by inferred ABI instead of a declared one.
        // ISteamMatchmaking_* keys are the exception: those are vtable slot handlers, not
        // PE exports, so they're pinned by the ISteamMatchmaking layout test below instead.
        const declared = new Set(steamApiModule.functions.map((f) => f.name));
        for (const name of Object.keys(module.exports)) {
            if (name.startsWith("ISteamMatchmaking_")) continue;
            expect(declared.has(name)).toBe(true);
        }
    });

    test("every flat export is plain cdecl — caller cleans up, no generated callee RET N", () => {
        // steam_api.h's S_API surface is extern "C" cdecl throughout; a callee-cleaning
        // stub here would desync ESP against every real caller, which always pops its own
        // arguments.
        for (const fn of steamApiModule.functions) {
            expect(fn.callingConvention).toBe("cdecl");
        }
    });

    test("SteamAPI_Init reports success without a real Steam client backing it", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        expect(module.exports["SteamAPI_Init"]!({} as any, new Uint8Array(0), [])).toBe(1);
    });

    test("every interface getter returns NULL rather than a guessed vtable", () => {
        // steam_api.dll's own RTTI has no ISteam* classes to transcribe a vtable from —
        // guessing one's slot count/arity is the exact mistake install-com-vtable.ts and
        // gog-sdk.ts warn about, so every getter must fail safely instead of fabricating an
        // object a caller would then call through.
        const module = new SteamApi();
        module.initialize(null as any);
        for (const name of INTERFACE_GETTERS) {
            expect(module.exports[name]!({} as any, new Uint8Array(0), [])).toBe(0);
        }
    });

    test("call-result (de)registration takes a pointer plus a 64-bit handle as 3 stack dwords", () => {
        const registerCallResult = steamApiModule.functions.find((f) => f.name === "SteamAPI_RegisterCallResult")!;
        const unregisterCallResult = steamApiModule.functions.find((f) => f.name === "SteamAPI_UnregisterCallResult")!;
        // (pCallback: ptr = 1 dword) + (hAPICall: SteamAPICall_t, a u64 = 2 dwords) = 3.
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
            expect(() => module.exports[name]!({} as any, new Uint8Array(0), [0, 0, 0])).not.toThrow();
        }
    });
});

describe("steam_api — SteamMatchmaking", () => {
    // ISteamMatchmaking's ONE measured slot — see modules/steam_api.ts's class doc comment
    // for the disassembly this is transcribed from. Pinned literally so an edit has to
    // change it deliberately, same rationale as galaxy-gog-sdk-vtables.test.ts.
    test("publishes 16 slots: 0..14 unverified (0 args), slot 15 measured (2 args)", () => {
        expect(STEAM_MATCHMAKING_LAYOUT.length).toBe(16);
        expect([...STEAM_MATCHMAKING_LAYOUT.slice(0, 15)]).toEqual(Array(15).fill(0));
        expect(STEAM_MATCHMAKING_LAYOUT[15]).toBe(2);
    });

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

    test("returns a real object instead of NULL, and the same one on every call", () => {
        const process = installMockProcess();
        try {
            const module = new SteamApi();
            module.initialize(process);
            const first = module.exports["SteamMatchmaking"]!({} as any, mem, []);
            expect(first).not.toBe(0);
            const second = module.exports["SteamMatchmaking"]!({} as any, mem, []);
            expect(second).toBe(first);
        } finally {
            (System.getInstance() as any).process = originalProcess;
            resetD3D9SharedState();
        }
    });

    test("without a process, SteamMatchmaking fails safe to NULL instead of throwing", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        expect(module.exports["SteamMatchmaking"]!({} as any, new Uint8Array(0), [])).toBe(0);
    });

    test("slot 15's handler reads both pushed args and never throws", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        expect(() =>
            module.exports["ISteamMatchmaking_Slot15"]!({} as any, new Uint8Array(0), [0xdeadbeef, 0x1234])
        ).not.toThrow();
        expect(module.exports["ISteamMatchmaking_Slot15"]!({} as any, new Uint8Array(0), [0, 0])).toBe(0);
    });

    test("every unverified slot (0..14) logs instead of silently guessing and returns 0", () => {
        const module = new SteamApi();
        module.initialize(null as any);
        for (let i = 0; i < 15; i++) {
            expect(module.exports[`ISteamMatchmaking_Slot${i}`]!({} as any, new Uint8Array(0), [])).toBe(0);
        }
    });
});
