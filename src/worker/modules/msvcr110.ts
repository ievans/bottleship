/**
 * MSVCR110 — the VC++ 2012 C runtime. rise.exe (Rise of Nations' Steam v1.10 branch) links
 * this by NAME, same as any VC8+ title: a missing export fails the whole image's import
 * bind, not just one feature (see crt-vc8.ts).
 *
 * Almost every entry point here behaves identically to the legacy msvcrt.dll this codebase
 * already implements (Msvcrt): same libc semantics, just a different DLL name the 2012
 * toolchain happened to link against. Those are PROXIED straight through to the existing
 * Msvcrt instance rather than re-implemented — one heap, one errno cell, one FILE table,
 * shared process-wide exactly as the real OS would have it if both CRTs were ever loaded
 * into the same process.
 *
 * Only genuinely VC110-specific entries (the `_s` bounds-checked family 2005→2012 kept
 * adding, the wide-char filesystem calls, and the refactored-out CRT startup internals)
 * get a real implementation below.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { Marshaler } from "../core/memory/marshaler";
import { Msvcrt } from "./msvcrt";
import { formatAsctime } from "./crt-time";
import { shutdownProcess } from "./kernel32/process/process";
import { Logger, LogCategory } from "../core/logger";

/** Names whose VC110 behavior is identical to the legacy msvcrt.dll export of the same name. */
const PROXIED_NAMES = [
    "__CxxFrameHandler3", "__dllonexit", "__getmainargs", "__iob_func", "__set_app_type",
    "__setusermatherr", "_acmdln", "_aligned_free", "_aligned_malloc", "_amsg_exit", "_atoi64",
    "_cexit", "_configthreadlocale", "_controlfp_s", "_crt_debugger_hook", "_CxxThrowException",
    "_errno", "_except_handler3", "_except_handler4_common", "_exit", "_filelength", "_fileno",
    "_findclose", "_fseeki64", "_ftelli64", "_initterm", "_initterm_e", "_invoke_watson",
    "_ismbblead", "_itoa", "_libm_sse2_acos_precise", "_libm_sse2_atan_precise",
    "_libm_sse2_cos_precise", "_libm_sse2_pow_precise", "_libm_sse2_sin_precise",
    "_libm_sse2_sqrt_precise", "_libm_sse2_tan_precise", "_lock", "_onexit", "_purecall",
    "_set_SSE2_enable", "_snprintf", "_snprintf_s", "_stricmp", "_time64", "_unlock",
    "_wcsicmp", "_wcsnicmp", "_wtoi", "_XcptFilter",
    "?_set_new_handler@@YAP6AHI@ZP6AHI@Z@Z", "?_set_new_mode@@YAHH@Z",
    "??0bad_cast@std@@QAE@ABV01@@Z", "??0bad_cast@std@@QAE@PBD@Z", "??0exception@std@@QAE@ABV01@@Z",
    "??1bad_cast@std@@UAE@XZ", "??1type_info@@UAE@XZ", "?terminate@@YAXXZ",
    "abort", "atoi", "calloc", "exit", "fclose", "feof", "ferror", "fflush", "fgetc", "fgetpos",
    "fgets", "fopen", "fprintf", "fputc", "fputs", "fputwc", "fread", "free", "fseek", "fsetpos",
    "ftell", "fwrite", "isdigit", "iswspace", "isxdigit", "malloc", "mbstowcs", "memcpy",
    "memmove", "memset", "printf", "qsort", "realloc", "rewind", "setvbuf", "sprintf",
    "sprintf_s", "strcat_s", "strchr", "strcpy_s", "strncmp", "strncpy_s", "strtod", "strtok_s",
    "tolower", "toupper", "towlower", "towupper", "ungetc", "vsprintf_s", "wcschr", "wcsncmp",
    "wcsrchr", "wcsstr", "wcstoul",
] as const;

export class Msvcr110 implements IModule {
    name = "msvcr110";
    exports: Record<string, ThunkImplementation> = {};

    private msvcrt!: Msvcrt;
    private fmodeAddr = 0;
    private commodeAddr = 0;
    private unhandledFilter = 0;

    setMsvcrt(msvcrt: Msvcrt): void {
        this.msvcrt = msvcrt;
    }

