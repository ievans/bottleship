import { describe, expect, test } from "bun:test";
import { vc110CppExtras } from "../../src/worker/api/msvcp110.api";

const byName = (name: string) => vc110CppExtras.find(f => f.name === name);

describe("msvcp110 ABI", () => {
    test("basic_ostream(streambuf*, bool) pops the hidden virtual-base flag too", () => {
        // A class with a virtual base gets a hidden trailing int on its constructors:
        // 2 declared params + 1 hidden = 12 bytes of callee cleanup.
        const ctor = byName("??0?$basic_ostream@DU?$char_traits@D@std@@@std@@QAE@PAV?$basic_streambuf@DU?$char_traits@D@std@@@1@_N@Z");
        expect(ctor?.stackCleanupBytes).toBe(12);
    });

    test("basic_ios is the virtual base itself, so its constructor takes no hidden flag", () => {
        expect(byName("??0?$basic_ios@DU?$char_traits@D@std@@@std@@IAE@XZ")?.stackCleanupBytes).toBe(0);
    });

    test("_Fiopen is declared: static __cdecl, the caller pops its 3 args", () => {
        const fiopen = byName("?_Fiopen@std@@YAPAU_iobuf@@PBDHH@Z");
        expect(fiopen?.callingConvention).toBe("cdecl");
        expect(fiopen?.params.length).toBe(3);
    });
});
