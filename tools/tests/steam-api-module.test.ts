import { describe, expect, test } from "bun:test";
import { steamApiModule } from "../../src/worker/api/steam_api.api";
import { SteamApi } from "../../src/worker/modules/steam_api";

const INTERFACE_GETTERS = [
    "SteamClient", "SteamUtils", "SteamUser", "SteamUserStats", "SteamFriends",
    "SteamUGC", "SteamApps", "SteamMatchmaking", "SteamMatchmakingServers",
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
        const declared = new Set(steamApiModule.functions.map((f) => f.name));
        for (const name of Object.keys(module.exports)) {
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
