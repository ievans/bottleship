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
 *   - locale facet IDs (`id@...`): DATA exports, not functions — the importer dereferences
 *     the address (see msvcp90.ts's ymath constants for the same shape). Each gets its own
 *     small zeroed cell; the actual value only has to be stable and unique, never a
 *     specific number.
 *   - the classic locale itself (locale::_Init, use_facet's _Getcat, locale::id, collation):
 *     real objects, because the importer inlines the code that reads them — see
 *     crt-cpp-locale-vc11.ts.
 *   - facet/_Facet_base VFTABLES (`??_7...@6B@`): real one-slot vtables pointing at a
 *     shared `ret` stub — both classes declare exactly one virtual (the destructor), and a
 *     zeroed data cell here would make a virtual call jump through NULL.
 *
 * All data exports (facet ids, vtables, _BADOFF) are registered under the CANONICAL
 * "msvcp90" name: MSVCP_VERSIONED (dll-aliases.ts) canonicalizes every msvcp70/71/80/100/
 * 110/120 import to "msvcp90" before anything looks for a data export by name, so
 * registering under "msvcp110" is simply unreachable — same bug class as msvcr110's
 * _fmode/_commode (see msvcr110.ts).
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { Vc11ClassicLocale } from "./crt-cpp-locale-vc11";

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
    // 7-param codecvt::out (matches msvcp110.api.ts's declared arity exactly — in/out are
    // the same shape, 7 stack dwords). A shorter, 4-param mangled name here previously left
    // the DECLARED export unimplemented: the loader bound the real import to this handler
    // table by exact decorated name, and the two tables disagreed.
    "?out@?$codecvt@DDH@std@@QBEHAAHPBD1AAPBDPAD3AAPAD@Z",
    "?unshift@?$codecvt@DDH@std@@QBEHAAHPAD1AAPAD@Z",
    "?_Gninc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEPADXZ",
    "?_Pninc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@IAEPADXZ",
    "?_Fiopen@std@@YAPAU_iobuf@@PBDHH@Z", // NULL: "could not open" — never a lie about success
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
    // PBDPADPBD@Z decodes as `const char* tolower(char* first, const char* last) const` —
    // TWO stack params (first, last), not three. It's the IN-PLACE range overload: it
    // lowercases [first, last) through `first` itself and returns `last`, with no separate
    // destination pointer.
    exports["?tolower@?$ctype@D@std@@QBEPBDPADPBD@Z"] = (_ctx, _mem, args) => {
        const [first, last] = args;
        const end = last ?? 0;
        for (let p = first ?? 0; p < end; p++) {
            const ch = Mem.readUint8(p) ?? 0;
            if (ch >= 0x41 && ch <= 0x5a) Mem.writeUint8(p, ch + 0x20);
        }
        return last ?? 0;
    };
}

/** Locale facet IDs are DATA, not code — see the file header. */
const DATA_EXPORT_NAMES = [
    "?id@?$codecvt@DDH@std@@2V0locale@2@A",
    "?id@?$collate@D@std@@2V0locale@2@A",
    "?id@?$ctype@D@std@@2V0locale@2@A",
] as const;

/** facet/_Facet_base vftables — each is a single [deleting-dtor] slot, see the file header. */
const VTABLE_NAMES = [
    "??_7facet@locale@std@@6B@",
    "??_7_Facet_base@std@@6B@",
] as const;

export class Msvcp110 implements IModule {
    name = "msvcp110";
    exports: Record<string, ThunkImplementation> = {};

    private dataAddrs: Map<string, number> = new Map();
    private vtableStubAddr = 0;
    private badoffAddr = 0;
    private process: Process | null = null;
    // Vtable thunks dispatch under "msvcp90": these exports are merged into that module's.
    private readonly locale = new Vc11ClassicLocale(() => this.process, "msvcp90");

    initialize(process: Process): void {
        this.process = process;
        const exports = this.exports;

        for (const n of CTOR_DTOR_NAMES) exports[n] = RETURN_THIS;
        for (const n of VOID_NOOP_NAMES) exports[n] = NOOP_VOID;
        for (const n of ZERO_RETURN_NAMES) exports[n] = RETURN_ZERO;
        registerTolower(exports);
        this.locale.register(exports);

        // basic_streambuf::getloc() returns a `locale` BY VALUE. The x86 MSVC ABI passes
        // that as a hidden pointer — the caller-allocated return slot — as the method's
        // first STACK argument (ECX stays `this`); the callee writes the object there and
        // returns that same pointer in EAX. locale's only data member is a _Locimp*, which
        // a zeroed/trivial value matches, same as every other facet here.
        exports["?getloc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@QBE?AVlocale@2@XZ"] = (_ctx, _mem, args) => {
            const retBuf = args[0] ?? 0;
            if (retBuf) Mem.writeUint32(retBuf, 0);
            return retBuf;
        };

        this.registerDataExports(process);
    }

    /**
     * Allocate once, but REGISTER every time: a thunk-generator reset clears the data
     * export table while the bytes stay where they are (same rule msvcp90.ts's ymath
     * constants follow) — an "already allocated" early return would leave every name here
     * unbound after the first reset. Called again from reregisterExports, which requires
     * this instance to be in process.modules (see emulator.worker.ts).
     */
    private registerDataExports(process: Process): void {
        const tg = process.thunkGenerator;
        if (!tg?.registerDataExport) return;

        for (const name of DATA_EXPORT_NAMES) {
            let addr = this.dataAddrs.get(name) ?? 0;
            if (addr === 0) {
                addr = process.memory.alloc(4, "THUNK_DATA", "rw");
                Mem.writeUint32(addr, 0);
                this.dataAddrs.set(name, addr);
            }
            tg.registerDataExport("msvcp90", name, addr);
        }

        if (this.vtableStubAddr === 0) {
            this.vtableStubAddr = process.memory.alloc(1, "THUNK_CODE", "rx");
            Mem.writeBytes(this.vtableStubAddr, new Uint8Array([0xc3])); // ret
        }
        for (const name of VTABLE_NAMES) {
            let addr = this.dataAddrs.get(name) ?? 0;
            if (addr === 0) {
                addr = process.memory.alloc(4, "THUNK_DATA", "rw");
                this.dataAddrs.set(name, addr);
            }
            Mem.writeUint32(addr, this.vtableStubAddr);
            tg.registerDataExport("msvcp90", name, addr);
        }

        // std::_BADOFF — static const streamoff(-1), 8 bytes.
        if (this.badoffAddr === 0) this.badoffAddr = process.memory.alloc(8, "THUNK_DATA", "rw");
        Mem.writeUint32(this.badoffAddr, 0xffffffff);
        Mem.writeUint32(this.badoffAddr + 4, 0xffffffff);
        tg.registerDataExport("msvcp90", "?_BADOFF@std@@3_JB", this.badoffAddr);
    }

    /** Invoked by system.ts's reset loop for every process.registerModule'd instance. */
    reregisterExports(process: Process): void {
        this.process = process;
        this.locale.reset();
        this.registerDataExports(process);
    }
}
