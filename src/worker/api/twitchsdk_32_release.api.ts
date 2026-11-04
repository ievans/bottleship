import { ModuleDescriptor } from "./types";

/**
 * All 30 imports are by ordinal with no name in the import table, so there is no mangled
 * name or SDK header to derive a real arity from. cdecl + 0 args is a guess, same as every
 * ordinal here — see twitchsdk_32_release.ts for why that's an acceptable risk (an optional
 * broadcasting feature every title handles being absent).
 *
 * Written as literal object entries, with the ordinal declared right on each one, rather
 * than built from an array via .map(): the signature-validator's AST scanner (and
 * ApiCoverageIndex/api-census behind it) only recognizes a `functions:` array as a
 * ModuleDescriptor-typed object's literal initializer, and only discovers an export's name/
 * arity/ordinal by reading `name`/`params`/`ordinal` properties directly off each array
 * element — a `.map(f)` call is invisible to it, so every one of these previously counted
 * as an unimplemented/ABI-gap import despite having a real runtime handler. The real export
 * table (buildHleModuleImage; see hle-module-image.ts) now preserves these ordinals
 * exactly, holes included, so the loader resolves ordinal 3 to ITS OWN body rather than
 * whichever entry happened to sit at array index 1.
 */
export const twitchsdkModule: ModuleDescriptor = {
    name: "twitchsdk_32_release",
    functions: [
        { name: "ord_1", ordinal: 1, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_3", ordinal: 3, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_5", ordinal: 5, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_10", ordinal: 10, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_11", ordinal: 11, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_12", ordinal: 12, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_13", ordinal: 13, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_14", ordinal: 14, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_15", ordinal: 15, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_18", ordinal: 18, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_19", ordinal: 19, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_20", ordinal: 20, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_25", ordinal: 25, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_32", ordinal: 32, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_33", ordinal: 33, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_34", ordinal: 34, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_36", ordinal: 36, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_39", ordinal: 39, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_40", ordinal: 40, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_43", ordinal: 43, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_44", ordinal: 44, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_45", ordinal: 45, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_46", ordinal: 46, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_47", ordinal: 47, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_71", ordinal: 71, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_72", ordinal: 72, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_73", ordinal: 73, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_75", ordinal: 75, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_77", ordinal: 77, params: [], returnType: "u32", callingConvention: "cdecl" },
        { name: "ord_85", ordinal: 85, params: [], returnType: "u32", callingConvention: "cdecl" },
    ],
};
