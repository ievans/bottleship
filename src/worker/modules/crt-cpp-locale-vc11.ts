/**
 * MSVCP110's classic ("C") locale, as real guest objects. std::locale's default
 * constructor, use_facet and the facets' inline members are compiled INTO the importing
 * image, so a NULL or zeroed answer from the DLL side crashes in the game's own code.
 * std::regex is the usual first caller: its traits constructor builds a locale and takes
 * the ctype<char> and collate<char> facets from it.
 *
 * The importer reads these layouts directly, so they are MSVC's (VC++ 2012):
 *   _Locimp      +0 vtable, +4 refs, +8 _Facetvec, +0xc _Facetcount, +0x10 _Catmask,
 *                +0x14 _Xparent, +0x18 _Name._Myptr, +0x1c _Name._Nul
 *   ctype<char>  +0 vtable, +4 refs, +8 _Page, +0xc _Table (256 classic masks),
 *                +0x10 _Delfl, +0x14 _LocaleName
 * rise.exe's inlined use_facet reads _Facetvec/_Facetcount/_Xparent, and its inlined
 * ctype<char>::is reads _Table.
 *
 * The locale's facet vector is empty, so use_facet always falls through to the facet's
 * _Getcat. That hands out one shared facet per type; the importer caches it. Every object
 * here is immortal: _Decref never reports the last reference, so nothing is deleted.
 *
 * Vtable slot order: _Facet_base's dtor, _Incref, _Decref, then the facet's virtuals with
 * each overload pair range-form first, as read off Wine's msvcp110 build.
 */
import type { Process } from "../core/process";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import type { InterfaceDescriptor, ModuleDescriptor } from "../api/types";
import { createVTablesFromDescriptor, type VTableInfo } from "../api/adapters/module-adapter";
import { Mem } from "../core/memory/mem-accessor";
import { classicCtypeFlags } from "./crt-ctype";

/** Returned by _Getcat: ctype and codecvt both belong to LC_CTYPE (_X_CTYPE). */
const CATEGORY_CTYPE = 2;
/** codecvt_base::noconv — char→char needs no conversion. */
const NOCONV = 3;
/** _Catmask for "all categories" (_M_ALL). */
const ALL_CATEGORIES = 0x3f;

type Method = readonly [name: string, stackArgs: number];

const FACET_BASE: readonly Method[] = [["dtor", 1], ["Incref", 0], ["Decref", 0]];
const INTERFACES: Record<string, readonly Method[]> = {
    Vc11Locimp: FACET_BASE,
    Vc11CtypeChar: [
        ...FACET_BASE,
        ["do_tolower_range", 2], ["do_tolower", 1],
        ["do_toupper_range", 2], ["do_toupper", 1],
        ["do_widen_range", 3], ["do_widen", 1],
        ["do_narrow_range", 4], ["do_narrow", 2],
    ],
    Vc11CodecvtChar: [
        ...FACET_BASE,
        ["do_always_noconv", 0], ["do_max_length", 0], ["do_encoding", 0],
        ["do_in", 7], ["do_out", 7], ["do_unshift", 4], ["do_length", 4],
    ],
};

function descriptor(moduleName: string): ModuleDescriptor {
    const interfaces: InterfaceDescriptor[] = Object.entries(INTERFACES).map(([name, methods]) => ({
        name,
        methods: methods.map(([method, stackArgs]) => ({
            name: method,
            params: Array.from({ length: stackArgs }, (_, i) => ({ name: `arg${i}`, type: "u32" as const })),
            returnType: "u32" as const,
            // thiscall: ECX carries `this`; the callee pops the stack arguments.
            callingConvention: "stdcall" as const,
        })),
    }));
    return { name: moduleName, functions: [], interfaces };
}

const rangeLength = (first: number, last: number, name: string): number => {
    if ((last >>> 0) < (first >>> 0)) throw new Error(`msvcp110:${name}: reversed byte range`);
    return (last >>> 0) - (first >>> 0);
};

function bytes(address: number, length: number, name: string): Uint8Array {
    const data = Mem.readBytes(address, length);
    if (!data) throw new Error(`msvcp110:${name}: unreadable range 0x${(address >>> 0).toString(16)}+${length}`);
    return data;
}

const lower = (ch: number): number => (ch >= 0x41 && ch <= 0x5a ? ch + 0x20 : ch);
const upper = (ch: number): number => (ch >= 0x61 && ch <= 0x7a ? ch - 0x20 : ch);

