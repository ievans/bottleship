/**
 * steam_api.dll — Valve's Steamworks C wrapper. rise.exe statically imports it; a missing
 * export fails the whole image's import bind (same rule as the CRT, see msvcr110.ts).
 *
 * Steamworks isn't a flat C API underneath: SteamUtils()/SteamUser()/etc. each return a
 * pointer to a C++ object whose vtable the game calls through directly (no QueryInterface —
 * the interface version is baked into the factory function's NAME). Each getter here returns
 * an object of exactly the interface version this SDK build (1.30) hands out, with every
 * vtable slot laid out from that version's header (steam/interfaces.ts, generated from
 * open-steamworks). The two ISteamMatchmaking slots measured from rise.exe's own call sites
 * before the tables existed (slot 15, 2 dwords; slot 20, 4 dwords) agree with them.
 *
 * There is no Steam client behind any of it. The objects describe a user who is logged on,
 * owns the game and has nothing else: no friends, no Workshop items, no cloud files, no
 * stats yet. Asynchronous requests return k_uAPICallInvalid, so no call result ever
 * arrives; every method without a behavior below returns zero (FALSE, NULL, an empty
 * handle, a zeroed CSteamID).
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { getCPU } from "../core/thunking/thunk-utils";
import { cpuViews } from "../core/cpu/cpu-views";
import { fpuPush } from "../core/fpu-helper";
import { FunctionDescriptor, InterfaceDescriptor, ModuleDescriptor } from "../api/types";
import { createVTablesFromDescriptor, VTableInfo } from "../api/adapters/module-adapter";
import { createComObject } from "./d3d9/shared-state";
import { STEAM_INTERFACES, type SteamReturn } from "./steam/interfaces";

/** Rise of Nations: Extended Edition's Steam app id. */
export const STEAM_APP_ID = 287450;
/** An individual account in the public universe: universe 1, type 1, instance 1. */
const STEAM_ID_HIGH = 0x01100001;
const STEAM_ACCOUNT_ID = 0x00bb11e5;
const UGC_QUERY_INVALID = 0xffffffff;

/** Which interface each flat getter hands out. SteamGameServer has no table yet. */
const GETTERS: Record<string, string> = {
    SteamClient: "ISteamClient015",
    SteamUser: "ISteamUser017",
    SteamUtils: "ISteamUtils007",
    SteamFriends: "ISteamFriends014",
    SteamMatchmaking: "ISteamMatchmaking009",
    SteamMatchmakingServers: "ISteamMatchmakingServers002",
    SteamUserStats: "ISteamUserStats011",
    SteamApps: "ISteamApps006",
    SteamUGC: "ISteamUGC002",
    SteamNetworking: "ISteamNetworking005",
};

/** The vtable-slot handler key for a method: overloads (GetStat ×2) get their slot appended. */
export function slotHandlerName(iface: string, slot: number): string {
    const methods = STEAM_INTERFACES[iface]!.methods;
    const name = methods[slot]![0];
    const overloaded = methods.filter((m) => m[0] === name).length > 1;
    return `${iface}_${overloaded ? `${name}${slot}` : name}`;
}

function descriptorFor(iface: string): InterfaceDescriptor {
    return {
        name: iface,
        methods: STEAM_INTERFACES[iface]!.methods.map((m, slot): FunctionDescriptor => ({
            name: slotHandlerName(iface, slot).slice(iface.length + 1),
            params: Array.from({ length: m[1] / 4 }, (_, i) => ({ name: `arg${i}`, type: "u32" as const })),
            returnType: "u32",
            callingConvention: "stdcall",
        })),
    };
}

const steamInterfacesDescriptor: ModuleDescriptor = {
    name: "steam_api",
    functions: [],
    interfaces: Object.keys(STEAM_INTERFACES).map(descriptorFor),
};

/** Slot index -> pushed-arg count, published for the test that pins this layout. */
export const STEAM_MATCHMAKING_LAYOUT: readonly number[] =
    STEAM_INTERFACES.ISteamMatchmaking009!.methods.map((m) => m[1] / 4);

