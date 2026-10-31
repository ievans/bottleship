import { ModuleDescriptor, FunctionDescriptor } from "./types";

const buildParams = (count: number) => {
    const params = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" as const });
    }
    return params;
};

/** steam_api.h's S_API flat functions are plain extern "C" cdecl — caller pops regardless. */
const f = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "cdecl",
    ...overrides,
});

export const steamApiModule: ModuleDescriptor = {
    name: "steam_api",
    functions: [
        f("SteamAPI_Init", 0),
        f("SteamAPI_Shutdown", 0, { returnType: "void" }),
        f("SteamAPI_RunCallbacks", 0, { returnType: "void" }),
        f("SteamGameServer_RunCallbacks", 0, { returnType: "void" }),
        f("SteamGameServer_Shutdown", 0, { returnType: "void" }),
        f("SteamAPI_SetMiniDumpComment", 1, { returnType: "void" }),
        f("SteamAPI_WriteMiniDump", 3, { returnType: "void" }),
        f("SteamAPI_RegisterCallback", 2, { returnType: "void" }),
        f("SteamAPI_UnregisterCallback", 1, { returnType: "void" }),
        f("SteamAPI_RegisterCallResult", 3, { returnType: "void" }), // (pCallback, hAPICall u64)
        f("SteamAPI_UnregisterCallResult", 3, { returnType: "void" }),
        f("SteamClient", 0),
        f("SteamUtils", 0),
        f("SteamUser", 0),
        f("SteamUserStats", 0),
        f("SteamFriends", 0),
        f("SteamUGC", 0),
        f("SteamApps", 0),
        f("SteamMatchmaking", 0),
        f("SteamMatchmakingServers", 0),
        f("SteamGameServer", 0),
        f("SteamNetworking", 0),
    ],
};