function mapRange(first: number, last: number, f: (ch: number) => number, name: string): number {
    const length = rangeLength(first, last, name);
    if (length) Mem.writeBytes(first, bytes(first, length, name).map(f));
    return last;
}

function copyRange(first: number, last: number, dest: number, name: string): number {
    const length = rangeLength(first, last, name);
    if (length) Mem.writeBytes(dest, new Uint8Array(bytes(first, length, name)));
    return last;
}

/** The C locale compares and transforms bytes as they are; any other locale is not implemented. */
function requireCCollvec(vector: number, name: string): void {
    if (!vector) return;
    const page = Mem.readUint32(vector) ?? 0, localeName = Mem.readUint32(vector + 4) ?? 0;
    if (page !== 0 || localeName !== 0) {
        throw new Error(`msvcp110:${name}: non-C locale is not implemented (page=${page}, name=0x${localeName.toString(16)})`);
    }
}

export class Vc11ClassicLocale {
    private vtables: Record<string, VTableInfo> | null = null;
    private locimp = 0;
    private ctype = 0;
    private codecvt = 0;
    private nextFacetId = 0;

    /** `moduleName` is the dispatcher name the vtable thunks resolve their handlers under. */
    constructor(private readonly process: () => Process | null, private readonly moduleName: string) {}

    register(exports: Record<string, ThunkImplementation>): void {
        // static locale::_Locimp* locale::_Init(bool) / _Getgloballocale(): the classic locale.
        exports["?_Init@locale@std@@CAPAV_Locimp@12@_N@Z"] = () => this.classicLocimp();
        exports["?_Getgloballocale@locale@std@@CAPAV_Locimp@12@XZ"] = () => this.classicLocimp();

        // locale::id::operator size_t(): number the facet type on first use (ECX = &id).
        exports["??Bid@locale@std@@QAEIXZ"] = (ctx) => {
            const id = ctx.ecx >>> 0;
            let value = Mem.readUint32(id) ?? 0;
            if (value === 0) {
                value = ++this.nextFacetId;
                Mem.writeUint32(id, value);
            }
            return value;
        };

        // static size_t _Getcat(const facet** ppf, const locale* ploc): construct the facet
        // into *ppf when the caller has none cached.
        exports["?_Getcat@?$ctype@D@std@@SAIPAPBVfacet@locale@2@PBV42@@Z"] = (_ctx, _mem, args) =>
            this.getcat(args[0] ?? 0, () => this.ctypeFacet());
        exports["?_Getcat@?$codecvt@DDH@std@@SAIPAPBVfacet@locale@2@PBV42@@Z"] = (_ctx, _mem, args) =>
            this.getcat(args[0] ?? 0, () => this.codecvtFacet());

        // _Collvec _Locinfo::_Getcoll() const: an instance method, so the 8-byte struct comes
        // back through a hidden result pointer (rise.exe+0x437173 pushes it and reads [eax]).
        exports["?_Getcoll@_Locinfo@std@@QBE?AU_Collvec@@XZ"] = (_ctx, _mem, args) => {
            const result = args[0] ?? 0;
            Mem.writeUint32(result, 0);     // _Page: C locale
            Mem.writeUint32(result + 4, 0); // _LocaleName: none
            return result;
        };
        exports["_Strcoll"] = (_ctx, _mem, args) => {
            requireCCollvec(args[4] ?? 0, "_Strcoll");
            const leftLength = rangeLength(args[0]!, args[1]!, "_Strcoll");
            const rightLength = rangeLength(args[2]!, args[3]!, "_Strcoll");
            const left = bytes(args[0]!, leftLength, "_Strcoll");
            const right = bytes(args[2]!, rightLength, "_Strcoll");
            for (let i = 0, end = Math.min(leftLength, rightLength); i < end; i++) {
                if (left[i] !== right[i]) return left[i]! - right[i]!;
            }
            return leftLength < rightLength ? -1 : leftLength > rightLength ? 1 : 0;
        };
        // Returns the transformed length; the caller grows its buffer and retries when that
        // exceeds the room it gave.
        exports["_Strxfrm"] = (_ctx, _mem, args) => {
            requireCCollvec(args[4] ?? 0, "_Strxfrm");
            const capacity = rangeLength(args[0]!, args[1]!, "_Strxfrm");
            const length = rangeLength(args[2]!, args[3]!, "_Strxfrm");
            if (length > 0 && length <= capacity) copyRange(args[2]!, args[3]!, args[0]!, "_Strxfrm");
            return length;
        };

        this.registerVirtuals(exports);
    }

