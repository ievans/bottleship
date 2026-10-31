import { FunctionDescriptor } from "./types";

const buildParams = (count: number) => {
    const params = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" as const });
    }
    return params;
};

/** A thiscall method — ECX carries `this`, not counted among `params` (stack args only). */
const method = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall", // generator's thiscall == stdcall + stackCleanupBytes (see msvcrt.api.ts)
    stackCleanupBytes: argCount * 4,
    ...overrides,
});

/** A free cdecl function — caller pops, so stackCleanupBytes is always 0 regardless of argCount. */
const free = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "cdecl",
    ...overrides,
});

/**
 * MSVCP110 (VC++2012 C++ standard library) — iostream/locale internals. Every arity below
 * is read off the real STL method signature these mangled names decorate (codecvt::in/out
 * take 7 reference/pointer params per the standard, unshift takes 4, etc.) rather than
 * derived mechanically: msvc-mangling.ts's deriver BAILs on all of these because every one
 * sits on a class TEMPLATE (`?$basic_ostream`, `?$codecvt`, …), which is in its documented
 * exclusion list. See msvcp110.ts for the (intentionally minimal) handler behavior.
 */
/**
 * NOTE: msvcp70/71/80/100/110/120 all alias to the "msvcp90" HLE module (see
 * MSVCP_VERSIONED in dll-aliases.ts) — a real MSVCP110.dll import never reaches a module
 * named "msvcp110". These are merged into msvcp90's own descriptor (api-registry.ts) and
 * handler map (emulator.worker.ts) rather than registered as a separate, unreachable module.
 */
export const vc110CppExtras: FunctionDescriptor[] = [
        method("?_Add_vtordisp2@?$basic_ostream@DU?$char_traits@D@std@@@std@@UAEXXZ", 0, { returnType: "void" }),
        method("??1?$basic_ostream@DU?$char_traits@D@std@@@std@@UAE@XZ", 0, { returnType: "void" }),
        method("?_Add_vtordisp1@?$basic_ios@DU?$char_traits@D@std@@@std@@UAEXXZ", 0, { returnType: "void" }),
        method("??1?$basic_ios@DU?$char_traits@D@std@@@std@@UAE@XZ", 0, { returnType: "void" }),
        method("?xsputn@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAE_JPBD_J@Z", 3),
        method("?xsgetn@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAE_JPAD_J@Z", 3),
        method("?showmanyc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAE_JXZ", 0),
        method("??1?$basic_streambuf@DU?$char_traits@D@std@@@std@@UAE@XZ", 0, { returnType: "void" }),
        method("?always_noconv@codecvt_base@std@@QBE_NXZ", 0),
        method("?in@?$codecvt@DDH@std@@QBEHAAHPBD1AAPBDPAD3AAPAD@Z", 7),
        method("?out@?$codecvt@DDH@std@@QBEHAAHPBD1AAPBDPAD3AAPAD@Z", 7),
        method("?_Gninc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEPADXZ", 0),
        method("?_Pninc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEPADXZ", 0),
        method("?clear@?$basic_ios@DU?$char_traits@D@std@@@std@@QAEXH_N@Z", 2, { returnType: "void" }),
        method("??0?$basic_ios@DU?$char_traits@D@std@@@std@@IAE@XZ", 0),
        method("??0?$basic_ostream@DU?$char_traits@D@std@@@std@@QAE@PAV?$basic_streambuf@DU?$char_traits@D@std@@@1@_N@Z", 2),
        method("?unshift@?$codecvt@DDH@std@@QBEHAAHPAD1AAPAD@Z", 4),
        method("??0?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAE@XZ", 0),
        method("?getloc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@QBE?AVlocale@2@XZ", 0),
        method("?setg@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEXPAD00@Z", 3, { returnType: "void" }),
        method("?_Init@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEXXZ", 0, { returnType: "void" }),
        method("?_Getcat@?$codecvt@DDH@std@@SAIPAPBVfacet@locale@2@PBV42@@Z", 2),
        method("?tolower@?$ctype@D@std@@QBEDD@Z", 1),
        method("?tolower@?$ctype@D@std@@QBEPBDPADPBD@Z", 3),
        method("?setstate@?$basic_ios@DU?$char_traits@D@std@@@std@@QAEXH_N@Z", 2, { returnType: "void" }),
        method("?_Getcoll@_Locinfo@std@@QBE?AU_Collvec@@XZ", 0),
        free("_Strcoll", 5),
        method("??Bid@locale@std@@QAEIXZ", 0),
        free("?_Getgloballocale@locale@std@@CAPAV_Locimp@12@XZ", 0),
        method("??0facet@locale@std@@IAE@I@Z", 1),
        method("??1facet@locale@std@@MAE@XZ", 0, { returnType: "void" }),
        method("??0_Lockit@std@@QAE@H@Z", 1),
        method("??0_Locinfo@std@@QAE@PBD@Z", 1),
        method("??1_Lockit@std@@QAE@XZ", 0, { returnType: "void" }),
        method("??1_Locinfo@std@@QAE@XZ", 0, { returnType: "void" }),
        method("?_Getcat@?$ctype@D@std@@SAIPAPBVfacet@locale@2@PBV42@@Z", 2),
        method("?_Incref@facet@locale@std@@UAEXXZ", 0, { returnType: "void" }),
        free("_Strxfrm", 5),
        free("?_Init@locale@std@@CAPAV_Locimp@12@_N@Z", 1),
        free("?_Xregex_error@std@@YAXW4error_type@regex_constants@1@@Z", 1, { returnType: "void" }),
        method("?_Decref@facet@locale@std@@UAEPAV_Facet_base@3@XZ", 0),
        method("??1_Facet_base@std@@UAE@XZ", 0, { returnType: "void" }),
        free("?_Xlength_error@std@@YAXPBD@Z", 1, { returnType: "void" }),
        free("?_Xout_of_range@std@@YAXPBD@Z", 1, { returnType: "void" }),
        free("?_Xbad_alloc@std@@YAXXZ", 0, { returnType: "void" }),
        free("?_Syserror_map@std@@YAPBDH@Z", 1),
        free("?_Winerror_map@std@@YAPBDH@Z", 1),

    // DATA exports (locale facet ids/vtables + _BADOFF) are registered via
    // thunkGenerator.registerDataExport in msvcp110.ts, not declared here — see
    // crt-isDataExport handling in pe-loader.ts (checked ahead of these functions).
];