type Behavior = (args: number[]) => number;

export class SteamApi implements IModule {
    name = "steam_api";
    exports: Record<string, ThunkImplementation> = {};

    private process: Process | null = null;
    private vtables: Record<string, VTableInfo> | null = null;
    private readonly objects = new Map<string, number>();
    private readonly strings = new Map<string, number>();
    private readonly logged = new Set<string>();

    initialize(process: Process): void {
        this.process = process;
        const exports = this.exports;

        exports["SteamAPI_Init"] = () => {
            Logger.log(LogCategory.SYSTEM, "[steam_api] SteamAPI_Init -> true (offline: no Steam client behind the interfaces)");
            return 1;
        };
        exports["SteamAPI_Shutdown"] = () => 0;
        exports["SteamAPI_RunCallbacks"] = () => 0;
        exports["SteamGameServer_RunCallbacks"] = () => 0;
        exports["SteamGameServer_Shutdown"] = () => 0;
        exports["SteamAPI_SetMiniDumpComment"] = () => 0;
        exports["SteamAPI_WriteMiniDump"] = () => 0;

        // Callback/call-result (de)registration: store nothing, fire nothing. Nothing here
        // starts an asynchronous request (each returns k_uAPICallInvalid), so there is no
        // result to deliver.
        exports["SteamAPI_RegisterCallback"] = () => 0;
        exports["SteamAPI_UnregisterCallback"] = () => 0;
        exports["SteamAPI_RegisterCallResult"] = () => 0;
        exports["SteamAPI_UnregisterCallResult"] = () => 0;

        for (const [getter, iface] of Object.entries(GETTERS)) exports[getter] = () => this.object(iface);
        exports["SteamGameServer"] = () => {
            Logger.log(LogCategory.SYSTEM, "[steam_api] SteamGameServer() -> NULL (no game-server interface table)");
            return 0;
        };

        for (const [iface, { methods }] of Object.entries(STEAM_INTERFACES)) {
            methods.forEach((m, slot) => {
                const key = slotHandlerName(iface, slot);
                const behavior = this.behaviors[`${iface}::${m[0]}`] as Behavior | undefined;
                exports[key] = (_ctx, _mem, args) => {
                    if (!this.logged.has(key)) {
                        this.logged.add(key);
                        Logger.log(LogCategory.SYSTEM, `[steam_api] ${iface}::${m[0]}(${m[3]}) first call${behavior ? "" : " — default zero"}`);
                    }
                    return behavior ? behavior(args) : this.zero(m[2], args);
                };
            });
        }
    }

    /** The one object a getter (or ISteamClient::GetISteam*) hands out for an interface. */
    private object(iface: string): number {
        const existing = this.objects.get(iface);
        if (existing) return existing;
        if (!this.process) return 0;
        this.vtables ??= createVTablesFromDescriptor(this.process, steamInterfacesDescriptor);
        const vt = this.vtables[iface];
        if (!vt) return 0;
        const obj = createComObject(vt.address) >>> 0;
        this.objects.set(iface, obj);
        Logger.log(LogCategory.SYSTEM, `[steam_api] ${iface} -> 0x${obj.toString(16)}`);
        return obj;
    }

    private string(text: string): number {
        let p = this.strings.get(text);
        if (p) return p;
        if (!this.process) return 0;
        p = this.process.memory.alloc(text.length + 1, "HEAP", "rw") >>> 0;
        const b = new Uint8Array(text.length + 1);
        for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0x7f;
        Mem.writeBytes(p, b);
        this.strings.set(text, p);
        return p;
    }

    /** EDX:EAX for a 64-bit return. */
    private ret64(lo: number, hi: number): number {
        const cpu = this.process?.v86 ? getCPU(this.process.v86) : null;
        if (cpu) cpuViews(cpu).reg32[2] = hi | 0;
        return lo >>> 0;
    }

    /** A CSteamID written through the hidden return pointer (args[0]). */
    private steamId(args: number[], lo: number, hi: number): number {
        const p = (args[0] ?? 0) >>> 0;
        if (p) { Mem.writeUint32(p, lo >>> 0); Mem.writeUint32(p + 4, hi >>> 0); }
        return p;
    }

