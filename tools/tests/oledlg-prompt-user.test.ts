/**
 * OleUIPromptUser is variadic, so the loader must see it as __cdecl with a known (fixed)
 * argument count. With no count, the import stub cannot be generated and the importing DLL
 * fails to load: Rise of Nations' unicows.dll did, 11 times per boot.
 */

import { expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";

const registry = APIRegistry.getInstance();

for (const name of ["OleUIPromptUserA", "OleUIPromptUserW"]) {
    test(`${name} binds as __cdecl: the caller pops the variadic arguments`, () => {
        expect(registry.getArgCount("oledlg", name)).toBe(2);
        expect(registry.getCallingConvention("oledlg", name)).toBe("cdecl");
    });
}
