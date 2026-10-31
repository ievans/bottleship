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
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";

export class SteamApi implements IModule {
    name = "steam_api";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        const exports = this.exports;

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
            "SteamUGC", "SteamApps", "SteamMatchmaking", "SteamMatchmakingServers",
            "SteamGameServer", "SteamNetworking",
        ];
        for (const name of interfaceGetters) {
            exports[name] = () => {
                Logger.log(LogCategory.SYSTEM, `[steam_api] ${name}() -> NULL (no interface vtable implemented yet)`);
                return 0;
            };
        }
    }
}
