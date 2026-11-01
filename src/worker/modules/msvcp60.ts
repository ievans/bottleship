/**
 * MSVCP60 — MSVC 6.0 C++ standard library (minimal std::basic_string<char> HLE).
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { Msvcrt } from "./msvcrt";
import { registerVc6LocaleExports } from "./crt-cpp-locale-vc6";
import { vc6ExceptionCtor, vc6ExceptionCopy, vc6ExceptionDtor, vc6ExceptionDelete, vc6ExceptionWhat } from "./crt-cpp-exception-vc6";
import { vc6WriteBytes, vc6WriteU32 } from "./crt-cpp-memory-vc6";
import { writeGuestCode } from "../core/memory/guest-code";
import { getCPU } from "../core/thunking/thunk-utils";
import { cpuViews } from "../core/cpu/cpu-views";
import {
    vc6StringAppendCharCount,
    vc6StringAppendCStrCount,
    vc6StringAppendRange,
    vc6StringAssignCStrCount,
    vc6StringAssignRange,
    vc6StringConcat,
    vc6StringConcatCStrLeft,
    vc6StringConcatCStrRight,
    vc6StringCopy,
    vc6StringCopyCtor,
    vc6StringCtorCStr,
    vc6StringCStr,
    vc6StringEquals,
    vc6StringEqualsCStr,
    vc6StringErase,
    vc6StringEos,
    vc6StringFind,
    vc6StringFindFirstOf,
    vc6StringFindLastOf,
    vc6StringGrow,
    vc6StringInsert,
    vc6StringLess,
    vc6StringSize,
    vc6StringSplit,
    vc6StringSubstr,
    vc6StringTidy,
    type CppStringHeap,
} from "./crt-cppstring-vc6";

const BS = "?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std";
const BS0 = "?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0";

export class Msvcp60 implements IModule {
    name = "msvcp60";
    exports: Record<string, ThunkImplementation> = {};

    private heap!: CppStringHeap;
    private msvcrt!: Msvcrt;
    private process!: Process;
    private nullstrAddr = 0;
    private nposAddr = 0;
    private refcntAddr = 0;
    private logicErrorVtableAddr = 0;
    private badCastVtableAddr = 0;
    private badAllocVtableAddr = 0;
    private exceptionVtableAddr = 0;
    private unknownExceptionAddr = 0;
    // std::cout / std::cerr: our own HLE operator<< overloads treat these purely as opaque
    // "this" pointers, but cout/cerr are REAL basic_ostream<char> objects in the guest's own
    // ABI — guest-compiled inline code (an operator void*()/good() check, say) can read their
    // vtable/state fields directly without ever calling one of our exported handlers. Wine's
    // msvcp60/msvcp.h (ios_base: vtable@0, state@4 IOSB_iostate, goodbit=0) gives a verified
    // layout for the non-virtual ios_base header; basic_ostream reaches it through a virtual
    // base whose exact offset within basic_ostream itself isn't verified here, so this is
    // NOT byte-exact ABI compatibility. STREAM_OBJ_SIZE is sized generously past the verified
    // 52-byte ios_base+basic_ios_char span so a stray read within the object hits zeroed
    // memory — state=0=goodbit at the verified offset 4 is also the CORRECT initial value for
    // a stream that hasn't failed — rather than unrelated heap, which is the concrete,
    // verifiable half of this fix; true virtual-base fidelity is unresolved follow-up work.
    private static readonly STREAM_OBJ_SIZE = 64;
    private coutAddr = 0;
    private cerrAddr = 0;
    // IEEE 754 special-value statics <limits>/<float.h> read directly: _Inf/_Snan (double,
    // 8 bytes), _FInf/_FSnan (float, 4 bytes). Bit patterns per IEEE 754: infinity is all
    // exponent bits set with a zero mantissa; a SIGNALING NaN sets the exponent too but
    // clears the mantissa's leading (quiet) bit while keeping the mantissa non-zero.
    private infAddr = 0;
    private snanAddr = 0;
    private finfAddr = 0;
    private fsnanAddr = 0;

    setMsvcrt(msvcrt: Msvcrt): void {
        this.msvcrt = msvcrt;
    }

    /** Default-construct a bare VC6 std::exception — shared with modules (msvcrt) whose own
     *  import table pulls this same mangled symbol from a different DLL. */
    defaultConstructException(object: number): number {
        return vc6ExceptionCtor(object, 0, this.exceptionVtableAddr, this.heap);
    }

    private ensureRuntimeStorage(process: Process): void {
        if (this.nullstrAddr === 0) {
            this.nullstrAddr = process.memory.alloc(1, "THUNK_DATA", "rw");
            Mem.writeBytes(this.nullstrAddr, new Uint8Array([0]));
        }
        if (this.nposAddr === 0) {
            this.nposAddr = process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.nposAddr, 0xffffffff);
        }
        // Shared "unshared" refcount cell for _Refcnt(_Ptr) — our basic_string never shares a
        // buffer across instances (every ctor/assign does a real copy), so it always reads 1.
        if (this.refcntAddr === 0) {
            this.refcntAddr = process.memory.alloc(2, "THUNK_DATA", "rw");
            Mem.writeUint16(this.refcntAddr, 1);
        }
        if (this.coutAddr === 0) {
            this.coutAddr = process.memory.alloc(Msvcp60.STREAM_OBJ_SIZE, "THUNK_DATA", "rw");
            Mem.writeBytes(this.coutAddr, new Uint8Array(Msvcp60.STREAM_OBJ_SIZE));
        }
        if (this.cerrAddr === 0) {
            this.cerrAddr = process.memory.alloc(Msvcp60.STREAM_OBJ_SIZE, "THUNK_DATA", "rw");
            Mem.writeBytes(this.cerrAddr, new Uint8Array(Msvcp60.STREAM_OBJ_SIZE));
        }
        if (this.infAddr === 0) {
            // IEEE 754 double +infinity: exponent all-ones, mantissa zero.
            this.infAddr = process.memory.alloc(8, "THUNK_DATA", "rw");
            Mem.writeUint32(this.infAddr, 0x00000000);
            Mem.writeUint32(this.infAddr + 4, 0x7ff00000);
        }
        if (this.snanAddr === 0) {
            // IEEE 754 double signaling NaN: exponent all-ones, mantissa nonzero with its
            // top ("quiet") bit clear.
            this.snanAddr = process.memory.alloc(8, "THUNK_DATA", "rw");
            Mem.writeUint32(this.snanAddr, 0x00000001);
            Mem.writeUint32(this.snanAddr + 4, 0x7ff00000);
        }
        if (this.finfAddr === 0) {
            this.finfAddr = process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.finfAddr, 0x7f800000);
        }
        if (this.fsnanAddr === 0) {
            this.fsnanAddr = process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.fsnanAddr, 0x7f800001);
        }
        if (this.logicErrorVtableAddr === 0) {
            const tg = process.thunkGenerator;
            const retStubAddr = process.memory.alloc(1, "THUNK_CODE", "rx");
            Mem.writeBytes(retStubAddr, new Uint8Array([0xc3]));

            const outOfRangeVtableAddr = process.memory.alloc(16, "THUNK_DATA", "rw");
            Mem.writeUint32(outOfRangeVtableAddr + 0, 0);
            Mem.writeUint32(outOfRangeVtableAddr + 4, retStubAddr);
            Mem.writeUint32(outOfRangeVtableAddr + 8, retStubAddr);
            Mem.writeUint32(outOfRangeVtableAddr + 12, retStubAddr);
            tg?.registerDataExport?.(this.name, "??_7out_of_range@std@@6B@", outOfRangeVtableAddr);

            const runtimeErrorVtableAddr = process.memory.alloc(16, "THUNK_DATA", "rw");
            Mem.writeUint32(runtimeErrorVtableAddr + 0, 0);
            Mem.writeUint32(runtimeErrorVtableAddr + 4, retStubAddr);
            Mem.writeUint32(runtimeErrorVtableAddr + 8, retStubAddr);
            Mem.writeUint32(runtimeErrorVtableAddr + 12, retStubAddr);
            tg?.registerDataExport?.(this.name, "??_7runtime_error@std@@6B@", runtimeErrorVtableAddr);

            // logic_error's real primary ctor needs a working what():
            // `mov eax, [ecx+4]; ret` returns the object's stored message pointer.
            const whatStubAddr = process.memory.alloc(4, "THUNK_CODE", "rx");
            Mem.writeBytes(whatStubAddr, new Uint8Array([0x8b, 0x41, 0x04, 0xc3]));

            this.logicErrorVtableAddr = process.memory.alloc(16, "THUNK_DATA", "rw");
            Mem.writeUint32(this.logicErrorVtableAddr + 0, whatStubAddr);
            Mem.writeUint32(this.logicErrorVtableAddr + 4, whatStubAddr);
            Mem.writeUint32(this.logicErrorVtableAddr + 8, whatStubAddr);
            Mem.writeUint32(this.logicErrorVtableAddr + 12, whatStubAddr);
            tg?.registerDataExport?.(this.name, "??_7logic_error@std@@6B@", this.logicErrorVtableAddr);
        }
    }

    private ensureExceptionStorage(process: Process): void {
        if (this.badCastVtableAddr) return;
        const methods = [
            { name: "IVc6Exception_DeletingDestructor", argCount: 1, stackCleanupBytes: 4, callingConvention: "stdcall" },
            { name: "IVc6Exception_What", argCount: 0, stackCleanupBytes: 0, callingConvention: "stdcall" },
            { name: "IVc6Exception_Doraise", argCount: 0, stackCleanupBytes: 0, callingConvention: "stdcall" },
        ];
        const tg = process.thunkGenerator;
        const stubs = tg.generateStubDll(this.name, methods);
        if (!writeGuestCode(process.getCurrentMemory(), stubs.stubCode, stubs.baseAddress)) {
            throw new Error("msvcp60: unable to publish exception vtable methods");
        }
        const unknown = new TextEncoder().encode("Unknown exception\0");
        this.unknownExceptionAddr = process.memory.alloc(unknown.length, "THUNK_DATA", "rw");
        if (!this.unknownExceptionAddr) throw new Error("msvcp60: exception data allocation failed");
        vc6WriteBytes(this.unknownExceptionAddr, unknown);
        // VC6 vtable order: deleting destructor, what(), _Doraise. No RTTI locator is
        // published, so a dynamic_cast/typeid on these objects fails visibly.
        for (const kind of ["exception", "bad_cast", "bad_alloc"] as const) {
            const allocation = process.memory.alloc(16, "THUNK_DATA", "rw");
            if (!allocation) throw new Error("msvcp60: exception vtable allocation failed");
            vc6WriteU32(allocation, 0);
            const vtable = allocation + 4;
            methods.forEach((method, i) => vc6WriteU32(vtable + i * 4, stubs.exportTable.get(method.name.toLowerCase())!));
            if (kind === "exception") this.exceptionVtableAddr = vtable;
            else if (kind === "bad_cast") this.badCastVtableAddr = vtable;
            else this.badAllocVtableAddr = vtable;
        }
        tg.registerDataExport(this.name, "??_7bad_cast@std@@6B@", this.badCastVtableAddr);
        tg.registerDataExport(this.name, "??_7bad_alloc@std@@6B@", this.badAllocVtableAddr);
    }

    private registerDataExports(process: Process): void {
        const tg = process.thunkGenerator;
        // Literal "msvcp60" (not `this.name`) so the static source scans in
        // tools/preflight-imports.ts and tools/validate-data-export-binding.ts, which look
        // for a call whose first two arguments are both string literals, can see these are
        // bound rather than reading them as unresolvable.
        tg?.registerDataExport("msvcp60", `?npos@${BS}@@2IB`, this.nposAddr);
        tg?.registerDataExport("msvcp60", `?_C@?1??_Nullstr@${BS}@@CAPBDXZ@4DB`, this.nullstrAddr);
        tg?.registerDataExport("msvcp60", "?cout@std@@3V?$basic_ostream@DU?$char_traits@D@std@@@1@A", this.coutAddr);
        tg?.registerDataExport("msvcp60", "?cerr@std@@3V?$basic_ostream@DU?$char_traits@D@std@@@1@A", this.cerrAddr);
        tg?.registerDataExport("msvcp60", "_Inf", this.infAddr);
        tg?.registerDataExport("msvcp60", "_Snan", this.snanAddr);
        tg?.registerDataExport("msvcp60", "_FInf", this.finfAddr);
        tg?.registerDataExport("msvcp60", "_FSnan", this.fsnanAddr);
    }

    reregisterExports(process: Process): void {
        this.process = process;
        this.nullstrAddr = 0;
        this.nposAddr = 0;
        this.refcntAddr = 0;
        this.logicErrorVtableAddr = 0;
        this.badCastVtableAddr = 0;
        this.badAllocVtableAddr = 0;
        this.exceptionVtableAddr = 0;
        this.unknownExceptionAddr = 0;
        this.coutAddr = 0;
        this.cerrAddr = 0;
        this.infAddr = 0;
        this.snanAddr = 0;
        this.finfAddr = 0;
        this.fsnanAddr = 0;
        this.ensureRuntimeStorage(process);
        this.ensureExceptionStorage(process);
        this.registerDataExports(process);
    }

    initialize(process: Process): void {
        this.process = process;
        const msvcrt = this.msvcrt;
        this.heap = {
            alloc: (n) => {
                const fn = msvcrt.exports["malloc"];
                return (fn?.(null as any, null as any, [n >>> 0]) ?? 0) as number;
            },
            free: (p) => {
                const fn = msvcrt.exports["free"];
                fn?.(null as any, null as any, [p >>> 0]);
            },
        };

        this.ensureRuntimeStorage(process);
        this.ensureExceptionStorage(process);
        this.registerDataExports(process);

        const nullstr = () => this.nullstrAddr;
        const heap = this.heap;
        const EXC_OBJ_SIZE = 20;
        registerVc6LocaleExports(this.exports, {
            snapshot: () => this.msvcrt.getCppLocaleSnapshot(),
            alloc: n => this.heap.alloc(n),
            free: p => this.heap.free(p),
            setEdx: value => {
                const cpu = getCPU(this.process.v86);
                if (!cpu) throw new Error("msvcp60: no CPU for EDX:EAX locale return");
                cpuViews(cpu).reg32[2] = value | 0;
            },
            setErrno: value => {
                const address = this.msvcrt.exports["_errno"]!(null as never, null as never, []) as number;
                vc6WriteU32(address, value);
            },
        });

        const copyExceptionObj = (dst: number, src: number): number => {
            for (let i = 0; i < EXC_OBJ_SIZE; i++) {
                const b = Mem.readUint8(src + i) ?? 0;
                Mem.writeBytes(dst + i, new Uint8Array([b]));
            }
            return dst;
        };

        this.exports[`?_Tidy@${BS}@@AAEX_N@Z`] = (ctx, _mem, args) => {
            vc6StringTidy(ctx.ecx >>> 0, (args[0] ?? 0) !== 0, this.heap, nullstr());
            return 0;
        };

        this.exports[`?_Copy@${BS}@@AAEXI@Z`] = (ctx, _mem, args) => {
            vc6StringCopy(ctx.ecx >>> 0, args[0] ?? 0, this.heap, nullstr());
            return 0;
        };

        this.exports[`?_Split@${BS}@@AAEXXZ`] = (ctx, _mem, _args) => {
            vc6StringSplit(ctx.ecx >>> 0, this.heap, nullstr());
            return 0;
        };

        this.exports[`?_Grow@${BS}@@AAE_NI_N@Z`] = (ctx, _mem, args) => {
            const ok = vc6StringGrow(ctx.ecx >>> 0, args[0] ?? 0, (args[1] ?? 0) !== 0, this.heap, nullstr());
            return ok ? 1 : 0;
        };

        this.exports[`?_Eos@${BS}@@AAEXI@Z`] = (ctx, _mem, args) => {
            vc6StringEos(ctx.ecx >>> 0, args[0] ?? 0, nullstr());
            return 0;
        };

        this.exports[`?erase@${BS}@@QAEAAV12@II@Z`] = (ctx, _mem, args) => {
            return vc6StringErase(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, nullstr());
        };

        this.exports[`?assign@${BS}@@QAEAAV12@ABV12@II@Z`] = (ctx, _mem, args) => {
            return vc6StringAssignRange(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, this.heap, nullstr());
        };

        this.exports[`?assign@${BS}@@QAEAAV12@PBDI@Z`] = (ctx, _mem, args) => {
            return vc6StringAssignCStrCount(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, this.heap, nullstr());
        };

        this.exports["??8std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@PBD@Z"] = (_ctx, _mem, args) => {
            return vc6StringEqualsCStr(args[0] ?? 0, args[1] ?? 0, nullstr());
        };

        this.exports[`??0${BS}@@QAE@XZ`] = (ctx, _mem, _args) => {
            return vc6StringCtorCStr(ctx.ecx >>> 0, 0, heap, nullstr());
        };

        this.exports[`??0${BS}@@QAE@PBDABV?$allocator@D@1@@Z`] = (ctx, _mem, args) => {
            return vc6StringCtorCStr(ctx.ecx >>> 0, args[0] ?? 0, heap, nullstr());
        };

        this.exports[`??0${BS}@@QAE@ABV01@@Z`] = (ctx, _mem, args) => {
            return vc6StringCopyCtor(ctx.ecx >>> 0, args[0] ?? 0, heap, nullstr());
        };

        this.exports[`??1${BS}@@QAE@XZ`] = (ctx, _mem, _args) => {
            vc6StringTidy(ctx.ecx >>> 0, true, heap, nullstr());
            return 0;
        };

        this.exports[`??_F${BS}@@QAEXXZ`] = (ctx, _mem, _args) => {
            vc6StringTidy(ctx.ecx >>> 0, true, heap, nullstr());
            return 0;
        };

        this.exports[`?_Freeze@${BS}@@AAEXXZ`] = (_ctx, _mem, _args) => 0;

        // Private COW helper: real VC6 STL stores the share count as the u16 just before the
        // data buffer. We never share buffers (every op does a real copy), so always report 1.
        this.exports[`?_Refcnt@${BS}@@AAEAAEPBD@Z`] = (_ctx, _mem, _args) => {
            return this.refcntAddr;
        };

        this.exports[`?c_str@${BS}@@QBEPBDXZ`] = (ctx, _mem, _args) => {
            return vc6StringCStr(ctx.ecx >>> 0, nullstr());
        };

        this.exports[`?max_size@${BS}@@QBEIXZ`] = (_ctx, _mem, _args) => 0x7fffffff;

        this.exports[`?find@${BS}@@QBEIPBDII@Z`] = (ctx, _mem, args) => {
            return vc6StringFind(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, nullstr());
        };

        this.exports[`?find_first_of@${BS}@@QBEIPBDII@Z`] = (ctx, _mem, args) => {
            return vc6StringFindFirstOf(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, nullstr());
        };

        this.exports[`?find_last_of@${BS}@@QBEIPBDII@Z`] = (ctx, _mem, args) => {
            return vc6StringFindLastOf(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, nullstr());
        };

        this.exports[`?insert@${BS}@@QAEAAV12@IPBDI@Z`] = (ctx, _mem, args) => {
            return vc6StringInsert(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
        };

        this.exports[`?append@${BS}@@QAEAAV12@PBDI@Z`] = (ctx, _mem, args) => {
            return vc6StringAppendCStrCount(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, heap, nullstr());
        };

        this.exports[`?append@${BS}@@QAEAAV12@ID@Z`] = (ctx, _mem, args) => {
            return vc6StringAppendCharCount(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, heap, nullstr());
        };

        // append(right, pos, count) and substr(pos, count) both document pos > right.size()
        // (pos > size() for substr) as std::out_of_range — real for EVERY pos past the end,
        // including a zero count, so this checks BEFORE the mutating helper clamps count and
        // proceeds as if nothing were wrong. Routed through the same _Xran the real VC6 STL
        // calls for this exact violation (already wired below to throwRuntimeError).
        this.exports[`?append@${BS}@@QAEAAV12@ABV12@II@Z`] = (ctx, _mem, args) => {
            const right = args[0] ?? 0;
            if ((args[1] ?? 0) >>> 0 > vc6StringSize(right)) return throwRuntimeError("_Xran");
            return vc6StringAppendRange(ctx.ecx >>> 0, right, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
        };

        // substr(pos, count) returns a NEW string, so args[0] is the caller's hidden
        // return-value slot (same convention as the operator+ overloads below).
        this.exports[`?substr@${BS}@@QBE?AV12@II@Z`] = (ctx, _mem, args) => {
            const self = ctx.ecx >>> 0;
            if ((args[1] ?? 0) >>> 0 > vc6StringSize(self)) return throwRuntimeError("_Xran");
            return vc6StringSubstr(args[0] ?? 0, self, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
        };

        this.exports["??8std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z"] = (_ctx, _mem, args) => {
            return vc6StringEquals(args[0] ?? 0, args[1] ?? 0, nullstr());
        };

        this.exports["??9std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z"] = (_ctx, _mem, args) => {
            return vc6StringEquals(args[0] ?? 0, args[1] ?? 0, nullstr()) ? 0 : 1;
        };

        this.exports["??9std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@PBD@Z"] = (_ctx, _mem, args) => {
            return vc6StringEqualsCStr(args[0] ?? 0, args[1] ?? 0, nullstr()) ? 0 : 1;
        };

        this.exports["??Mstd@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z"] = (_ctx, _mem, args) => {
            return vc6StringLess(args[0] ?? 0, args[1] ?? 0, nullstr());
        };

        const opPlus = (_ctx: any, _mem: any, args: number[]) => {
            const dst = args[0] ?? 0;
            vc6StringConcat(dst, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
            return dst;
        };
        this.exports[`??Hstd@@YA?AV${BS}@@ABV10@0@Z`] = opPlus;
        this.exports[`??Hstd@@YA?AV${BS0}@ABV10@0@Z`] = opPlus;

        this.exports[`??Hstd@@YA?AV${BS0}@PBDABV10@@Z`] = (_ctx, _mem, args) => {
            const dst = args[0] ?? 0;
            vc6StringConcatCStrLeft(dst, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
            return dst;
        };

        this.exports[`??Hstd@@YA?AV${BS0}@ABV10@PBD@Z`] = (_ctx, _mem, args) => {
            const dst = args[0] ?? 0;
            vc6StringConcatCStrRight(dst, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
            return dst;
        };

        this.exports["??0bad_cast@std@@QAE@PBD@Z"] = (ctx, _mem, args) =>
            vc6ExceptionCtor(ctx.ecx >>> 0, args[0] ?? 0, this.badCastVtableAddr, this.heap);
        this.exports["??0bad_cast@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) =>
            vc6ExceptionCopy(ctx.ecx >>> 0, args[0]!, this.badCastVtableAddr, this.heap);
        this.exports["??1bad_cast@std@@UAE@XZ"] = (ctx, _mem, _args) => {
            vc6ExceptionDtor(ctx.ecx >>> 0, this.exceptionVtableAddr, this.heap);
            return 0;
        };
        this.exports["??4bad_cast@std@@QAEAAV01@ABV01@@Z"] = (ctx, _mem, args) => {
            const object = ctx.ecx >>> 0;
            if (object !== args[0]) {
                vc6ExceptionDtor(object, this.exceptionVtableAddr, this.heap);
                // operator= keeps the base exception vptr, matching the VC6 library's
                // exception::operator= that bad_cast inherits.
                vc6ExceptionCopy(object, args[0]!, this.exceptionVtableAddr, this.heap);
            }
            return object;
        };
        // The exception vtable's methods (deleting destructor, what(), _Doraise).
        this.exports["IVc6Exception_DeletingDestructor"] = (ctx, _mem, args) =>
            vc6ExceptionDelete(ctx.ecx >>> 0, args[0]!, this.exceptionVtableAddr, this.heap);
        this.exports["IVc6Exception_What"] = (ctx, _mem, _args) =>
            vc6ExceptionWhat(ctx.ecx >>> 0, this.unknownExceptionAddr);
        this.exports["IVc6Exception_Doraise"] = (ctx, _mem, _args) => {
            System.getInstance().reportGuestCrash({
                reason: "msvcp60!exception::_Doraise is not implemented",
                eip: ctx.eip >>> 0,
            });
            return 0;
        };

        this.exports["??0bad_alloc@std@@QAE@PBD@Z"] = (ctx, _mem, args) =>
            vc6ExceptionCtor(ctx.ecx >>> 0, args[0] ?? 0, this.badAllocVtableAddr, this.heap);
        this.exports["??0bad_alloc@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) =>
            vc6ExceptionCopy(ctx.ecx >>> 0, args[0]!, this.badAllocVtableAddr, this.heap);
        this.exports["??1bad_alloc@std@@UAE@XZ"] = (ctx, _mem, _args) => {
            vc6ExceptionDtor(ctx.ecx >>> 0, this.exceptionVtableAddr, this.heap);
            return 0;
        };

        this.exports["??0out_of_range@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) => {
            return copyExceptionObj(ctx.ecx >>> 0, args[0] ?? 0);
        };

        this.exports["??0runtime_error@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) => {
            return copyExceptionObj(ctx.ecx >>> 0, args[0] ?? 0);
        };

        this.exports["??0logic_error@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) => {
            return copyExceptionObj(ctx.ecx >>> 0, args[0] ?? 0);
        };

        // logic_error(const std::string& _Message) — the primary ctor used at `throw` sites.
        // Deep-copies the message (the guest string is a temporary that dies after the throw
        // statement) and sets up a real vtable so a later `.what()` returns the stored pointer.
        this.exports["??0logic_error@std@@QAE@ABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@1@@Z"] =
            (ctx, _mem, args) => {
                const obj = ctx.ecx >>> 0;
                const cstr = vc6StringCStr(args[0] ?? 0, nullstr());
                let len = 0;
                while ((Mem.readUint8(cstr + len) ?? 0) !== 0 && len < 0x10000) len++;
                const msgAddr = heap.alloc(len + 1);
                for (let i = 0; i <= len; i++) {
                    Mem.writeUint8(msgAddr + i, Mem.readUint8(cstr + i) ?? 0);
                }
                Mem.writeUint32(obj + 0, this.logicErrorVtableAddr);
                Mem.writeUint32(obj + 4, msgAddr);
                Mem.writeUint32(obj + 8, 1); // _Dofree
                return obj;
            };

        this.exports["??1out_of_range@std@@UAE@XZ"] = (_ctx, _mem, _args) => 0;
        this.exports["??1runtime_error@std@@UAE@XZ"] = (_ctx, _mem, _args) => 0;

        this.exports["??0_Lockit@std@@QAE@XZ"] = (ctx, _mem, _args) => ctx.ecx >>> 0;
        this.exports["??1_Lockit@std@@QAE@XZ"] = (_ctx, _mem, _args) => 0;
        // _Lockit has no data members, so its assignment operator copies nothing.
        this.exports["??4_Lockit@std@@QAEAAV01@ABV01@@Z"] = (ctx, _mem, _args) => ctx.ecx >>> 0;

        // operator<<(basic_ostream&, const char*) — no real stream; chain return for iostream static init.
        this.exports["??6std@@YAAAV?$basic_ostream@DU?$char_traits@D@std@@@0@AAV10@PBD@Z"] = (_ctx, _mem, args) => {
            return args[0] ?? 0;
        };

        // basic_ostream::operator<<(int) — same "no real stream" no-op, chained off `this`.
        this.exports["??6?$basic_ostream@DU?$char_traits@D@std@@@std@@QAEAAV01@H@Z"] = (ctx, _mem, _args) => {
            return ctx.ecx >>> 0;
        };

        // basic_istream::get() / get(char&) / putback(char) — no real stream to read from,
        // so every read behaves as one already at EOF. get() answers EOF (-1) per its
        // documented int-return contract — a caller testing the RETURN VALUE (the common,
        // standard-recommended idiom: `while ((c = stream.get()) != EOF)`) sees a correct
        // failure. get(char&) leaves the output char UNTOUCHED on failure: VC6's own
        // Dinkumware get(_E&) only assigns _Ch when sbumpc() didn't return eof — it never
        // writes charT() — so zero-filling it would hand a caller that (wrongly) ignores the
        // failure a value real VC6 never produces.
        //
        // KNOWN GAP: get(char&)/putback(char) return `istream&` (always *this*), not a status
        // code, so a caller testing failure via the stream's own boolean conversion
        // (`while (stream.get(ch))`) relies on an eofbit/failbit flag inside the istream
        // object — which we do not set. Wine's msvcp60/msvcp.h verifies ios_base::state sits
        // at offset 4 (goodbit=0/eofbit=1/failbit=2/badbit=4), but basic_istream reaches
        // ios_base through a VIRTUAL base, and the vbtable offset that locates it within a
        // basic_istream object isn't verified from that source — writing a flag at a guessed
        // offset risks corrupting an unrelated field in guest-allocated memory, which is worse
        // than the status quo. Left unfixed pending a verified basic_istream<char> layout.
        const EOF_VALUE = -1;
        this.exports["?get@?$basic_istream@DU?$char_traits@D@std@@@std@@QAEHXZ"] = () => EOF_VALUE;
        this.exports["?get@?$basic_istream@DU?$char_traits@D@std@@@std@@QAEAAV12@AAD@Z"] = (ctx, _mem, _args) => {
            return ctx.ecx >>> 0;
        };
        this.exports["?putback@?$basic_istream@DU?$char_traits@D@std@@@std@@QAEAAV12@D@Z"] = (ctx, _mem, _args) => {
            return ctx.ecx >>> 0;
        };

        // ios_base::Init / std::_Winit — CRT iostream bootstrap objects; no-op in HLE.
        this.exports["??0Init@ios_base@std@@QAE@XZ"] = (ctx, _mem, _args) => ctx.ecx >>> 0;
        this.exports["??1Init@ios_base@std@@QAE@XZ"] = (_ctx, _mem, _args) => 0;
        this.exports["??0_Winit@std@@QAE@XZ"] = (ctx, _mem, _args) => ctx.ecx >>> 0;
        this.exports["??1_Winit@std@@QAE@XZ"] = (_ctx, _mem, _args) => 0;

        const throwRuntimeError = (label: string): number => {
            Logger.warn(LogCategory.SYSTEM, `msvcp60:${label} — terminating`);
            const term = msvcrt.exports["abort"];
            term?.(null as any, null as any, []);
            return 0;
        };

        this.exports["?_Xlen@std@@YAXXZ"] = () => throwRuntimeError("_Xlen");
        this.exports["?_Xran@std@@YAXXZ"] = () => throwRuntimeError("_Xran");

        Logger.log(LogCategory.SYSTEM,
            `msvcp60: initialized (_Nullstr=0x${this.nullstrAddr.toString(16)}, npos=0x${this.nposAddr.toString(16)})`);
    }
}