    private zero(kind: SteamReturn, args: number[]): number {
        switch (kind) {
            case "u64": return this.ret64(0, 0);
            case "struct8": return this.steamId(args, 0, 0);
            case "f32": if (this.process?.v86) fpuPush(this.process.v86, 0); return 0;
            default: return 0;
        }
    }

    private readonly behaviors: Record<string, Behavior> = {
        "ISteamUser017::GetHSteamUser": () => 1,
        "ISteamUser017::BLoggedOn": () => 1,
        "ISteamUser017::GetSteamID": (a) => this.steamId(a, STEAM_ACCOUNT_ID, STEAM_ID_HIGH),
        "ISteamUser017::GetPlayerSteamLevel": () => 1,

        "ISteamUtils007::GetAppID": () => STEAM_APP_ID,
        "ISteamUtils007::GetConnectedUniverse": () => 1,
        "ISteamUtils007::GetServerRealTime": () => Math.floor(Date.now() / 1000),
        "ISteamUtils007::GetIPCountry": () => this.string("US"),
        "ISteamUtils007::GetCurrentBatteryPower": () => 255,
        "ISteamUtils007::GetSteamUILanguage": () => this.string("english"),
        // k_uAPICallInvalid never completes: report it failed rather than pending forever.
        "ISteamUtils007::IsAPICallCompleted": (a) => { if (a[2]) Mem.writeUint32(a[2]!, 1); return 0; },

        "ISteamFriends014::GetPersonaName": () => this.string("Player"),
        "ISteamFriends014::GetPersonaState": () => 1,
        "ISteamFriends014::GetFriendPersonaName": () => this.string(""),

        "ISteamApps006::BIsSubscribed": () => 1,
        "ISteamApps006::BIsSubscribedApp": (a) => (a[0] === STEAM_APP_ID ? 1 : 0),
        "ISteamApps006::GetCurrentGameLanguage": () => this.string("english"),
        "ISteamApps006::GetAvailableGameLanguages": () => this.string("english"),
        "ISteamApps006::GetAppOwner": (a) => this.steamId(a, STEAM_ACCOUNT_ID, STEAM_ID_HIGH),

        "ISteamUserStats011::RequestCurrentStats": () => 1,
        "ISteamUserStats011::StoreStats": () => 1,

        // Query handles come back invalid, so the game never waits on a Workshop listing.
        "ISteamUGC002::CreateQueryUserUGCRequest": () => this.ret64(UGC_QUERY_INVALID, UGC_QUERY_INVALID),
        "ISteamUGC002::CreateQueryAllUGCRequest": () => this.ret64(UGC_QUERY_INVALID, UGC_QUERY_INVALID),

        "ISteamRemoteStorage012::GetQuota": (a) => {
            if (a[0]) Mem.writeUint32(a[0]!, 100 << 20);
            if (a[1]) Mem.writeUint32(a[1]!, 100 << 20);
            return 1;
        },

        // ISteamClient hands the same objects out by version string (its last argument).
        ...Object.fromEntries(STEAM_INTERFACES.ISteamClient015!.methods
            .filter((m) => /^GetISteam/.test(m[0]))
            .map((m) => [`ISteamClient015::${m[0]}`, (a: number[]): number => {
                const versionPtr = (a[m[1] / 4 - 1] ?? 0) >>> 0;
                const bytes = versionPtr ? Mem.readBytes(versionPtr, 64) : null;
                const end = bytes ? bytes.indexOf(0) : -1;
                const version = bytes ? String.fromCharCode(...bytes.subarray(0, end < 0 ? 64 : end)) : "";
                const iface = Object.entries(STEAM_INTERFACES).find(([, v]) => v.version.toLowerCase() === version.toLowerCase())?.[0];
                return iface ? this.object(iface) : 0;
            }])),
        "ISteamClient015::CreateSteamPipe": () => 1,
        "ISteamClient015::ConnectToGlobalUser": () => 1,
    };
}
