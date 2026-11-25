/**
 * Neutralizes Macrovision SafeDisc v2.x's "A debugger has been detected" dialog in the
 * authentication-runtime DLL it drops to a per-process temp folder at startup (named
 * `~XXXXXX.tmp`; this is the module built around the `CModuleMonitor`/`CJumpRun` classes,
 * not the sibling CJumpRun-dispatcher drop).
 *
 * Root-caused by decompiling the live module (Ghidra, via tools/re/): the dialog is gated by
 * one generic error-reporter, `CErrorReporter::Report`-equivalent at RVA 0x1bdf0, whose own
 * logic already has a legitimate "stay silent" path —
 *
 *   if (param_4 != 0 && suppressFlag == 0) return ShowMessageBox(...);
 *   return 1;
 *
 * — where `suppressFlag` is only ever set by successfully opening a cross-process shared
 * memory mapping named `SAFEDISC_ERROR_%08lx` (the live PID). Nothing creates that mapping:
 * not this DLL, not its sibling drop, not secdrv.sys (decompiled separately — see
 * file-io-secdrv.ts), not generals.exe. The mapping was Macrovision's own authentication
 * client's job, and that service has been offline since the company's 2009 shutdown — so on
 * *any* current OS, with or without SafeDisc's long-defunct secdrv.sys even installed, this
 * exact function reaches the exact same unreachable branch. A legitimately-owned disc has no
 * more ability to satisfy it than we do.
 *
 * This patches the reporter's prologue in place to take the path it would already take if that
 * dead infrastructure still existed (`return 1` — i.e. unconditionally suppressed), rather than
 * reinventing a parallel IPC mechanism nothing else in the system would ever populate. Detected
 * purely by content (the function's first 10 bytes are register-only — no embedded absolute
 * addresses — so the signature survives this relocatable DLL loading at a different base every
 * run); nothing here is keyed to Generals/Zero Hour, so any title dropping this exact SafeDisc
 * runtime build benefits identically.
 */

import { registerNativeModulePatcher } from '../../core/hooks/native-module-patchers';
import { writeGuestCode } from '../../core/memory/guest-code';
import { toPlainGuestMemory } from '../../core/memory/guest-memory';
import { Logger, LogCategory } from '../../core/logger';
import type { LoadedPEModule } from '../../core/module-registry';
import type { Process } from '../../core/process';

const REPORTER_RVA = 0x1bdf0;

// `sub esp,0x638; push ebx; push ebp; push esi; push edi` — register-opcode bytes only, no
// relocation-dependent immediates, so this is stable across loads at any base.
// @transient(constant byte pattern, never mutated)
const REPORTER_SIGNATURE = new Uint8Array([0x81, 0xec, 0x38, 0x06, 0x00, 0x00, 0x53, 0x55, 0x56, 0x57]);

// `mov eax,1; ret` — cdecl, caller cleans the stack, so a bare RET is correct.
// @transient(constant byte pattern, never mutated)
const SUPPRESSED_RETURN = new Uint8Array([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3]);

function isDroppedSafeDiscTemp(module: LoadedPEModule): boolean {
    return /\\~[0-9a-f]{6}\.tmp$/i.test(module.path) && module.size > REPORTER_RVA + REPORTER_SIGNATURE.length;
}

function signatureMatches(mem: Uint8Array, addr: number): boolean {
    if (addr + REPORTER_SIGNATURE.length > mem.length) return false;
    for (let i = 0; i < REPORTER_SIGNATURE.length; i++) {
        if (mem[addr + i] !== REPORTER_SIGNATURE[i]) return false;
    }
    return true;
}

export function patchSafeDiscAntiDebugReporter(process: Process, module: LoadedPEModule): boolean {
    if (!isDroppedSafeDiscTemp(module)) return false;
    const rawMem = process.getCurrentMemory();
    if (!rawMem) return false;
    const mem = toPlainGuestMemory(rawMem);
    const addr = (module.baseAddress + REPORTER_RVA) >>> 0;
    if (!signatureMatches(mem, addr)) return false;
    const ok = writeGuestCode(mem, SUPPRESSED_RETURN, addr);
    if (ok) {
        Logger.log(LogCategory.SYSTEM,
            `[safedisc-anti-debug] neutralized dead-infrastructure error reporter in "${module.name}" ` +
            `at 0x${addr.toString(16)} (unreachable suppression path on any current OS)`);
    }
    return ok;
}

registerNativeModulePatcher({
    id: 'safedisc-anti-debug',
    patch: patchSafeDiscAntiDebugReporter,
});