    private registerVirtuals(exports: Record<string, ThunkImplementation>): void {
        const facetBase = (iface: string): void => {
            exports[`${iface}_dtor`] = (ctx) => ctx.ecx >>> 0;
            exports[`${iface}_Incref`] = () => 0;
            exports[`${iface}_Decref`] = () => 0; // never the last reference: nothing is deleted
        };
        for (const iface of Object.keys(INTERFACES)) facetBase(iface);

        const ct = "Vc11CtypeChar";
        exports[`${ct}_do_tolower_range`] = (_ctx, _mem, a) => mapRange(a[0]!, a[1]!, lower, "do_tolower");
        exports[`${ct}_do_tolower`] = (_ctx, _mem, a) => lower(a[0]! & 0xff);
        exports[`${ct}_do_toupper_range`] = (_ctx, _mem, a) => mapRange(a[0]!, a[1]!, upper, "do_toupper");
        exports[`${ct}_do_toupper`] = (_ctx, _mem, a) => upper(a[0]! & 0xff);
        exports[`${ct}_do_widen_range`] = (_ctx, _mem, a) => copyRange(a[0]!, a[1]!, a[2]!, "do_widen");
        exports[`${ct}_do_widen`] = (_ctx, _mem, a) => a[0]! & 0xff;
        exports[`${ct}_do_narrow_range`] = (_ctx, _mem, a) => copyRange(a[0]!, a[1]!, a[3]!, "do_narrow");
        exports[`${ct}_do_narrow`] = (_ctx, _mem, a) => a[0]! & 0xff;

        const cv = "Vc11CodecvtChar";
        exports[`${cv}_do_always_noconv`] = () => 1;
        exports[`${cv}_do_max_length`] = () => 1;
        exports[`${cv}_do_encoding`] = () => 1;
        exports[`${cv}_do_in`] = () => NOCONV;
        exports[`${cv}_do_out`] = () => NOCONV;
        exports[`${cv}_do_unshift`] = () => NOCONV;
        // do_length(state&, first, last, count): bytes that convert to at most `count` chars.
        exports[`${cv}_do_length`] = (_ctx, _mem, a) =>
            Math.min(rangeLength(a[1]!, a[2]!, "do_length"), a[3]! >>> 0);
    }

    private getcat(ppf: number, make: () => number): number {
        if (ppf && (Mem.readUint32(ppf) ?? 0) === 0) Mem.writeUint32(ppf, make());
        return CATEGORY_CTYPE;
    }

    private vtable(iface: string): number {
        const process = this.process();
        if (!process) throw new Error("msvcp110: locale objects need a process");
        this.vtables ??= createVTablesFromDescriptor(process, descriptor(this.moduleName));
        return this.vtables[iface]!.address;
    }

    private object(size: number, iface: string): number {
        const process = this.process();
        if (!process) throw new Error("msvcp110: locale objects need a process");
        const addr = process.memory.alloc(size, "THUNK_DATA", "rw");
        Mem.writeBytes(addr, new Uint8Array(size));
        Mem.writeUint32(addr, this.vtable(iface));
        Mem.writeUint32(addr + 4, 1); // refs
        return addr;
    }

    private classicLocimp(): number {
        if (this.locimp) return this.locimp;
        const locimp = this.object(0x20, "Vc11Locimp");
        const name = this.process()!.memory.alloc(2, "THUNK_DATA", "rw");
        Mem.writeBytes(name, new Uint8Array([0x43, 0])); // "C"
        Mem.writeUint32(locimp + 0x10, ALL_CATEGORIES);
        Mem.writeUint32(locimp + 0x18, name);
        return (this.locimp = locimp);
    }

    private ctypeFacet(): number {
        if (this.ctype) return this.ctype;
        const table = this.process()!.memory.alloc(512, "THUNK_DATA", "rw");
        const masks = new Uint8Array(512);
        const view = new DataView(masks.buffer);
        for (let ch = 0; ch < 256; ch++) view.setUint16(ch * 2, classicCtypeFlags(ch), true);
        Mem.writeBytes(table, masks);
        const ctype = this.object(0x18, "Vc11CtypeChar");
        Mem.writeUint32(ctype + 0xc, table);
        return (this.ctype = ctype);
    }

    private codecvtFacet(): number {
        return (this.codecvt ||= this.object(0x10, "Vc11CodecvtChar"));
    }

    /** A thunk-generator reset frees the vtables; objects already handed out keep their bytes. */
    reset(): void {
        this.vtables = null;
        this.locimp = this.ctype = this.codecvt = 0;
        this.nextFacetId = 0;
    }
}
