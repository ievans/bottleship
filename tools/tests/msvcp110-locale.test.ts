import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { vc110CppExtras } from "../../src/worker/api/msvcp110.api";
import { Msvcp110 } from "../../src/worker/modules/msvcp110";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const INIT = "?_Init@locale@std@@CAPAV_Locimp@12@_N@Z";
const GLOBAL = "?_Getgloballocale@locale@std@@CAPAV_Locimp@12@XZ";
const ID = "??Bid@locale@std@@QAEIXZ";
const GETCAT_CTYPE = "?_Getcat@?$ctype@D@std@@SAIPAPBVfacet@locale@2@PBV42@@Z";
const GETCAT_CODECVT = "?_Getcat@?$codecvt@DDH@std@@SAIPAPBVfacet@locale@2@PBV42@@Z";
const GETCOLL = "?_Getcoll@_Locinfo@std@@QBE?AU_Collvec@@XZ";

describe("msvcp110 classic locale", () => {
    let mem: Uint8Array;
    let module: Msvcp110;
    let originalProcess: unknown;
    const call = (name: string, args: number[] = [], ecx = 0) =>
        module.exports[name]!({ ecx } as any, mem, args) as number;
    const u32 = (addr: number) => Mem.readUint32(addr)!;
    const cString = (addr: number) => {
        let s = "";
        for (let c = Mem.readUint8(addr)!; c; c = Mem.readUint8(++addr)!) s += String.fromCharCode(c);
        return s;
    };

    beforeEach(() => {
        const system = System.getInstance() as any;
        originalProcess = system.process;
        mem = new Uint8Array(0x100000);
        let next = 0x1000;
        const thunkGenerator = new ThunkGenerator();
        thunkGenerator.setBaseAddress(0x80000);
        const alloc = (size: number) => { const ptr = next; next += (Math.max(4, size) + 15) & ~15; return ptr; };
        system.process = {
            memory: { alloc, allocAt: () => undefined, allocSystemBlock: alloc, free: () => undefined, freeSystemBlock: () => {} },
            dispatcher: { registerModule: () => undefined, applyPendingRegistrations: () => undefined },
            thunkGenerator,
            getCurrentMemory: () => mem,
        };
        Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
        module = new Msvcp110();
        module.initialize(system.process);
    });
    afterEach(() => { (System.getInstance() as any).process = originalProcess; });

    test("locale::_Init hands back a real _Locimp: empty facet vector, no parent, named \"C\"", () => {
        const locimp = call(INIT, [1]);
        expect(locimp).not.toBe(0);
        expect(u32(locimp)).not.toBe(0);           // vtable: _Incref is called through slot 1
        expect(u32(locimp + 0x0c)).toBe(0);        // _Facetcount: use_facet falls through to _Getcat
        expect(Mem.readUint8(locimp + 0x14)).toBe(0); // _Xparent
        expect(cString(u32(locimp + 0x18))).toBe("C");
        expect(call(GLOBAL)).toBe(locimp);
    });

    test("_Getcat builds ctype<char> once, with the classic table where is() reads it", () => {
        const ppf = 0x9000;
        expect(call(GETCAT_CTYPE, [ppf, 0])).not.toBe(0xffffffff);
        const facet = u32(ppf);
        expect(facet).not.toBe(0);
        const table = u32(facet + 0x0c);
        const mask = (ch: number) => Mem.readUint16(table + ch * 2);
        expect(mask(0x41)).toBe(0x181); // 'A': upper | hex | alpha
        expect(mask(0x7a)).toBe(0x102); // 'z': lower | alpha
        expect(mask(0x35)).toBe(0x84);  // '5': digit | hex
        expect(mask(0x5f)).toBe(0x10);  // '_': punct
        expect(mask(0x20)).toBe(0x48);  // ' ': space | blank

        const cached = 0x9010;
        Mem.writeUint32(cached, 0x1234);
        call(GETCAT_CTYPE, [cached, 0]);
        expect(u32(cached)).toBe(0x1234); // a facet the caller already holds is left alone
    });

    test("_Getcat builds a codecvt<char,char,int> facet too", () => {
        call(GETCAT_CODECVT, [0x9000, 0]);
        expect(u32(0x9000)).not.toBe(0);
        expect(u32(u32(0x9000))).not.toBe(0);
    });

    test("locale::id numbers each facet type once", () => {
        const a = 0xa000, b = 0xa004;
        const first = call(ID, [], a);
        expect(first).not.toBe(0);
        expect(call(ID, [], a)).toBe(first);
        expect(call(ID, [], b)).not.toBe(first);
    });

    test("ctype<char> virtuals convert in place and pass bytes through", () => {
        Mem.writeBytes(0xb000, new TextEncoder().encode("MiXeD_9"));
        expect(call("Vc11CtypeChar_do_tolower_range", [0xb000, 0xb007])).toBe(0xb007);
        expect(cString(0xb000)).toBe("mixed_9");
        expect(call("Vc11CtypeChar_do_toupper", [0x71])).toBe(0x51);
        expect(call("Vc11CtypeChar_do_narrow", [0x41, 0x3f])).toBe(0x41);
    });

    test("ranged widen and narrow copy to dest and return the end of dest", () => {
        Mem.writeBytes(0xb100, new TextEncoder().encode("abc"));
        expect(call("Vc11CtypeChar_do_widen_range", [0xb100, 0xb103, 0xb200])).toBe(0xb203);
        expect(cString(0xb200)).toBe("abc");
        expect(call("Vc11CtypeChar_do_narrow_range", [0xb100, 0xb103, 0x3f, 0xb300])).toBe(0xb303);
        expect(cString(0xb300)).toBe("abc");
    });

    test("_Getcoll returns the C collation vector through its hidden result pointer", () => {
        expect(vc110CppExtras.find((f) => f.name === GETCOLL)?.stackCleanupBytes).toBe(4);
        Mem.writeUint32(0xc000, 0xdead);
        Mem.writeUint32(0xc004, 0xbeef);
        expect(call(GETCOLL, [0xc000], 0xc100)).toBe(0xc000);
        expect(u32(0xc000)).toBe(0);
        expect(u32(0xc004)).toBe(0);
    });

    test("_Strcoll compares bytes; _Strxfrm copies when there is room and reports the length", () => {
        const enc = new TextEncoder();
        Mem.writeBytes(0xd000, enc.encode("abc"));
        Mem.writeBytes(0xd010, enc.encode("abd"));
        expect(call("_Strcoll", [0xd000, 0xd003, 0xd010, 0xd013, 0])).toBeLessThan(0);
        expect(call("_Strcoll", [0xd000, 0xd003, 0xd000, 0xd003, 0])).toBe(0);
        expect(call("_Strcoll", [0xd000, 0xd003, 0xd000, 0xd002, 0])).toBe(1);

        expect(call("_Strxfrm", [0xd100, 0xd101, 0xd000, 0xd003, 0])).toBe(3); // too small: length only
        expect(Mem.readUint8(0xd100)).toBe(0);
        expect(call("_Strxfrm", [0xd100, 0xd110, 0xd000, 0xd003, 0])).toBe(3);
        expect(cString(0xd100)).toBe("abc");
    });
});
