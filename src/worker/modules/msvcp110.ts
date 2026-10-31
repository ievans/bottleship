/**
 * MSVCP110 — the VC++ 2012 C++ standard library. rise.exe (Rise of Nations' Steam v1.10
 * branch) links this by NAME alongside MSVCR110; a missing export fails the whole image's
 * import bind (see crt-vc8.ts, msvcr110.ts).
 *
 * Every import here is iostream/locale machinery (basic_ios/basic_ostream/basic_streambuf,
 * codecvt, ctype, collate, locale::facet refcounting) — the std::cerr/clog diagnostic path
 * a lot of 2010s titles build in and rarely exercise in normal play. There is no existing
 * HLE iostream implementation to build on (unlike msvcr110's libc functions, which reuse
 * Msvcrt), so this gives each entry point the SAFEST behavior for its shape rather than a
 * faithful reimplementation of MSVC's STL internals:
 *   - constructors/destructors: no-ops returning `this` (ECX) — guest memory starts
 *     zeroed, which already matches a trivial facet/streambuf's initial state.
 *   - the `_X*` throw-helpers (_Xout_of_range etc.): return instead of throwing. Only
 *     reachable on a genuine error path (bad_alloc, out_of_range) a working boot never
 *     takes; returning is safer than an under-specified throw with no real SEH frame to
 *     unwind into.
 *   - locale facet IDs and vtables (`id@...`, `??_7...@6B@`): DATA exports, not functions
 *     — the importer dereferences the address (see msvcp90.ts's ymath constants for the
 *     same shape). Each gets its own small zeroed cell; the actual value only has to be
 *     stable and unique, never a specific number.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";

/** `this` (ECX, __thiscall) is both ctor/dtor return value and the identity of trivial facets. */
const RETURN_THIS: ThunkImplementation = (ctx) => ctx.ecx >>> 0;
const NOOP_VOID: ThunkImplementation = () => 0;
const RETURN_ZERO: ThunkImplementation = () => 0;

const CTOR_DTOR_NAMES = [
    "?_Add_vtordisp2@?$basic_ostream@DU?$char_traits@D@std@@@std@@UAEXXZ",
    "??1?$basic_ostream@DU?$char_traits@D@std@@@std@@UAE@XZ",
    "?_Add_vtordisp1@?$basic_ios@DU?$char_traits@D@std@@@std@@UAEXXZ",
    "??1?$basic_ios@DU?$char_traits@D@std@@@std@@UAE@XZ",
    "??1?$basic_streambuf@DU?$char_traits@D@std@@@std@@UAE@XZ",
    "??0?$basic_ios@DU?$char_traits@D@std@@@std@@IAE@XZ",
    "??0?$basic_ostream@DU?$char_traits@D@std@@@std@@QAE@PAV?$basic_streambuf@DU?$char_traits@D@std@@@1@_N@Z",
    "??0?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAE@XZ",
    "??0facet@locale@std@@IAE@I@Z",
    "??1facet@locale@std@@MAE@XZ",
    "??0_Lockit@std@@QAE@H@Z",
    "??0_Locinfo@std@@QAE@PBD@Z",
    "??1_Lockit@std@@QAE@XZ",
    "??1_Locinfo@std@@QAE@XZ",
    "??1_Facet_base@std@@UAE@XZ",
] as const;

const VOID_NOOP_NAMES = [
    "?clear@?$basic_ios@DU?$char_traits@D@std@@@std@@QAEXH_N@Z",
    "?setg@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEXPAD00@Z",
    "?_Init@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEXXZ",
    "?setstate@?$basic_ios@DU?$char_traits@D@std@@@std@@QAEXH_N@Z",
    "?_Incref@facet@locale@std@@UAEXXZ",
    // noreturn in the real CRT (throws); returning is the safe choice with no SEH frame
    // to unwind into — see file header.
    "?_Xregex_error@std@@YAXW4error_type@regex_constants@1@@Z",
    "?_Xlength_error@std@@YAXPBD@Z",
    "?_Xout_of_range@std@@YAXPBD@Z",
    "?_Xbad_alloc@std@@YAXXZ",
] as const;

