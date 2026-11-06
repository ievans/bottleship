/**
 * Every import of a DLL needs a known argument count, or its stub cannot be generated and the
 * whole DLL fails to load. These are the ones Rise of Nations' unicows.dll (the Microsoft Layer
 * for Unicode) imports that had none, each of which made it fail to load on every boot.
 */

import { expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";

const registry = APIRegistry.getInstance();

// Variadic, so __cdecl: the caller pops whatever it pushed.
for (const name of ["OleUIPromptUserA", "OleUIPromptUserW"]) {
    test(`oledlg:${name} binds as __cdecl with its two fixed arguments`, () => {
        expect(registry.getArgCount("oledlg", name)).toBe(2);
        expect(registry.getCallingConvention("oledlg", name)).toBe("cdecl");
    });
}

for (const [name, args] of [
    ["capCreateCaptureWindowA", 8], ["capCreateCaptureWindowW", 8],
    ["capGetDriverDescriptionA", 5], ["capGetDriverDescriptionW", 5],
] as const) {
    test(`avicap32:${name} pops ${args * 4} bytes`, () => {
        expect(registry.getArgCount("avicap32", name)).toBe(args);
        expect(registry.getStackCleanupBytes("avicap32", name)).toBe(args * 4);
    });
}
