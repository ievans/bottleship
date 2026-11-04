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
import { EmulatorConfig, encodeAnsiString } from "../core/emulator-config-manager";
import { System } from "../core/system";
import type { VfsEntry } from "../runtime/filesystem/vfs";
import { unixTimeOf } from "../runtime/filesystem/file-time";
import { fpuPush } from "../core/fpu-helper";
import { Msvcrt } from "./msvcrt";
import { formatAsctime } from "./crt-time";
import { gcvtFormat, FINDDATA64I32_OFFSETS } from "./crt-vc9-io";
import { shutdownProcess } from "./kernel32/process/process";

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

/** stdio-style "copy as much as fits" sentinel, same value as size_t(-1). */
const _TRUNCATE = 0xffffffff;

interface WideFindState { entries: VfsEntry[]; index: number; }

export class Msvcr110 implements IModule {
    name = "msvcr110";
    exports: Record<string, ThunkImplementation> = {};

    private msvcrt!: Msvcrt;
    private fmodeAddr = 0;
    private commodeAddr = 0;
    private nextWideFindHandle = 0x50000000;
    private wideFindHandles: Map<number, WideFindState> = new Map();

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

        // Capture the REAL handler now, before anything overwrites msvcrt.exports[fnName] —
        // a proxy that re-reads msvcrt.exports[fnName] at call time would resolve to ITSELF
        // once emulator.worker.ts does Object.assign(msvcrt.exports, msvcr110.exports), and
        // every one of these (malloc, free, fopen, ...) would recurse until the stack blows.
        for (const fnName of PROXIED_NAMES) {
            const original = msvcrt.exports[fnName];
            exports[fnName] = (ctx, mem, args) => original?.(ctx, mem, args) ?? 0;
        }

        // _fmode / _commode: data exports (global int cells the CRT startup reads/writes),
        // not functions — a thunk stub here would hand the importer the first bytes of a
        // stub body as the value (see msvcp90.ts's ymath constants for the same shape).
        // Registered under the CANONICAL "msvcrt" name: MSVCR_VERSIONED (dll-aliases.ts)
        // canonicalizes every msvcr70…msvcr120 import to "msvcrt" before the loader ever
        // looks for a data export, so registering under "msvcr110" is simply unreachable.
        const tg = process.thunkGenerator;
        if (tg?.registerDataExport) {
            if (this.fmodeAddr === 0) this.fmodeAddr = process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.fmodeAddr, 0x4000); // _O_TEXT
            tg.registerDataExport("msvcrt", "_fmode", this.fmodeAddr);