    initialize(process: Process): void {
        const msvcrt = this.msvcrt;
        const exports = this.exports;

        const through = (name: string, args: unknown[]): number =>
            (msvcrt.exports[name]?.(null as any, null as any, args as any[]) as number) ?? 0;
        const malloc = (n: number): number => through("malloc", [n >>> 0]);
        const free = (p: number): void => { through("free", [p >>> 0]); };
        const errnoAddr = (): number => through("_errno", []);
        const setErrno = (value: number): void => {
            const addr = errnoAddr();
            if (addr) Mem.writeUint32(addr, value >>> 0);
        };

        for (const fnName of PROXIED_NAMES) {
            exports[fnName] = (ctx, mem, args) => msvcrt.exports[fnName]?.(ctx, mem, args) ?? 0;
        }

        // _fmode / _commode: data exports (global int cells the CRT startup reads/writes),
        // not functions — a thunk stub here would hand the importer the first bytes of a
        // stub body as the value (see msvcp90.ts's ymath constants for the same shape).
        const tg = process.thunkGenerator;
        if (tg?.registerDataExport) {
            if (this.fmodeAddr === 0) this.fmodeAddr = process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.fmodeAddr, 0x4000); // _O_TEXT
            tg.registerDataExport(this.name, "_fmode", this.fmodeAddr);

            if (this.commodeAddr === 0) this.commodeAddr = process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.commodeAddr, 0); // _IOCOMMIT off
            tg.registerDataExport(this.name, "_commode", this.commodeAddr);
        }

        // --- CRT startup internals VC110 split out of the inline sequence earlier
        // runtimes had entirely in the CRT startup object file. ---
        exports["__crtGetShowWindowMode"] = () => 1; // SW_SHOWNORMAL
        exports["__crtSetUnhandledExceptionFilter"] = (_c, _m, a) => {
            const prev = this.unhandledFilter;
            this.unhandledFilter = a[0] ?? 0;
            return prev;
        };
        exports["__crtUnhandledException"] = () => 0; // EXCEPTION_CONTINUE_SEARCH
        exports["__crtTerminateProcess"] = (_c, _m, a) => shutdownProcess(a[0] ?? 0);

        // --- the `_s` bounds-checked family VC8 started and VC110 kept growing ---
        exports["memcpy_s"] = (_c, mem, a) => {
            const [dest, destSize, src, count] = a;
            if ((count ?? 0) > (destSize ?? 0)) { setErrno(34 /* ERANGE */); return 34; }
            through("memcpy", [dest, src, count]);
            return 0;
        };

        exports["wcscpy_s"] = (_c, mem, a) => {
            const [dest, destSizeChars, src] = a;
            const s = Marshaler.readStringW(mem, src ?? 0);
            if (s.length + 1 > (destSizeChars ?? 0)) { setErrno(34); return 34; }
            through("wcscpy", [dest, src]);
            return 0;
        };
        exports["wcscat_s"] = (_c, mem, a) => {
            const [dest, destSizeChars, src] = a;
            const have = Marshaler.readStringW(mem, dest ?? 0).length;
            const add = Marshaler.readStringW(mem, src ?? 0).length;
            if (have + add + 1 > (destSizeChars ?? 0)) { setErrno(34); return 34; }
            through("wcscat", [dest, src]);
            return 0;
        };
        exports["wcsncpy_s"] = (_c, mem, a) => {
            const [dest, destSizeChars, src, count] = a;
            const toCopy = Math.min(count ?? 0, Marshaler.readStringW(mem, src ?? 0).length);
            if (toCopy + 1 > (destSizeChars ?? 0)) { setErrno(34); return 34; }
            through("wcsncpy", [dest, src, count]);
            return 0;
        };

        exports["_vsnprintf_s"] = (_c, mem, a) => {
            const [dest, destSize, count, fmt, va] = a;
            const cap = Math.min(count ?? 0xffffffff, (destSize ?? 0) - 1);
            return through("_vsnprintf", [dest, cap >>> 0, fmt, va]);
        };
        exports["_vsnwprintf_s"] = (_c, mem, a) => {
            const [dest, destSize, count, fmt, va] = a;
            const cap = Math.min(count ?? 0xffffffff, (destSize ?? 0) - 1);
            return through("_vsnwprintf", [dest, cap >>> 0, fmt, va]);
        };

        exports["_itow_s"] = (_c, mem, a) => {
            const [value, buffer, sizeChars, radix] = a;
            const s = (value | 0).toString((radix ?? 10) >>> 0);
            if (s.length + 1 > (sizeChars ?? 0)) { setErrno(34); return 34; }
            Marshaler.writeWideString(mem, buffer ?? 0, s, sizeChars ?? 0);
            return 0;
        };
        exports["_ultow_s"] = (_c, mem, a) => {
            const [value, buffer, sizeChars, radix] = a;
            const s = (value >>> 0).toString((radix ?? 10) >>> 0);
            if (s.length + 1 > (sizeChars ?? 0)) { setErrno(34); return 34; }
            Marshaler.writeWideString(mem, buffer ?? 0, s, sizeChars ?? 0);
            return 0;
        };
        exports["_i64toa_s"] = (_c, mem, a) => {
            const [lo, hi, buffer, sizeChars, radix] = a;
            const value = (BigInt(hi ?? 0) << 32n) | BigInt((lo ?? 0) >>> 0);
            const s = value.toString((radix ?? 10) >>> 0);
            if (s.length + 1 > (sizeChars ?? 0)) { setErrno(34); return 34; }
            Marshaler.writeString(mem, buffer ?? 0, s, sizeChars ?? 0);
            return 0;
        };
        // Returned in EDX:EAX, same as _atoi64 (msvcrt.ts) — BigInt keeps full precision,
        // two's-complement masking gives correctly sign-extended halves.
        exports["_wtoi64"] = (_c, mem, a) => {
            const s = Marshaler.readStringW(mem, a[0] ?? 0).trim();
            const m = s.match(/^[+-]?\d+/);
            let v = 0n;
            if (m) { try { v = BigInt(m[0]); } catch { v = 0n; } }
            const reg = (process as any)?.dispatcher?.cachedReg32;
            if (reg) reg[2] = Number((v >> 32n) & 0xffffffffn) | 0;
            return Number(v & 0xffffffffn) | 0;
        };

        exports["asctime_s"] = (_c, mem, a) => {
            const [buffer, sizeBytes, tm] = a;
            if ((sizeBytes ?? 0) < 26) { setErrno(34); return 34; }
            const sec = Mem.readUint32((tm ?? 0) + 0) ?? 0;
            const min = Mem.readUint32((tm ?? 0) + 4) ?? 0;
            const hour = Mem.readUint32((tm ?? 0) + 8) ?? 0;
            const mday = Mem.readUint32((tm ?? 0) + 12) ?? 0;
            const mon = Mem.readUint32((tm ?? 0) + 16) ?? 0;
            const year = (Mem.readUint32((tm ?? 0) + 20) ?? 0) + 1900;
            const wday = Mem.readUint32((tm ?? 0) + 24) ?? 0;
            Marshaler.writeString(mem, buffer ?? 0, formatAsctime(wday, mon, mday, hour, min, sec, year));
            return 0;
        };
        exports["_localtime64_s"] = (_c, mem, a) => {
            const [tmDest, timePtr] = a;
            const seconds = Mem.readUint32(timePtr ?? 0) ?? 0;
            const date = new Date(seconds * 1000);
            if (!tmDest) return 22; // EINVAL
            Mem.writeUint32(tmDest + 0, date.getSeconds());
            Mem.writeUint32(tmDest + 4, date.getMinutes());
            Mem.writeUint32(tmDest + 8, date.getHours());
            Mem.writeUint32(tmDest + 12, date.getDate());
            Mem.writeUint32(tmDest + 16, date.getMonth());
            Mem.writeUint32(tmDest + 20, date.getFullYear() - 1900);
            Mem.writeUint32(tmDest + 24, date.getDay());
            const start = new Date(date.getFullYear(), 0, 1);
            Mem.writeUint32(tmDest + 28, Math.floor((date.getTime() - start.getTime()) / 86400000));
            Mem.writeUint32(tmDest + 32, 0);
            return 0;
        };
        exports["_wstrtime_s"] = (_c, mem, a) => {
            const [buffer, sizeChars] = a;
            if ((sizeChars ?? 0) < 9) { setErrno(34); return 34; }
            const d = new Date();
            const s = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
            Marshaler.writeWideString(mem, buffer ?? 0, s, sizeChars ?? 0);
            return 0;
        };

        exports["fopen_s"] = (_c, mem, a) => {
            const [pFile, filename, mode] = a;
            const fp = through("fopen", [filename, mode]);
            Mem.writeUint32(pFile ?? 0, fp >>> 0);
            return fp ? 0 : 2; // ENOENT
        };
        exports["_wfopen_s"] = (_c, mem, a) => {
            const [pFile, filename, mode] = a;
            const nameBuf = malloc(260);
            const modeBuf = malloc(16);
            Marshaler.writeString(mem, nameBuf, Marshaler.readStringW(mem, filename ?? 0));
            Marshaler.writeString(mem, modeBuf, Marshaler.readStringW(mem, mode ?? 0));
            const fp = through("fopen", [nameBuf, modeBuf]);
            free(nameBuf);
            free(modeBuf);
            Mem.writeUint32(pFile ?? 0, fp >>> 0);
            return fp ? 0 : 2;
        };

        // Wide-char filesystem calls: decode to a narrow scratch buffer and delegate to
        // the ANSI implementation already in msvcrt (same VFS, same current-directory).
        const withNarrowPath = (mem: Uint8Array, widePtr: number, fn: (narrowPtr: number) => number): number => {
            const buf = malloc(260);
            Marshaler.writeString(mem, buf, Marshaler.readStringW(mem, widePtr));
            const result = fn(buf);
            free(buf);
            return result;
        };
        exports["_wmkdir"] = (_c, mem, a) => withNarrowPath(mem, a[0] ?? 0, (p) => through("_mkdir", [p]));
        exports["_wchdir"] = (_c, mem, a) => withNarrowPath(mem, a[0] ?? 0, (p) => through("_chdir", [p]));
        exports["_wremove"] = (_c, mem, a) => {
            Logger.error(LogCategory.SYSTEM, `[msvcr110] _wremove("${Marshaler.readStringW(mem, a[0] ?? 0)}")`);
            return withNarrowPath(mem, a[0] ?? 0, (p) => through("remove", [p]));
        };
        exports["_wrename"] = (_c, mem, a) => {
            const oldBuf = malloc(260);
            const newBuf = malloc(260);
            Marshaler.writeString(mem, oldBuf, Marshaler.readStringW(mem, a[0] ?? 0));
            Marshaler.writeString(mem, newBuf, Marshaler.readStringW(mem, a[1] ?? 0));
            const result = through("rename", [oldBuf, newBuf]);
            free(oldBuf);
            free(newBuf);
            return result;
        };
        exports["_wgetcwd"] = (_c, mem, a) => {
            const [buffer, maxLenChars] = a;
            const narrow = through("_getcwd", [0, 0]); // NULL buffer: CRT mallocs its own
            const cwd = Marshaler.readString(mem, narrow);
            free(narrow);
            if (cwd.length + 1 > (maxLenChars ?? 0)) { setErrno(34); return 0; }
            Marshaler.writeWideString(mem, buffer ?? 0, cwd, maxLenChars ?? 0);
            return buffer ?? 0;
        };

        // _wfindfirst64i32/_wfindnext64i32: directory enumeration BottleShip's VFS has no
        // listing API for yet. Answering "nothing found" (-1 / ENOENT) is the one response
        // that cannot look like success — a game that depends on actually seeing files here
        // (mod/map browsing) will show that plainly instead of walking a fabricated list.
        exports["_wfindfirst64i32"] = (_c, mem, a) => {
            const pattern = Marshaler.readStringW(mem, a[0] ?? 0);
            Logger.error(LogCategory.SYSTEM, `[msvcr110] _wfindfirst64i32("${pattern}") -> -1`);
            setErrno(2); return -1;
        };
        exports["_wfindnext64i32"] = (_c, _m, a) => {
            Logger.error(LogCategory.SYSTEM, `[msvcr110] _wfindnext64i32(handle=0x${((a[0] ?? 0) >>> 0).toString(16)}) -> -1`);
            setErrno(2); return -1;
        };

        // wctype/locale odds and ends with no existing cousin to wrap.
        exports["wcscspn"] = (_c, mem, a) => {
            const s = Marshaler.readStringW(mem, a[0] ?? 0);
            const reject = new Set(Marshaler.readStringW(mem, a[1] ?? 0));
            let i = 0;
            while (i < s.length && !reject.has(s[i])) i++;
            return i;
        };
        exports["wcstod"] = (_c, mem, a) => {
            const s = Marshaler.readStringW(mem, a[0] ?? 0);
            const v = parseFloat(s);
            const endPtr = a[1] ?? 0;
            if (endPtr) {
                const m = s.match(/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
                Mem.writeUint32(endPtr, (a[0] ?? 0) + (m ? m[0].length : 0) * 2);
            }
            return Number.isNaN(v) ? 0 : v;
        };
        exports["mbtowc"] = (_c, mem, a) => {
            const [wcharOut, src, _n] = a;
            if (!src) return 0;
            const byte = mem[src];
            if (byte === undefined) return -1;
            if (wcharOut) Mem.writeUint16(wcharOut, byte);
            return byte === 0 ? 0 : 1;
        };
        exports["wctomb_s"] = (_c, mem, a) => {
            const [sizeWritten, dest, destSize, wchar] = a;
            if ((destSize ?? 0) < 1) { setErrno(34); return 34; }
            mem[dest ?? 0] = (wchar ?? 0) & 0xff;
            if (sizeWritten) Mem.writeUint32(sizeWritten, 1);
            return 0;
        };
        exports["wcstombs_s"] = (_c, mem, a) => {
            const [sizeConverted, dest, destSizeBytes, src, _maxCount] = a;
            const s = Marshaler.readStringW(mem, src ?? 0);
            const written = Marshaler.writeString(mem, dest ?? 0, s, destSizeBytes ?? 0);
            if (sizeConverted) Mem.writeUint32(sizeConverted, written);
            return 0;
        };

        exports["?_set_se_translator@@YAP6AXIPAU_EXCEPTION_POINTERS@@@ZP6AXI0@Z@Z"] = () => 0;
        exports["_calloc_crt"] = (_c, _m, a) => through("calloc", [a[0] ?? 0, a[1] ?? 0]);
        exports["_lock_file"] = () => 0;
        exports["_unlock_file"] = () => 0;
        exports["_gcvt_s"] = (_c, mem, a) => {
            const [buffer, sizeBytes, value, digits] = a;
            const s = (value as number).toPrecision(Math.max(1, Math.min(17, digits ?? 6)));
            if (s.length + 1 > (sizeBytes ?? 0)) { setErrno(34); return 34; }
            Marshaler.writeString(mem, buffer ?? 0, s, sizeBytes ?? 0);
            return 0;
        };
        exports["_wcsnicoll"] = (_c, mem, a) => {
            const [s1, s2, n] = a;
            const a1 = Marshaler.readStringW(mem, s1 ?? 0).slice(0, n ?? 0).toLowerCase();
            const a2 = Marshaler.readStringW(mem, s2 ?? 0).slice(0, n ?? 0).toLowerCase();
            return a1 < a2 ? -1 : a1 > a2 ? 1 : 0;
        };
        exports["_wcstoui64"] = (_c, mem, a) => {
            const [str, endPtr, base] = a;
            const s = Marshaler.readStringW(mem, str ?? 0).trim();
            const v = parseInt(s, (base ?? 10) || 10) || 0;
            if (endPtr) Mem.writeUint32(endPtr, str ?? 0);
            return v >>> 0;
        };

        // Rarely-exercised wide text I/O: no existing FILE*-level wide-char plumbing to
        // build on yet. Fail cleanly (EOF/NULL) rather than fabricate success.
        exports["fgetws"] = () => 0;
        exports["fputws"] = () => -1; // WEOF
        exports["fwprintf"] = () => -1;
        // swprintf_s(buffer, sizeInWords, format, ...) — unlike _vsnwprintf's va_list
        // pointer, the variadic args sit directly on the caller's stack right after the
        // three named params; that address IS a valid va_list, so pass it as one.
        exports["swprintf_s"] = (ctx, _mem, a) => {
            const [dest, sizeChars, fmt] = a;
            const vaList = ctx.esp + 4 + 3 * 4;
            return through("_vsnwprintf", [dest, sizeChars, fmt, vaList]);
        };
    }
}
