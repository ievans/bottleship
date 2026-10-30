import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { ModuleRegistry, type LoadedPEModule } from "../../src/worker/core/module-registry";
import { PELoader } from "../../src/worker/core/pe-loader";
import { exports as api } from "../../src/worker/modules/kernel32/module/module";

type Res = { value: number; dllInits?: Array<{ baseAddress: number; entryPoint: number; name: string; reason?: number; onReturn?: (ret: number) => void }> };

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
    expect(res.dllInits).toHaveLength(1);
    expect(res.dllInits![0]).toMatchObject({ baseAddress: mod.baseAddress, entryPoint: mod.baseAddress + 0x1234, name: mod.name, reason: 0 });
    // Still resolvable while DETACH runs; gone once DllMain has returned.
    expect(registry.getByBase(mod.baseAddress)).toBe(mod);
    res.dllInits![0]!.onReturn!(1);
    expect(registry.getByBase(mod.baseAddress)).toBeUndefined();
    expect(mod.initialized).toBe(false);
});

test("FreeLibrary keeps the module attached and loaded when the DETACH chain never ran", async () => {
    const { res, mod, registry } = await loadAndFree({});
    expect(res.dllInits).toHaveLength(1);
    expect(registry.getByBase(mod.baseAddress)).toBe(mod);
    expect(mod.initialized).toBe(true);
});

test("FreeLibrary of a DLL with no DllMain unloads immediately", async () => {
    const { res, mod, registry } = await loadAndFree({ entryPoint: 0 });
    expect(res.dllInits).toBeUndefined();
    expect(registry.getByBase(mod.baseAddress)).toBeUndefined();
});

test("FreeLibrary skips DllMain when ATTACH never ran or there is no entry point", async () => {
    for (const over of [{ initialized: false }, { entryPoint: 0 }]) {
        expect((await loadAndFree(over)).res.dllInits).toBeUndefined();
    }
});

function loaderWithQueuedAttach() {
    const registry = new ModuleRegistry();
    const mod: LoadedPEModule = {
        name: "attach-test.dll", path: "C:/attach-test.dll", baseAddress: 0x24200000, size: 0x10000,
        entryPoint: 0x10, exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: false,
    };
    registry.register(mod);
    const loader = new PELoader(() => new Uint8Array(0), {} as never, {} as never);
    loader.setModuleRegistry(registry);
    (loader as any).pendingDllInits.push({ baseAddress: mod.baseAddress, entryPoint: mod.baseAddress + 0x10, name: mod.name });
    return { loader, mod };
}

test("a runtime DllMain drain does not mark the module attached until DllMain returns", () => {
    const { loader, mod } = loaderWithQueuedAttach();
    const inits = loader.getPendingDllInits();
    expect(inits).toHaveLength(1);
    expect(mod.initialized).toBe(false);
    inits[0]!.onReturn!(1);
    expect(mod.initialized).toBe(true);
});

test("a dropped runtime DllMain chain leaves the module unattached, so FreeLibrary skips DETACH", () => {
    const { loader, mod } = loaderWithQueuedAttach();
    loader.getPendingDllInits();
    expect(mod.initialized).toBe(false);
});

test("the boot drain marks the module attached because the trampoline runs every DllMain", () => {
    const { loader, mod } = loaderWithQueuedAttach();
    expect(loader.takeBootDllInits()).toHaveLength(1);
    expect(mod.initialized).toBe(true);
});
