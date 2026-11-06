/**
 * HKCR\CLSID\{x}\TreatAs: CoCreateInstance follows it (CoGetTreatAsClass) to the CLSID
 * whose server and class object actually answer. Rise of Nations asks for the
 * version-independent Msxml2.DOMDocument, which only a versioned MSXML DLL serves.
 */

import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { resolveTreatAsClsid } from "../../src/worker/core/com/inproc-com";

const DOMDOCUMENT = "f6d90f11-9c73-11d3-b32e-00c04f990bb4";
const DOMDOCUMENT40 = "88d969c0-f192-11d4-a65f-0040963251e5";

function seedTreatAs(clsid: string, data: string): void {
    System.getInstance().registry.seed({
        root: "HKCR",
        path: `CLSID\\{${clsid}}\\TreatAs`,
        values: [{ name: "", type: "REG_SZ", data }],
    });
}

describe("resolveTreatAsClsid", () => {
    test("follows a braced, upper-case TreatAs value to the normalized target", () => {
        seedTreatAs(DOMDOCUMENT, `{${DOMDOCUMENT40.toUpperCase()}}`);
        expect(resolveTreatAsClsid(DOMDOCUMENT)).toBe(DOMDOCUMENT40);
        expect(resolveTreatAsClsid(`{${DOMDOCUMENT.toUpperCase()}}`)).toBe(DOMDOCUMENT40);
    });

    test("no TreatAs key leaves the class as requested", () => {
        expect(resolveTreatAsClsid("00000000-1111-2222-3333-444444444444")).toBeNull();
    });

    test("a malformed or self-referencing value is ignored", () => {
        seedTreatAs("11111111-1111-1111-1111-111111111111", "not-a-guid");
        expect(resolveTreatAsClsid("11111111-1111-1111-1111-111111111111")).toBeNull();
        seedTreatAs("22222222-2222-2222-2222-222222222222", "{22222222-2222-2222-2222-222222222222}");
        expect(resolveTreatAsClsid("22222222-2222-2222-2222-222222222222")).toBeNull();
    });
});