/** Zero/false/null answers for everything that returns a value but has no real backing state. */
const ZERO_RETURN_NAMES = [
    "?xsputn@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAE_JPBD_J@Z",
    "?xsgetn@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAE_JPAD_J@Z",
    "?showmanyc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAE_JXZ",
    "?always_noconv@codecvt_base@std@@QBE_NXZ",
    "?in@?$codecvt@DDH@std@@QBEHAAHPBD1AAPBDPAD3AAPAD@Z",
    "?out@?$codecvt@DDH@std@@QBEHAAHPAD1AAPAD@Z",
    "?unshift@?$codecvt@DDH@std@@QBEHAAHPAD1AAPAD@Z",
    "?_Gninc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEPADXZ",
    "?_Pninc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEPADXZ",
    "?getloc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@QBE?AVlocale@2@XZ",
    "?_Getcat@?$codecvt@DDH@std@@SAIPAPBVfacet@locale@2@PBV42@@Z",
    "?_Fiopen@std@@YAPAU_iobuf@@PBDHH@Z", // NULL: "could not open" — never a lie about success
    "?_Getcoll@_Locinfo@std@@QBE?AU_Collvec@@XZ",
    "_Strcoll",
    "??Bid@locale@std@@QAEIXZ",
    "?_Getgloballocale@locale@std@@CAPAV_Locimp@12@XZ",
    "?_Getcat@?$ctype@D@std@@SAIPAPBVfacet@locale@2@PBV42@@Z",
    "_Strxfrm",
    "?_Init@locale@std@@CAPAV_Locimp@12@_N@Z",
    "?_Decref@facet@locale@std@@UAEPAV_Facet_base@3@XZ",
    "?_Syserror_map@std@@YAPBDH@Z",
    "?_Winerror_map@std@@YAPBDH@Z",
] as const;

/** `ctype<char>::tolower` — ASCII lowercasing is real behavior worth getting right. */
function registerTolower(exports: Record<string, ThunkImplementation>): void {
    // DD@Z: tolower(char ch) — thiscall, returns the char by value.
    exports["?tolower@?$ctype@D@std@@QBEDD@Z"] = (_ctx, _mem, args) => {
        const ch = (args[0] ?? 0) & 0xff;
        return ch >= 0x41 && ch <= 0x5a ? ch + 0x20 : ch;
    };
    // PBDPADPBD@Z: tolower(const char* first, char* dest, const char* last) range form —
    // real signature takes (dest, first, last) and returns last; thiscall args: dest, first, last.
    exports["?tolower@?$ctype@D@std@@QBEPBDPADPBD@Z"] = (_ctx, mem, args) => {
        const [dest, first, last] = args;
        let d = dest ?? 0;
        let s = first ?? 0;
        const end = last ?? 0;
        while (s < end) {
            const ch = mem[s] ?? 0;
            mem[d] = ch >= 0x41 && ch <= 0x5a ? ch + 0x20 : ch;
            s++; d++;
        }
        return last ?? 0;
    };
}

/** Locale facet IDs and vtables are DATA, not code — see the file header. */
const DATA_EXPORT_NAMES = [
    "?id@?$codecvt@DDH@std@@2V0locale@2@A",
    "?id@?$collate@D@std@@2V0locale@2@A",
    "?id@?$ctype@D@std@@2V0locale@2@A",
    "??_7facet@locale@std@@6B@",
    "??_7_Facet_base@std@@6B@",
] as const;

export class Msvcp110 implements IModule {
    name = "msvcp110";
    exports: Record<string, ThunkImplementation> = {};

    private dataAddrs: number[] = [];
    private badoffAddr = 0;

    initialize(process: Process): void {
        const exports = this.exports;

        for (const n of CTOR_DTOR_NAMES) exports[n] = RETURN_THIS;
        for (const n of VOID_NOOP_NAMES) exports[n] = NOOP_VOID;
        for (const n of ZERO_RETURN_NAMES) exports[n] = RETURN_ZERO;
        registerTolower(exports);

        const tg = process.thunkGenerator;
        if (tg?.registerDataExport) {
            for (const name of DATA_EXPORT_NAMES) {
                const addr = process.memory.alloc(4, "THUNK_DATA", "rw");
                Mem.writeUint32(addr, 0);
                tg.registerDataExport(this.name, name, addr);
                this.dataAddrs.push(addr);
            }
            // std::_BADOFF — static const streamoff(-1), 8 bytes.
            if (this.badoffAddr === 0) this.badoffAddr = process.memory.alloc(8, "THUNK_DATA", "rw");
            Mem.writeUint32(this.badoffAddr, 0xffffffff);
            Mem.writeUint32(this.badoffAddr + 4, 0xffffffff);
            tg.registerDataExport(this.name, "?_BADOFF@std@@3_JB", this.badoffAddr);
        }
    }
}
