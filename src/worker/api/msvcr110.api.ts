import { FunctionDescriptor } from "./types";

const buildParams = (count: number) => {
    const params = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" as const });
    }
    return params;
};

const f = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "cdecl",
    ...overrides,
});

/**
 * VC++2012 (MSVCR110) additions over the legacy msvcrt.dll surface msvcrtModule already
 * declares: the later `_s` bounds-checked family, wide-char filesystem calls, and the
 * CRT-startup internals VC110 refactored out of the inline startup sequence.
 *
 * __crtTerminateProcess/__crtUnhandledException/__crtSetUnhandledExceptionFilter/
 * __crtGetShowWindowMode are all plain cdecl despite the double-underscore.
 */
/**
 * NOTE: msvcr70…msvcr120 all alias to the "msvcrt" HLE module (see MSVCR_VERSIONED in
 * dll-aliases.ts) — a real MSVCR110.dll import never reaches a module named "msvcr110".
 * These are merged into msvcrt's own descriptor (api-registry.ts) and handler map
 * (emulator.worker.ts) rather than registered as a separate, unreachable module.
 */
export const vc110Extras: FunctionDescriptor[] = [
    f("__crtGetShowWindowMode", 0),
    f("__crtSetUnhandledExceptionFilter", 1),
    f("__crtUnhandledException", 1),
    f("__crtTerminateProcess", 1, { returnType: "void" }),

    f("memcpy_s", 4),
    f("wcscpy_s", 3),
    f("wcscat_s", 3),
    f("wcsncpy_s", 4),
    f("_vsnprintf_s", 5),
    f("_vsnwprintf_s", 5),
    f("swprintf_s", 16), // (buffer, sizeInWords, format, ...) — variadic, like sprintf/printf above
    f("_itow_s", 4),
    f("_ultow_s", 4),
    // (lo, hi, buffer, sizeInCharacters, radix) — __int64 by value as two u32 stack slots,
    // same convention as the existing _i64toa (msvcrt.api.ts).
    f("_i64toa_s", 5),
    f("_wtoi64", 1),

    f("asctime_s", 3),
    f("_localtime64_s", 2),
    f("_wstrtime_s", 2),

    f("fopen_s", 3),
    f("_wfopen_s", 3),
    f("_wmkdir", 1),
    f("_wchdir", 1),
    f("_wremove", 1),
    f("_wrename", 2),
    f("_wgetcwd", 2),
    f("_wfindfirst64i32", 2),
    f("_wfindnext64i32", 2),

    f("wcscspn", 2),
    f("wcstod", 2),
    f("mbtowc", 3),
    f("wctomb_s", 4),
    f("wcstombs_s", 5),

    f("?_set_se_translator@@YAP6AXIPAU_EXCEPTION_POINTERS@@@ZP6AXI0@Z@Z", 1),
    f("_calloc_crt", 2),
    f("_lock_file", 1),
    f("_unlock_file", 1),
    f("_gcvt_s", 4, { params: [
        { name: "buffer", type: "u32" }, { name: "sizeInBytes", type: "u32" },
        { name: "value", type: "f64" }, { name: "digits", type: "u32" },
    ] }),
    f("_wcsnicoll", 3),
    f("_wcstoui64", 3),

    f("fgetws", 3),
    f("fputws", 2),
    f("fwprintf", 16),
];
