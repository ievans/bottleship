#!/usr/bin/env bun
/**
 * Patch rom/Battlefront.exe inside a Star Wars Battlefront (2004, Pandemic/LucasArts)
 * .wgb bundle to fix a retail hang reached once a profile is successfully confirmed
 * at the "Profile Selection" screen (requires
 * tools/patch-wgb-battlefront-profile-save-race.ts applied first — that fix is
 * what makes this code path reachable at all).
 *
 * Root cause (confirmed live): once a profile load actually proceeds,
 * battlefront.exe+0x143cc5 fires a sequence of eight independent, parameterless
 * "notify subsystem" calls with no return values used — generic game-state-change
 * broadcast. One of them (battlefront.exe+0x1120d5, thunking to the listener
 * walk at 0x137930) iterates a global listener list at `0x8a4944`. One entry in
 * that list has a null vtable pointer (confirmed via SEH-dispatch tracing,
 * faultAddr=0xc — a genuine retail bug, same class as the already-merged
 * attract-mode crash). Null-checking that one call (an earlier version of this
 * fix) avoids the crash but then the list's OWN "next" pointer never reaches the
 * iteration's starting sentinel again — confirmed live via repeated EIP sampling
 * pinned to the same instruction while retired-instruction count climbs by
 * hundreds of millions per second: the list is genuinely circular/corrupted,
 * independent of the null entry, and surviving one bad entry just exposes the
 * cycle instead of fixing it.
 *
 * The fix here is simpler and lower-risk: don't walk that list at all. The
 * call this patches (battlefront.exe+0x143cc5) is one of eight sibling
 * notification calls in a sequence where none of the others' return values are
 * checked either — this is pure side-effect broadcast (symbol hints point to
 * a stats/telemetry listener group, e.g. "time played" tracking), unrelated to
 * the actual profile-confirm logic. Skipping it entirely avoids the corrupted
 * list without touching anything the menu transition depends on.
 *
 * Usage:
 *   bun tools/patch-wgb-battlefront-listener-null-crash.ts <input.wgb> [--output <path>]
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const EXE_ENTRY = "rom/Battlefront.exe";

// VA 0x543cc5 -> .text VA 0x401000 = file offset 0x400, so RVA 0x143cc5
// lands at file offset 0x1430c5.
const CALL_OFFSET = 0x1430c5;
const CALL_ORIGINAL = Buffer.from("e80be4ecff", "hex"); // call 0x4120d5
const CALL_PATCHED = Buffer.from("9090909090", "hex");  // 5x nop — skip the call entirely

function usage(): never {
    console.error("Usage: bun tools/patch-wgb-battlefront-listener-null-crash.ts <input.wgb> [--output <path>]");
    process.exit(1);
}

function main(): void {
    const args = process.argv.slice(2);
    const input = args[0];
    if (!input) usage();
    const outFlagIdx = args.indexOf("--output");
    const output = outFlagIdx >= 0 ? args[outFlagIdx + 1] : input;
    if (outFlagIdx >= 0 && !output) usage();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-listenerskip-patch-"));
    const exePath = path.join(tmpDir, "Battlefront.exe");
    console.log(`Extracting ${EXE_ENTRY} from ${input}...`);
    execFileSync("bun", ["tools/wgb.ts", "extract", input, EXE_ENTRY, exePath], { stdio: "inherit" });

    const data = fs.readFileSync(exePath);
    const slice = data.subarray(CALL_OFFSET, CALL_OFFSET + CALL_ORIGINAL.length);
    if (slice.equals(CALL_PATCHED)) {
        console.log("Already patched — nothing to do.");
        if (output !== input) fs.copyFileSync(input, output);
        return;
    }
    if (!slice.equals(CALL_ORIGINAL)) {
        console.error(
            `Refusing to patch: bytes at file offset 0x${CALL_OFFSET.toString(16)} don't match the known ` +
            `retail Battlefront.exe (got ${slice.toString("hex")}, expected ${CALL_ORIGINAL.toString("hex")}). ` +
            "This looks like a different build/version, or an earlier (unsafe) version of this patch — " +
            "patching blind would corrupt it."
        );
        process.exit(1);
    }

    CALL_PATCHED.copy(data, CALL_OFFSET);
    fs.writeFileSync(exePath, data);

    console.log(`Writing patched exe back into ${output}...`);
    const replaceArgs = output === input
        ? ["tools/wgb.ts", "replace", input, EXE_ENTRY, exePath]
        : ["tools/wgb.ts", "replace", input, EXE_ENTRY, exePath, output];
    execFileSync("bun", replaceArgs, { stdio: "inherit" });

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`Done. Patched ${CALL_OFFSET.toString(16)}: skipped the corrupted listener-notification call.`);
}

main();
