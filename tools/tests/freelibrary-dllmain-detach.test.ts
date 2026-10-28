import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { ModuleRegistry, type LoadedPEModule } from "../../src/worker/core/module-registry";
import { exports as api } from "../../src/worker/modules/kernel32/module/module";

type Res = { value: number; dllInits?: Array<{ baseAddress: number; entryPoint: number; name: string; reason?: number }> };

async function loadAndFree(over: Partial<LoadedPEModule>) {
    const system = System.getInstance();
    const previous = system.process;
    const registry = new ModuleRegistry();
    const mod: LoadedPEModule = {
        name: "detach-test.dll", path: "C:/detach-test.dll", baseAddress: 0x24100000, size: 0x10000,
        entryPoint: 0x1234, exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: true, ...over,
    };
    const loader = { peekLoadDll: () => ({ kind: "io" }), loadDll: async () => { registry.register(mod); return mod; }, getPendingDllInits: () => [] };
    system.process = { moduleRegistry: registry, loader, resetGeneration: 0 } as never;
    const mem = new Uint8Array(0x1000);
    for (let i = 0; i < mod.name.length; i++) mem[0x100 + i] = mod.name.charCodeAt(i);
    try {
        await api["LoadLibraryA"]({} as never, mem, [0x100]);
        const res = await api["FreeLibrary"]({} as never, mem, [mod.baseAddress]) as Res;
        return { res, mod, registry };
    } finally { system.process = previous; }
}

test("FreeLibrary of an attached DLL queues DllMain(DLL_PROCESS_DETACH)", async () => {
    const { res, mod, registry } = await loadAndFree({});
    expect(res.value).toBe(1);
    expect(res.dllInits).toEqual([{ baseAddress: mod.baseAddress, entryPoint: mod.baseAddress + 0x1234, name: mod.name, reason: 0 }]);
    expect(registry.getByBase(mod.baseAddress)).toBeUndefined();
});

test("FreeLibrary skips DllMain when ATTACH never ran or there is no entry point", async () => {
    for (const over of [{ initialized: false }, { entryPoint: 0 }]) {
        expect((await loadAndFree(over)).res.dllInits).toBeUndefined();
    }
});
