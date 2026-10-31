import { ModuleDescriptor, FunctionDescriptor } from "./types";

const ORDINALS = [1, 3, 5, 10, 11, 12, 13, 14, 15, 18, 19, 20, 25, 32, 33, 34, 36, 39, 40, 43, 44, 45, 46, 47, 71, 72, 73, 75, 77, 85];

/**
 * All 30 imports are by ordinal with no name in the import table, so there is no mangled
 * name or SDK header to derive a real arity from. cdecl + 0 args is a guess, same as every
 * ordinal here — see twitchsdk_32_release.ts for why that's an acceptable risk (an optional
 * broadcasting feature every title handles being absent).
 */
const f = (ordinal: number): FunctionDescriptor => ({
    name: `ord_${ordinal}`,
    ordinal,
    params: [],
    returnType: "u32",
    callingConvention: "cdecl",
});

export const twitchsdkModule: ModuleDescriptor = {
    name: "twitchsdk_32_release",
    functions: ORDINALS.map(f),
};
