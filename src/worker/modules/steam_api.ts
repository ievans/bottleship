/**
 * steam_api.dll — Valve's Steamworks C wrapper. rise.exe statically imports it; a missing
 * export fails the whole image's import bind (same rule as the CRT, see msvcr110.ts).
 *
 * Steamworks isn't a flat C API underneath: SteamUtils()/SteamUser()/etc. each return a
 * pointer to a C++ object whose vtable the game calls through directly (no QueryInterface —
 * unlike COM, the interface version is baked into the factory function's NAME, not asked
 * for at runtime). We do not have Valve's real interface vtables to transcribe (steam_api.dll
 * itself is just an IPC stub to the Steam client process — its own RTTI has no ISteam*
 * classes, confirmed by inspecting the real shipped DLL), and guessing a vtable's slot count
 * or arity is the single most expensive mistake this codebase keeps a standing warning about
 * (see install-com-vtable.ts, gog-sdk.ts): a wrong arity doesn't fail the one call, it walks
 * the caller's ESP off its own frame and crashes unrelated code later.
 *
 * So every interface getter below returns NULL rather than a fabricated object. This is
 * "fail safely, never a false success" the same way an unimplemented export elsewhere in
 * this codebase returns a value that cannot be mistaken for one (see UnimplementedReturn in
 * api/types.ts) — a title that null-checks after SteamUtils() etc. degrades instead of
 * calling through bytes we invented. The 22 flat entry points that ARE safe to implement for
 * real (Init/RunCallbacks/Shutdown, the callback (de)registration bookkeeping) get real
 * behavior, since those carry no guessed ABI risk.
 *
 * Whichever interface getter the game turns out to actually dereference will surface as a
 * clean null-pointer fault with a live EIP the harness can inspect — the next, evidence-
 * driven step once this boots, not something to guess upfront.
 *
 * SteamMatchmaking() stopped being one of those NULLs once that evidence actually arrived:
 * rise.exe (Steam v1.10 bundle, image base 0x400000) dereferences its result unchecked.
 * Disassembly at RVA 0x639320..0x639327 (capstone, tools/re):
 *   0xa3930c: call edi                  ; SteamMatchmaking() — "last_thunk: steam_api:
 *                                        ; SteamMatchmaking" in the crash log below
 *   0xa39317: mov ecx, esp
 *   0xa39319: mov edi, eax              ; edi = SteamMatchmaking()'s return value
 *   0xa3931b: mov dword ptr [ecx], edx      ; edx = [ebx+0x68] -> arg0
 *   0xa3931d: mov dword ptr [ecx+4], esi    ; esi = [ebx+0x6c] -> arg1
 *   0xa39320: mov eax, dword ptr [edi]      ; vtable ptr — faults here when edi is NULL
 *   0xa39322: mov ecx, edi              ; this = edi (thiscall)
 *   0xa39324: call dword ptr [eax+0x3c] ; slot 0x3c/4 = 15, 2 pushed dwords
 * Before this fix edi was 0 (SteamMatchmaking() answered NULL), so `mov eax,[edi]` read
 * real memory at address 0 — which this emulator's low memory map holds leftover
 * bootloader bytes for instead of faulting — and execution "escaped to bootloader" at
 * whatever address happened to be sitting there (logs/ron/bottleship-2026-11-04-20-4154-
 * rise-of-nations-steam110.log:9062 and :9183).
 *
 * We still don't have the real ISteamMatchmaking vtable — only this one slot, measured
 * from what the game itself calls. So the fix is NOT "transcribe the interface": it is the
 * same minimal-placeholder move as IGalaxyUnknown in gog-sdk.ts — a real vtable, sized to
 * reach slot 15, where every OTHER slot is a deliberately unverified 0-arg stub that logs
 * loudly if ever hit. A future log hit on one of those IS the next piece of evidence, not
 * a bug to silently paper over.
 *
 * That next piece of evidence arrived immediately: returning a real (non-NULL)
 * SteamMatchmaking() unlocks a SECOND call site the game could never previously reach
 * (it was gated behind `SteamMatchmaking() != NULL`, same object, rise.exe+0x638330):
 *   0xa38421: mov edx, dword ptr [eax]      ; eax = SteamMatchmaking(), edx = vtable
 *   0xa38439: call dword ptr [edx + 0x50]   ; slot 0x50/4 = 20, thiscall, 4 pushed dwords
 * Slot 20 sits 16 bytes past a 16-slot vtable (0..15 ends at offset 0x40) — reading
 * [vtable+0x50] with only 16 slots allocated is an out-of-bounds read into whatever the
 * allocator put next, and calling through that garbage is a second, unrelated way to
 * "escape to bootloader" that has nothing to do with stack cleanup. Extending the vtable
 * to reach slot 20 (still placeholders beyond what's measured) closes that specific OOB
 * read; it does not claim there is no slot 21+ still waiting to be found the same way.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { FunctionDescriptor, InterfaceDescriptor, ModuleDescriptor } from "../api/types";
import { createVTablesFromDescriptor, VTableInfo } from "../api/adapters/module-adapter";
import { createComObject } from "./d3d9/shared-state";

function method(name: string, argCount: number): FunctionDescriptor {
    return {
        name,
        params: Array.from({ length: argCount }, (_, i) => ({ name: `arg${i}`, type: "u32" as const })),
        returnType: "u32" as const,
        callingConvention: "stdcall" as const,
    };
}

/**
 * Slots 0..14 and 16..19: no call site evidence yet, so a minimal 0-arg placeholder (see
 * header). Slot 15 and slot 20 are measured call sites — their arg counts come from actual
 * disassembly, not a guess, but their semantics/return values are still unverified.
 */
