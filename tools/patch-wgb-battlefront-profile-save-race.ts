#!/usr/bin/env bun
/**
 * Patch rom/Battlefront.exe inside a Star Wars Battlefront (2004, Pandemic/LucasArts)
 * .wgb bundle to fix a retail boot-time race in the save-system initializer
 * (battlefront.exe+0x146cee) that leaves profile/save data permanently
 * uninitialized, blocking the "Profile Selection" -> "Select Difficulty"
 * transition the very first time a profile is confirmed.
 *
 * Root cause (confirmed live): the initializer gates its real setup behind
 * `movzx eax, byte ptr [0x85ff40]` — a flag that is still 0 at the point this
 * code runs on every observed boot, so the save system never performs its
 * real setup. The fix forces the flag read to 1 (`mov eax,1`), letting the
 * initializer's own real setup logic run as it would once the flag is
 * legitimately set; the surrounding gated code and every other check are
 * untouched.
 *
 * Usage:
 *   bun tools/patch-wgb-battlefront-profile-save-race.ts <input.wgb> [--output <path>]
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const EXE_ENTRY = "rom/Battlefront.exe";
const PATCH_FILE_OFFSET = 0x1460ee;
const EXPECTED_ORIGINAL = Buffer.from("0fb60540ff8500", "hex");
const PATCHED_BYTES = Buffer.from("b8010000009090", "hex");

function usage(): never {
    console.error("Usage: bun tools/patch-wgb-battlefront-profile-save-race.ts <input.wgb> [--output <path>]");
    process.exit(1);
}

function main(): void {
    const args = process.argv.slice(2);
    const input = args[0];
    if (!input) usage();
    const outFlagIdx = args.indexOf("--output");
    const output = outFlagIdx >= 0 ? args[outFlagIdx + 1] : input;
    if (outFlagIdx >= 0 && !output) usage();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-saverace-patch-"));
    const exePath = path.join(tmpDir, "Battlefront.exe");
    execFileSync("bun", ["tools/wgb.ts", "extract", input, EXE_ENTRY, exePath], { stdio: "inherit" });

    const data = fs.readFileSync(exePath);
    const slice = data.subarray(PATCH_FILE_OFFSET, PATCH_FILE_OFFSET + EXPECTED_ORIGINAL.length);
    if (slice.equals(PATCHED_BYTES)) {
        console.log("Already patched — nothing to do.");
        if (output !== input) fs.copyFileSync(input, output);
        return;
    }
    if (!slice.equals(EXPECTED_ORIGINAL)) {
        console.error(`Refusing to patch: unexpected bytes at 0x${PATCH_FILE_OFFSET.toString(16)}: ${slice.toString("hex")}`);
        process.exit(1);
    }
    PATCHED_BYTES.copy(data, PATCH_FILE_OFFSET);
    fs.writeFileSync(exePath, data);
    const replaceArgs = output === input
        ? ["tools/wgb.ts", "replace", input, EXE_ENTRY, exePath]
        : ["tools/wgb.ts", "replace", input, EXE_ENTRY, exePath, output];
    execFileSync("bun", replaceArgs, { stdio: "inherit" });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log("Done.");
}
main();