            if (this.commodeAddr === 0) this.commodeAddr = process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.commodeAddr, 0); // _IOCOMMIT off
            tg.registerDataExport("msvcrt", "_commode", this.commodeAddr);
        }

        // --- CRT startup internals VC110 split out of the inline sequence earlier
        // runtimes had entirely in the CRT startup object file. ---
        exports["__crtGetShowWindowMode"] = () => 1; // SW_SHOWNORMAL
        // Shares the dispatcher's filter slot — the SAME one kernel32's SetUnhandledExceptionFilter
        // writes — rather than a private field nothing else can see.
        exports["__crtSetUnhandledExceptionFilter"] = (_c, _m, args) =>
            process.dispatcher.setUnhandledExceptionFilter(args[0] ?? 0);
        // Forward to kernel32's own UnhandledExceptionFilter rather than reimplementing its
        // diagnostics/callback-invocation logic: it already knows how to invoke the filter
        // __crtSetUnhandledExceptionFilter (above) and SetUnhandledExceptionFilter share.
        exports["__crtUnhandledException"] = (ctx, mem, args) => {
            const kernel32 = process.getModule("kernel32");
            const handler = kernel32?.exports?.["UnhandledExceptionFilter"];
            if (handler) return handler(ctx, mem, args);
            return 0; // EXCEPTION_CONTINUE_SEARCH — no app filter installed
        };
        exports["__crtTerminateProcess"] = (_c, _m, args) => shutdownProcess(args[0] ?? 0);

        // --- the `_s` bounds-checked family VC8 started and VC110 kept growing ---
        exports["memcpy_s"] = (_c, mem, args) => {
            const [dest, destSize, src, count] = args;
            const ds = destSize ?? 0;
            const n = count ?? 0;
            if (!dest) { setErrno(22 /* EINVAL */); return 22; }
            if (n > ds) { through("memset", [dest, 0, ds]); setErrno(34 /* ERANGE */); return 34; }
            if (!src && n !== 0) { through("memset", [dest, 0, ds]); setErrno(22); return 22; }
            if (n > 0) through("memcpy", [dest, src, n]);
            return 0;
        };

        exports["wcscpy_s"] = (_c, mem, args) => {
            const [dest, destSizeChars, src] = args;
            if (!dest || (destSizeChars ?? 0) === 0) { setErrno(22); return 22; }
            if (!src) { Mem.writeUint16(dest, 0); setErrno(22); return 22; }
            const s = Marshaler.readStringW(mem, src);
            if (s.length + 1 > (destSizeChars ?? 0)) { Mem.writeUint16(dest, 0); setErrno(34); return 34; }
            Marshaler.writeWideString(mem, dest, s, destSizeChars ?? 0);
            return 0;
        };
        exports["wcscat_s"] = (_c, mem, args) => {
            const [dest, destSizeChars, src] = args;
            const cap = destSizeChars ?? 0;
            if (!dest || cap === 0) { setErrno(22); return 22; }
            // A bounded scan: dest not NUL-terminated within its OWN declared capacity is
            // invalid input, not something an unbounded readStringW should go hunting past
            // the buffer for.
            let have = -1;
            for (let i = 0; i < cap; i++) {
                if (Mem.readUint16(dest + i * 2) === 0) { have = i; break; }
            }
            if (have < 0) { setErrno(22); return 22; }
            if (!src) return 0;
            const add = Marshaler.readStringW(mem, src);
            if (have + add.length + 1 > cap) { Mem.writeUint16(dest, 0); setErrno(34); return 34; }
            Marshaler.writeWideString(mem, dest + have * 2, add, cap - have);
            return 0;
        };
        exports["wcsncpy_s"] = (_c, mem, args) => {
            const [dest, destSizeChars, src, count] = args;
            const cap = destSizeChars ?? 0;
            if (!dest || cap === 0) { setErrno(22); return 22; }
            if (!src) { Mem.writeUint16(dest, 0); setErrno(22); return 22; }
            const full = Marshaler.readStringW(mem, src);
            const wantTruncate = (count ?? 0) === _TRUNCATE;
            const copyLen = wantTruncate ? full.length : Math.min(full.length, count ?? 0);
            if (copyLen + 1 > cap) {
                if (wantTruncate) {
                    Marshaler.writeWideString(mem, dest, full.slice(0, cap - 1), cap);
                    setErrno(80 /* STRUNCATE */);
                    return 80;
                }
                Mem.writeUint16(dest, 0);
                setErrno(34);
                return 34;
            }
            Marshaler.writeWideString(mem, dest, full.slice(0, copyLen), cap);
            return 0;
        };

        // _vsnprintf_s/_vsnwprintf_s: format into a scratch buffer via the existing
        // (non-secure) printf engine, then apply the secure API's count/_TRUNCATE/
        // clear-on-failure rules ourselves — reusing the format engine without
        // re-deriving its semantics.
        exports["_vsnprintf_s"] = (_c, mem, args) => {
            const [dest, destSize, count, fmt, va] = args;
            const cap = destSize ?? 0;
            if (!dest || cap === 0) return -1;
            const scratchSize = 4096;
            const scratch = malloc(scratchSize);
            through("_vsnprintf", [scratch, scratchSize - 1, fmt, va]);
            const text = Marshaler.readString(mem, scratch);
            free(scratch);
            const wantTruncate = (count ?? 0) === _TRUNCATE;
            const limit = wantTruncate ? cap - 1 : Math.min(count ?? 0, cap - 1);
            if (text.length > limit) {
                if (wantTruncate) {
                    Marshaler.writeString(mem, dest, text.slice(0, limit), cap);
                    return -1;
                }
                Marshaler.writeString(mem, dest, "", cap);
                setErrno(34);
                return -1;
            }
            Marshaler.writeString(mem, dest, text, cap);
            return text.length;
        };
        exports["_vsnwprintf_s"] = (_c, mem, args) => {
            const [dest, destSize, count, fmt, va] = args;
            const cap = destSize ?? 0;
            if (!dest || cap === 0) return -1;
            const scratchChars = 4096;
            const scratch = malloc(scratchChars * 2);
            through("_vsnwprintf", [scratch, scratchChars - 1, fmt, va]);
            const text = Marshaler.readStringW(mem, scratch);
            free(scratch);
            const wantTruncate = (count ?? 0) === _TRUNCATE;
            const limit = wantTruncate ? cap - 1 : Math.min(count ?? 0, cap - 1);
            if (text.length > limit) {
                if (wantTruncate) {
                    Marshaler.writeWideString(mem, dest, text.slice(0, limit), cap);
                    return -1;
                }
                Mem.writeUint16(dest, 0);
                setErrno(34);
                return -1;
            }
            Marshaler.writeWideString(mem, dest, text, cap);
            return text.length;
        };

        exports["_itow_s"] = (_c, mem, args) => {
            const [value, buffer, sizeChars, radix] = args;
            const r = (radix ?? 10) >>> 0;
            // Radix 10 is signed; every other radix converts the unsigned bit pattern
            // (_itow_s(-1, ..., 16) is "ffffffff", not "-1").
            const s = r === 10 ? (value | 0).toString(10) : ((value ?? 0) >>> 0).toString(r);
            if (s.length + 1 > (sizeChars ?? 0)) { setErrno(34); return 34; }
            Marshaler.writeWideString(mem, buffer ?? 0, s, sizeChars ?? 0);
            return 0;
        };
        exports["_ultow_s"] = (_c, mem, args) => {
            const [value, buffer, sizeChars, radix] = args;
            const s = (value >>> 0).toString((radix ?? 10) >>> 0);
            if (s.length + 1 > (sizeChars ?? 0)) { setErrno(34); return 34; }
            Marshaler.writeWideString(mem, buffer ?? 0, s, sizeChars ?? 0);
            return 0;
        };
        exports["_i64toa_s"] = (_c, mem, args) => {
            const [lo, hi, buffer, sizeChars, radix] = args;
            const bits = (BigInt(hi ?? 0) << 32n) | BigInt((lo ?? 0) >>> 0); // unsigned 64-bit pattern
            const r = (radix ?? 10) >>> 0;
            // Radix 10 sign-extends the pattern; every other radix prints it unsigned, same
            // asymmetry as _itow_s above.
            const value = r === 10 && bits >= 0x8000000000000000n ? bits - 0x10000000000000000n : bits;
            const s = (r === 10 ? value : bits).toString(r);
            if (s.length + 1 > (sizeChars ?? 0)) { setErrno(34); return 34; }
            Marshaler.writeString(mem, buffer ?? 0, s, sizeChars ?? 0);
            return 0;
        };
        // Returned in EDX:EAX, same as _atoi64 (msvcrt.ts) — BigInt keeps full precision,
        // two's-complement masking gives correctly sign-extended halves.
        exports["_wtoi64"] = (_c, mem, args) => {
            const s = Marshaler.readStringW(mem, args[0] ?? 0).trim();
            const m = s.match(/^[+-]?\d+/);
            let v = 0n;
            if (m) { try { v = BigInt(m[0]); } catch { v = 0n; } }
            const reg = (process as any)?.dispatcher?.cachedReg32;
            if (reg) reg[2] = Number((v >> 32n) & 0xffffffffn) | 0;
            return Number(v & 0xffffffffn) | 0;
        };

        exports["asctime_s"] = (_c, mem, args) => {
            const [buffer, sizeBytes, tm] = args;
            if (!buffer || !tm || (sizeBytes ?? 0) < 26) { setErrno(22); return 22; }
            const sec = Mem.readUint32(tm + 0) ?? 0;
            const min = Mem.readUint32(tm + 4) ?? 0;
            const hour = Mem.readUint32(tm + 8) ?? 0;
            const mday = Mem.readUint32(tm + 12) ?? 0;
            const mon = Mem.readUint32(tm + 16) ?? 0;
            const tmYear = (Mem.readUint32(tm + 20) ?? 0) | 0; // signed: years before 1900 are negative
            const wday = Mem.readUint32(tm + 24) ?? 0;
            // Documented valid ranges (MSDN asctime_s) — reject BEFORE formatting, so an
            // out-of-range year (e.g. tm_year=8100 -> "10000") can never produce a string
            // longer than the 26-byte buffer this function promises never to overrun.
            const valid = sec <= 61 && min <= 59 && hour <= 23 && mday >= 1 && mday <= 31
                && mon <= 11 && tmYear >= -1900 && tmYear <= 8099 && wday <= 6;
            if (!valid) { setErrno(22); return 22; }
            const text = formatAsctime(wday, mon, mday, hour, min, sec, tmYear + 1900);
            if (text.length + 1 > (sizeBytes ?? 0)) { setErrno(34); return 34; }
            Marshaler.writeString(mem, buffer, text, sizeBytes ?? 0);
            return 0;
        };
        exports["_localtime64_s"] = (_c, mem, args) => {
            const [tmDest, timePtr] = args;
            if (!tmDest || !timePtr) { if (tmDest) through("memset", [tmDest, 0, 36]); setErrno(22); return 22; }
            // __time64_t is a signed 64-bit count of seconds — reading only the low dword
            // wraps every date past 2106 and turns negative (pre-1970) timestamps positive.
            const lo = Mem.readUint32(timePtr + 0) ?? 0;
            const hi = Mem.readUint32(timePtr + 4) ?? 0;
            let seconds = (BigInt(hi) << 32n) | BigInt(lo >>> 0);
            if (seconds >= 0x8000000000000000n) seconds -= 0x10000000000000000n;
            if (seconds < 0n) { through("memset", [tmDest, 0, 36]); setErrno(22); return 22; }
            const date = new Date(Number(seconds) * 1000);
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
        exports["_wstrtime_s"] = (_c, mem, args) => {
            const [buffer, sizeChars] = args;
            if ((sizeChars ?? 0) < 9) { setErrno(34); return 34; }
            const d = new Date();
            const s = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
            Marshaler.writeWideString(mem, buffer ?? 0, s, sizeChars ?? 0);
            return 0;
        };

        exports["fopen_s"] = (_c, mem, args) => {
            const [pFile, filename, mode] = args;
            const fp = through("fopen", [filename, mode]);
            if (pFile) Mem.writeUint32(pFile, fp >>> 0);
            return fp ? 0 : 2; // ENOENT
        };
        // msvcrt already has a real _wfopen that takes the WIDE pointers directly — no
        // narrow scratch buffer, no ANSI round trip, no filename-length limit.
        exports["_wfopen_s"] = (_c, mem, args) => {
            const [pFile, filename, mode] = args;
            const fp = through("_wfopen", [filename, mode]);
            if (pFile) Mem.writeUint32(pFile, fp >>> 0);
            return fp ? 0 : 2;
        };

        // Wide-char filesystem calls with no wide-native cousin to delegate to: decode to a
        // BOUNDED narrow scratch buffer and delegate to the ANSI implementation already in
        // msvcrt (same VFS, same current directory). Bounded to 260 bytes so an overlong or
        // non-ANSI-representable path truncates instead of overrunning the scratch block;
        // see _wfopen_s above for the unbounded, non-lossy alternative where one exists.
        const withNarrowPath = (mem: Uint8Array, widePtr: number, fn: (narrowPtr: number) => number): number => {
            const buf = malloc(260);
            Marshaler.writeString(mem, buf, Marshaler.readStringW(mem, widePtr), 260);
            const result = fn(buf);
            free(buf);
            return result;
        };
        exports["_wmkdir"] = (_c, mem, args) => withNarrowPath(mem, args[0] ?? 0, (p) => through("_mkdir", [p]));
        exports["_wchdir"] = (_c, mem, args) => withNarrowPath(mem, args[0] ?? 0, (p) => through("_chdir", [p]));
        exports["_wremove"] = (_c, mem, args) => withNarrowPath(mem, args[0] ?? 0, (p) => through("remove", [p]));
        exports["_wrename"] = (_c, mem, args) => {
            const oldBuf = malloc(260);
            const newBuf = malloc(260);
            Marshaler.writeString(mem, oldBuf, Marshaler.readStringW(mem, args[0] ?? 0), 260);
            Marshaler.writeString(mem, newBuf, Marshaler.readStringW(mem, args[1] ?? 0), 260);
            const result = through("rename", [oldBuf, newBuf]);
            free(oldBuf);
            free(newBuf);
            return result;
        };
        exports["_wgetcwd"] = (_c, mem, args) => {
            const [bufferArg, maxLenChars] = args;
            const narrow = through("_getcwd", [0, 260]); // NULL buffer + positive maxLen: CRT mallocs its own
            if (!narrow) return 0; // errno already set by _getcwd
            const cwd = Marshaler.readString(mem, narrow);
            free(narrow);
            const needed = cwd.length + 1;
            if (!bufferArg) {
                // Allocating form: _wgetcwd(NULL, maxlen) mallocs a buffer sized to fit
                // both the caller's requested capacity and the actual path.
                if ((maxLenChars ?? 0) <= 0) { setErrno(22); return 0; }
                const capChars = Math.max(maxLenChars ?? 0, needed);
                const buffer = malloc(capChars * 2);
                if (!buffer) { setErrno(12 /* ENOMEM */); return 0; }
                Marshaler.writeWideString(mem, buffer, cwd, capChars);
                return buffer;
            }
            if (needed > (maxLenChars ?? 0)) { setErrno(34); return 0; }
            Marshaler.writeWideString(mem, bufferArg, cwd, maxLenChars ?? 0);
            return bufferArg;
        };

        // _wfindfirst64i32/_wfindnext64i32: real VFS directory enumeration, mirroring
        // crt-vc9-io.ts's ANSI _findfirst64i32/_findnext64i32 (same filespec parsing,
        // wildcard matching, and _finddata64i32_t layout — FINDDATA64I32_OFFSETS is shared)
        // but writing a WIDE name field and keeping its own handle space, since the ANSI
        // implementation's cursor map is private to that module.
        const parseWideFilespec = (filespec: string): { dir: string; pattern: string } => {
            const normalized = filespec.replace(/\//g, "\\");
            const slash = normalized.lastIndexOf("\\");
            if (slash < 0) {
                const driveRelative = normalized.match(/^([A-Za-z]:)(.*)$/);
                if (driveRelative) return { dir: driveRelative[1]!, pattern: driveRelative[2] || "*" };
                return { dir: ".", pattern: normalized };
            }
            const dir = normalized.slice(0, slash);
            const pattern = normalized.slice(slash + 1);
            if (dir === "") return { dir: "\\", pattern };
            if (/^[A-Za-z]:$/.test(dir)) return { dir: `${dir}\\`, pattern };
            return { dir, pattern };
        };
        const matchWideWildcard = (name: string, pattern: string): boolean => {
            if (pattern === "*" || pattern === "*.*") return true;
            const re = new RegExp(
                "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
                "i",
            );
            return re.test(name);
        };
        const fillWideFindData64i32 = (mem: Uint8Array, structPtr: number, entry: VfsEntry): void => {
            const A_SUBDIR = 0x10, A_ARCH = 0x20;
            Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.attrib, entry.kind === "dir" ? A_SUBDIR : A_ARCH);
            const time = unixTimeOf(entry);
            Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.time_create, time);
            Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.time_create + 4, 0);
            Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.time_access, time);
            Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.time_access + 4, 0);
            Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.time_write, time);
            Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.time_write + 4, 0);
            Mem.writeUint32(structPtr + FINDDATA64I32_OFFSETS.size, entry.size >>> 0);
            Marshaler.writeWideString(mem, structPtr + FINDDATA64I32_OFFSETS.name, entry.name, 260);
        };
        exports["_wfindfirst64i32"] = (_c, mem, args) => {
            const [filespecPtr, dataPtr] = args;
            if (!filespecPtr || !dataPtr) { setErrno(22); return -1; }
            const { dir, pattern } = parseWideFilespec(Marshaler.readStringW(mem, filespecPtr));
            const vfs = System.getInstance().fileSystem;
            const searchDir = dir === "." ? vfs.currentDir : dir;
            let matched: VfsEntry[];
            if (pattern && !/[*?]/.test(pattern)) {
                const entry = vfs.statEntry(searchDir.endsWith("\\") ? searchDir + pattern : `${searchDir}\\${pattern}`);
                matched = entry ? [entry] : [];
            } else {
                matched = vfs.listDirectory(searchDir).filter((e) => matchWideWildcard(e.name, pattern));
            }
            if (matched.length === 0) { setErrno(2); return -1; }
            const handle = this.nextWideFindHandle++;
            this.wideFindHandles.set(handle, { entries: matched, index: 0 });
            fillWideFindData64i32(mem, dataPtr, matched[0]!);
            return handle;
        };
        exports["_wfindnext64i32"] = (_c, mem, args) => {
            const [handle, dataPtr] = args;
            const state = this.wideFindHandles.get(handle ?? 0);
            if (!state || !dataPtr) { setErrno(18 /* ENMFILE */); return -1; }
            state.index++;
            if (state.index >= state.entries.length) { setErrno(18); return -1; }
            fillWideFindData64i32(mem, dataPtr, state.entries[state.index]!);
            return 0;
        };
        // Overrides the PROXIED_NAMES forward above: a wide find handle lives in this
        // module's own map, not msvcrt's ANSI one, so the shared _findclose must check here
        // first.
        exports["_findclose"] = (ctx, mem, args) => {
            const handle = args[0] ?? 0;
            if (this.wideFindHandles.has(handle)) { this.wideFindHandles.delete(handle); return 0; }
            return msvcrt.exports["_findclose"]?.(ctx, mem, args) ?? 0;
        };

        // wctype/locale odds and ends with no existing cousin to wrap.
        exports["wcscspn"] = (_c, mem, args) => {
            const s = Marshaler.readStringW(mem, args[0] ?? 0);
            const rejectStr = Marshaler.readStringW(mem, args[1] ?? 0);
            // Built from individual UTF-16 CODE UNITS (wchar_t), not new Set(string)'s
            // code-POINT iteration — a surrogate half must match on its own, as wcscspn
            // operates on wchar_t, not Unicode scalar values.
            const reject = new Set<string>();
            for (let i = 0; i < rejectStr.length; i++) reject.add(rejectStr[i]!);
            let i = 0;
            while (i < s.length && !reject.has(s[i]!)) i++;
            return i;
        };
        exports["wcstod"] = (_c, mem, args) => {
            const full = Marshaler.readStringW(mem, args[0] ?? 0);
            const trimmed = full.replace(/^\s+/, "");
            const leadingWs = full.length - trimmed.length;
            const m = trimmed.match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
            const v = m ? parseFloat(m[0]) : NaN;
            const endPtr = args[1] ?? 0;
            if (endPtr) {
                const consumed = m ? leadingWs + m[0].length : 0;
                Mem.writeUint32(endPtr, (args[0] ?? 0) + consumed * 2);
            }
            // A double returns through the x87 stack, not EAX — the dispatcher never
            // converts a numeric handler return into an FPU push for us (same reason
            // crt-conv.ts's strtod calls fpuPush directly rather than `return value`).
            fpuPush(process.v86, Number.isNaN(v) ? 0 : v);
            return 0;
        };
        exports["mbtowc"] = (_c, mem, args) => {
            const [wcharOut, src, n] = args;
            if (!src) return 0; // stateless converter: no shift state pending
            if ((n ?? 0) <= 0) return -1; // not enough bytes to inspect
            const byte = mem[src];
            if (byte === undefined) return -1;
            if (wcharOut) Mem.writeUint16(wcharOut, byte);
            return byte === 0 ? 0 : 1;
        };
        exports["wctomb_s"] = (_c, mem, args) => {
            const [sizeWritten, dest, destSize, wchar] = args;
            const ch = String.fromCharCode((wchar ?? 0) & 0xffff);
            const encoded = encodeAnsiString(ch, EmulatorConfig.getInstance().ansiCodePage);
            if (encoded.length === 0) { setErrno(42 /* EILSEQ */); return 42; }
            if (!dest) {
                // mbchar==NULL is a size query: report the required byte count, write nothing.
                if (sizeWritten) Mem.writeUint32(sizeWritten, encoded.length);
                return 0;
            }
            if (encoded.length > (destSize ?? 0)) { setErrno(34); return 34; }
            for (let i = 0; i < encoded.length; i++) mem[dest + i] = encoded[i]!;
            if (sizeWritten) Mem.writeUint32(sizeWritten, encoded.length);
            return 0;
        };
        exports["wcstombs_s"] = (_c, mem, args) => {
            const [sizeConvertedPtr, dest, destSizeBytes, src, maxCount] = args;
            const full = Marshaler.readStringW(mem, src ?? 0);
            const wantTruncate = (maxCount ?? 0) === _TRUNCATE;
            const limit = wantTruncate ? full.length : Math.min(full.length, maxCount ?? full.length);
            const encoded = encodeAnsiString(full.slice(0, limit), EmulatorConfig.getInstance().ansiCodePage);
            if (!dest) {
                if (sizeConvertedPtr) Mem.writeUint32(sizeConvertedPtr, encoded.length + 1);
                return 0;
            }
            const cap = destSizeBytes ?? 0;
            if (encoded.length + 1 > cap) {
                if (wantTruncate && cap > 0) {
                    const fit = cap - 1;
                    for (let i = 0; i < fit; i++) mem[dest + i] = encoded[i]!;
                    mem[dest + fit] = 0;
                    if (sizeConvertedPtr) Mem.writeUint32(sizeConvertedPtr, fit + 1);
                    setErrno(80 /* STRUNCATE */);
                    return 80;
                }
                if (cap > 0) mem[dest] = 0;
                setErrno(34);
                return 34;
            }
            for (let i = 0; i < encoded.length; i++) mem[dest + i] = encoded[i]!;
            mem[dest + encoded.length] = 0;
            if (sizeConvertedPtr) Mem.writeUint32(sizeConvertedPtr, encoded.length + 1);
            return 0;
        };

        exports["?_set_se_translator@@YAP6AXIPAU_EXCEPTION_POINTERS@@@ZP6AXI0@Z@Z"] = () => 0;
        exports["_calloc_crt"] = (_c, _m, args) => through("calloc", [args[0] ?? 0, args[1] ?? 0]);
        exports["_lock_file"] = () => 0;
        exports["_unlock_file"] = () => 0;
        exports["_gcvt_s"] = (_c, mem, args) => {
            // Thunk args are raw stack DWORDs, one per declared slot — an f64 param is TWO
            // dwords, not one. The descriptor declares (buffer, sizeInBytes, value:f64,
            // digits), so args is [buffer, sizeInBytes, valueLo, valueHi, digits]; reading
            // args[2] as the whole double and args[3] as digits (as earlier code did) hands
            // the double's low half to `value` and its high half to `digits`.
            const [buffer, sizeBytes, valueLo, valueHi, digits] = args;
            const buf = new ArrayBuffer(8);
            new Uint32Array(buf)[0] = valueLo ?? 0;
            new Uint32Array(buf)[1] = valueHi ?? 0;
            const value = new Float64Array(buf)[0]!;
            const s = gcvtFormat(value, (digits ?? 6) | 0);
            if (s.length + 1 > (sizeBytes ?? 0)) { setErrno(34); return 34; }
            Marshaler.writeString(mem, buffer ?? 0, s, sizeBytes ?? 0);
            return 0;
        };
        exports["_wcsnicoll"] = (_c, mem, args) => {
            const [s1, s2, n] = args;
            const a1 = Marshaler.readStringW(mem, s1 ?? 0).slice(0, n ?? 0).toLowerCase();
            const a2 = Marshaler.readStringW(mem, s2 ?? 0).slice(0, n ?? 0).toLowerCase();
            return a1 < a2 ? -1 : a1 > a2 ? 1 : 0;
        };
        // Returned in EDX:EAX, same convention as _wtoi64 above — BigInt parsing keeps full
        // 64-bit precision and both halves get published, unlike parseInt's double-backed
        // truncation.
        exports["_wcstoui64"] = (_c, mem, args) => {
            const [strPtr, endPtr, baseArg] = args;
            const full = Marshaler.readStringW(mem, strPtr ?? 0);
            let i = 0;
            while (i < full.length && /\s/.test(full[i]!)) i++;
            let negative = false;
            if (full[i] === "+" || full[i] === "-") { negative = full[i] === "-"; i++; }
            let base = (baseArg ?? 0) >>> 0;
            if (base === 0) {
                if (full[i] === "0" && (full[i + 1] === "x" || full[i + 1] === "X")) { base = 16; i += 2; }
                else if (full[i] === "0") { base = 8; i++; }
                else base = 10;
            } else if (base === 16 && full[i] === "0" && (full[i + 1] === "x" || full[i + 1] === "X")) {
                i += 2;
            }
            const digitsStart = i;
            let value = 0n;
            const bigBase = BigInt(base || 10);
            while (i < full.length) {
                const c = full[i]!.toLowerCase();
                const digit = c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c >= "a" && c <= "z" ? c.charCodeAt(0) - 87 : -1;
                if (digit < 0 || digit >= base) break;
                value = value * bigBase + BigInt(digit);
                i++;
            }
            const consumedTo = i === digitsStart ? 0 : i; // nothing valid consumed: *endptr stays at nptr
            if (negative) value = -value;
            value &= 0xffffffffffffffffn;
            if (endPtr) Mem.writeUint32(endPtr, (strPtr ?? 0) + consumedTo * 2);
            const reg = (process as any)?.dispatcher?.cachedReg32;
            if (reg) reg[2] = Number((value >> 32n) & 0xffffffffn) | 0;
            return Number(value & 0xffffffffn) | 0;
        };

        // Rarely-exercised wide text I/O: no existing FILE*-level wide-char plumbing to
        // build on yet. Fail cleanly (EOF/NULL) rather than fabricate success.
        exports["fgetws"] = () => 0;
        exports["fputws"] = () => -1; // WEOF
        exports["fwprintf"] = () => -1;
        // swprintf_s(buffer, sizeInWords, format, ...) — unlike _vsnwprintf's va_list
        // pointer, the variadic args sit directly on the caller's stack right after the
        // three named params; that address IS a valid va_list, so pass it as one.
        exports["swprintf_s"] = (ctx, mem, args) => {
            const [dest, sizeChars, fmt] = args;
            const vaList = ctx.esp + 4 + 3 * 4;
            const r = through("_vsnwprintf", [dest, sizeChars, fmt, vaList]);
            // On failure _vsnwprintf still writes a truncated string (and returns -1) — the
            // secure API must discard that partial output, not forward it.
            if (r < 0) {
                if ((sizeChars ?? 0) > 0) Mem.writeUint16(dest, 0);
                setErrno(34);
            }
            return r;
        };
    }
}