const ISteamMatchmaking: InterfaceDescriptor = {
    name: "ISteamMatchmaking",
    methods: [
        ...Array.from({ length: 15 }, (_, i) => method(`Slot${i}`, 0)),
        method("Slot15", 2),
        ...Array.from({ length: 4 }, (_, i) => method(`Slot${16 + i}`, 0)),
        method("Slot20", 4),
    ],
};

/** Slot index -> pushed-arg count, published for the test that pins this layout. */
export const STEAM_MATCHMAKING_LAYOUT: readonly number[] =
    ISteamMatchmaking.methods.map((m) => m.params.length);

const steamMatchmakingDescriptor: ModuleDescriptor = {
    name: "steam_api",
    functions: [],
    interfaces: [ISteamMatchmaking],
};

export class SteamApi implements IModule {
    name = "steam_api";
    exports: Record<string, ThunkImplementation> = {};

    private process: Process | null = null;
    private matchmakingVtable: VTableInfo | null = null;
    private matchmakingObj = 0;

    initialize(process: Process): void {
        this.process = process;
        const exports = this.exports;

        // Returning true here while every interface getter below returns NULL is not a
        // state a real Steamworks client ever produces — ordinarily the two succeed or fail
        // together, and a title that trusts that pairing (checks SteamAPI_Init(), skips the
        // null-check on SteamUser() etc.) can still crash. The alternative, returning false,
        // is not uniformly safer: several titles treat Steam as hard-mandatory and abort
        // their own boot the moment SteamAPI_Init() fails, which forecloses this module ever
        // getting far enough to reach the specific interface a game actually dereferences —
        // the evidence this stub exists to surface in the first place (see the file header).
        // Reporting success and letting each real NULL dereference surface as its own,
        // separately diagnosable fault is the position this bring-up has verified in
        // practice gets further.
        exports["SteamAPI_Init"] = () => {
            Logger.log(LogCategory.SYSTEM, "[steam_api] SteamAPI_Init -> true (no real Steam client backing this)");
            return 1;
        };
        exports["SteamAPI_Shutdown"] = () => 0;
        exports["SteamAPI_RunCallbacks"] = () => 0;
        exports["SteamGameServer_RunCallbacks"] = () => 0;
        exports["SteamGameServer_Shutdown"] = () => 0;
        exports["SteamAPI_SetMiniDumpComment"] = () => 0;
        exports["SteamAPI_WriteMiniDump"] = () => 0;

        // Callback/call-result (de)registration: store nothing, fire nothing. A title that
        // blocks waiting for one of these to fire never gets woken — same tradeoff as any
        // other unimplemented async completion source, and the first thing to revisit if a
        // boot hangs waiting on a specific Steam call result.
        exports["SteamAPI_RegisterCallback"] = () => 0;
        exports["SteamAPI_UnregisterCallback"] = () => 0;
        exports["SteamAPI_RegisterCallResult"] = () => 0;
        exports["SteamAPI_UnregisterCallResult"] = () => 0;

        const interfaceGetters = [
            "SteamClient", "SteamUtils", "SteamUser", "SteamUserStats", "SteamFriends",
            "SteamUGC", "SteamApps", "SteamMatchmakingServers",
            "SteamGameServer", "SteamNetworking",
        ];
        for (const name of interfaceGetters) {
            exports[name] = () => {
                Logger.log(LogCategory.SYSTEM, `[steam_api] ${name}() -> NULL (no interface vtable implemented yet)`);
                return 0;
            };
        }

        // The one getter this bring-up has outgrown returning NULL for — see the class doc
        // comment above for the exact call site that dereferences it unchecked.
        exports["SteamMatchmaking"] = () => this.getMatchmaking();

        for (const i of [...Array.from({ length: 15 }, (_, i) => i), 16, 17, 18, 19]) {
            exports[`ISteamMatchmaking_Slot${i}`] = () => {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `[steam_api] ISteamMatchmaking slot ${i} called — unverified, 0 args assumed, returning 0`
                );
                return 0;
            };
        }
        exports["ISteamMatchmaking_Slot15"] = (_ctx, _mem, args) => {
            Logger.log(
                LogCategory.SYSTEM,
                `[steam_api] ISteamMatchmaking::Slot15(0x${(args[0] ?? 0).toString(16)}, 0x${(args[1] ?? 0).toString(16)}) -> 0`
            );
            return 0;
        };
        // Measured at rise.exe+0x638439 (see class doc comment): 4 pushed dwords, thiscall.
        // Arg semantics unverified — logged in full so a real behavior can be transcribed
        // from the next hit instead of guessed.
        exports["ISteamMatchmaking_Slot20"] = (_ctx, _mem, args) => {
            Logger.warn(
                LogCategory.SYSTEM,
                `[steam_api] ISteamMatchmaking::Slot20(0x${(args[0] ?? 0).toString(16)}, 0x${(args[1] ?? 0).toString(16)}, ` +
                `0x${(args[2] ?? 0).toString(16)}, 0x${(args[3] ?? 0).toString(16)}) -> 0 — unverified semantics`
            );
            return 0;
        };
    }

    private getMatchmaking(): number {
        if (this.matchmakingObj) return this.matchmakingObj;
        if (!this.process) return 0;
        if (!this.matchmakingVtable) {
            const vtables = createVTablesFromDescriptor(this.process, steamMatchmakingDescriptor);
            this.matchmakingVtable = vtables["ISteamMatchmaking"] ?? null;
        }
        if (!this.matchmakingVtable) return 0;
        this.matchmakingObj = createComObject(this.matchmakingVtable.address);
        Logger.log(
            LogCategory.SYSTEM,
            `[steam_api] SteamMatchmaking() -> 0x${this.matchmakingObj.toString(16)} (synthetic vtable, slots 15 and 20 measured)`
        );
        return this.matchmakingObj;
    }
}
