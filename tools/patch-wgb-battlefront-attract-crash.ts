#!/usr/bin/env bun
/**
 * Patch rom/Battlefront.exe inside a Star Wars Battlefront (2004, Pandemic/LucasArts)
 * .wgb bundle to fix a retail null-pointer crash in the main menu's attract-mode path.
 *
 * Root cause (confirmed via live SEH-dispatch tracing against the real retail binary,
 * see https://github.com/ievans/bottleship/issues/17): the menu idles for roughly
 * 20-30 real seconds, then the game's own scripted "attract mode" (its own debug string
 * is literally "Attract mode launching %s\n") opens a background Bink video on the same
 * long-lived menu-controller object. That object guards its per-frame update on whether
 * `this+0x2d0` is set, but never also checks `this+0x2c8` — a separate, independently-set
 * companion field — before reading a float out of it. The two fields can legitimately be
 * set at different times; when `+0x2d0` is set first, the next frame's update dereferences
 * a still-null `+0x2c8` and the process dies with an unhandled access violation at
 * `battlefront.exe+0x2C02A0` (an `FLD dword ptr [ECX+0x18]` leaf with `ECX=0`). Confirmed
 * live: the game's own two installed SEH frames are correctly found and invoked by
 * BottleShip's dispatcher and both legitimately decline, so this is not an emulation
 * fidelity bug — it is a genuine defect in the shipped executable, independent of what
 * emulator or hardware is running it.
 *
 * The fix: redirect that 4-byte leaf function through a tiny code cave (built from the
 * 12 bytes of INT3 padding already following it — nothing else moves) that null-checks
 * ECX first and returns 0.0 instead of crashing. This is the same category of per-bundle
 * fix as patch-wgb-vram.ts: it patches THIS game's own shipped binary, not BottleShip's
 * emulator, so it carries no "per-game branch" in shared engine code.
 *
 * Usage:
 *   bun tools/patch-wgb-battlefront-attract-crash.ts <input.wgb> [--output <path>]
 *
 * Verified (patched test bundle, two full runs, "crash": null both times, screenshots
 * showing real interactive Profile Selection / player-creation menu screens):
 *   bun tools/harness.ts run <script that reaches the menu and holds 35s>
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const EXE_ENTRY = "rom/Battlefront.exe";

// File offset of the crashing leaf, computed once from the PE section table (.text:
// VA 0x401000, file offset 0x400 — RVA 0x2C02A0 lands at file offset 0x2BF6A0).
const PATCH_FILE_OFFSET = 0x2bf6a0;

// Exactly what a stock retail Battlefront.exe holds there: the crashing leaf
// (FLD dword ptr [ECX+0x18]; RET — 4 bytes) followed by 12 bytes of INT3 padding
// before the next function. Patching refuses if this doesn't match — a different
// build/version of the exe would need its own offset, not a silent wrong patch.
const EXPECTED_ORIGINAL = Buffer.from("d94118c3cccccccccccccccccccccccc", "hex");

// JMP rel32=0 (falls straight into the cave that follows) + the cave itself:
//   test ecx,ecx        ; 85 c9
//   jnz safe            ; 75 03
//   fldz                ; d9 ee      (ECX==0: answer 0.0 instead of dereferencing it)
//   ret                 ; c3
//   safe: fld [ecx+0x18]; d9 41 18   (original instruction, byte-identical)
//   ret                 ; c3
const PATCHED_BYTES = Buffer.from("e900000000" + "85c9" + "7503" + "d9ee" + "c3" + "d94118" + "c3", "hex");

function usage(): never {
    console.error("Usage: bun tools/patch-wgb-battlefront-attract-crash.ts <input.wgb> [--output <path>]");
    process.exit(1);
}

function main(): void {
    const args = process.argv.slice(2);
    const input = args[0];
    if (!input) usage();
    const outFlagIdx = args.indexOf("--output");
    const output = outFlagIdx >= 0 ? args[outFlagIdx + 1] : input;
    if (outFlagIdx >= 0 && !output) usage();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-attract-patch-"));
    const exePath = path.join(tmpDir, "Battlefront.exe");

    console.log(`Extracting ${EXE_ENTRY} from ${input}...`);
    execFileSync("bun", ["tools/wgb.ts", "extract", input, EXE_ENTRY, exePath], { stdio: "inherit" });

    const data = fs.readFileSync(exePath);
    const slice = data.subarray(PATCH_FILE_OFFSET, PATCH_FILE_OFFSET + EXPECTED_ORIGINAL.length);

    if (slice.equals(PATCHED_BYTES.subarray(0, slice.length)) === false && slice.equals(EXPECTED_ORIGINAL) === false) {
        console.error(
            `Refusing to patch: bytes at file offset 0x${PATCH_FILE_OFFSET.toString(16)} don't match the ` +
            `known retail Battlefront.exe (got ${slice.toString("hex")}, expected ${EXPECTED_ORIGINAL.toString("hex")}). ` +
            "This looks like a different build/version — patching blind would corrupt it."
        );
        process.exit(1);
    }
    if (slice.equals(PATCHED_BYTES)) {
        console.log("Already patched — nothing to do.");
        if (output !== input) fs.copyFileSync(input, output);
        return;
    }

    PATCHED_BYTES.copy(data, PATCH_FILE_OFFSET);
    fs.writeFileSync(exePath, data);

    console.log(`Writing patched exe back into ${output}...`);
    const replaceArgs = output === input
        ? ["tools/wgb.ts", "replace", input, EXE_ENTRY, exePath]
        : ["tools/wgb.ts", "replace", input, EXE_ENTRY, exePath, output];
    execFileSync("bun", replaceArgs, { stdio: "inherit" });

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`Done. Patched ${PATCH_FILE_OFFSET.toString(16)}: attract-mode null-deref crash fixed.`);
}

main();
