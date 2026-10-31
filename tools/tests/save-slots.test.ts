/**
 * Save slots (src/storage/save-slots.ts): capture / restore / delete of a container's persistent layer,
 * on an in-memory OPFS fake. Restore must be an exact mirror (extra files and the shadow index included),
 * leave a safety copy, and a failed capture must leave no half-slot behind.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { AUTO_SLOT_ID, createSaveSlot, deleteSaveSlot, listSaveSlots, restoreSaveSlot } from "../../src/storage/save-slots";

function nf(): Error { const e = new Error("nf"); e.name = "NotFoundError"; return e; }
class FFile {
    kind = "file" as const; data = new Uint8Array(0); failWrite = false;
    constructor(public name: string) {}
    async getFile() { return new Blob([this.data]); }
    async createWritable() {
        const self = this;
        return {
            async write(x: Blob | string) {
                if (self.failWrite) throw new Error("locked");
                self.data = typeof x === "string" ? new TextEncoder().encode(x) : new Uint8Array(await x.arrayBuffer());
            },
            async close() {}, async abort() {},
        };
    }
}
class FDir {
    kind = "directory" as const; children = new Map<string, FDir | FFile>();
    constructor(public name: string) {}
    async getDirectoryHandle(n: string, o?: { create?: boolean }) {
        let c = this.children.get(n);
        if (!c) { if (!o?.create) throw nf(); c = new FDir(n); this.children.set(n, c); }
        if (c.kind !== "directory") throw new Error("type");
        return c;
    }
    async getFileHandle(n: string, o?: { create?: boolean }) {
        let c = this.children.get(n);
        if (!c) { if (!o?.create) throw nf(); c = new FFile(n); this.children.set(n, c); }
        if (c.kind !== "file") throw new Error("type");
        return c;
    }
    async removeEntry(n: string) { if (!this.children.delete(n)) throw nf(); }
    async *entries() { yield* [...this.children.entries()]; }
}

let root: FDir;
const orig = (globalThis as any).navigator;
beforeEach(() => { root = new FDir(""); (globalThis as any).navigator = { storage: { getDirectory: async () => root } }; });
afterAll(() => { (globalThis as any).navigator = orig; });

const CONTAINER = "app-game";
async function container(): Promise<FDir> {
    const bs = await root.getDirectoryHandle("bottleship", { create: true });
    const games = await bs.getDirectoryHandle("games", { create: true });
    return games.getDirectoryHandle(CONTAINER, { create: true });
}
async function put(dir: FDir, path: string, text: string): Promise<void> {
    const parts = path.split("/");
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    (await d.getFileHandle(parts.at(-1)!, { create: true })).data = new TextEncoder().encode(text);
}
async function tree(dir: FDir, prefix = ""): Promise<string[]> {
    const out: string[] = [];
    for (const [n, h] of dir.children) {
        if (prefix === "" && n === "slots") continue;
        const rel = prefix + n;
        if (h.kind === "file") out.push(`${rel}=${new TextDecoder().decode(h.data)}`);
        else out.push(`${rel}/`, ...(await tree(h, rel + "/")));
    }
    return out.sort();
}

describe("save slots", () => {
    test("a slot captures overlay, registry and the shadow index, but not the AOT cache or meta", async () => {
        const c = await container();
        await put(c, "overlay/saves/a.sav", "one");
        await put(c, "overlay/empty/.keep", "");
        await put(c, "registry.json", "{}");
        await put(c, "overlay-shadow.json", '{"shadowed":["c:\\\\x"]}');
        await put(c, "meta.json", "meta");
        await put(c, "aot/blob", "cache");
        const slot = await createSaveSlot(CONTAINER, "  First   save ");
        expect(slot.name).toBe("First save");
        expect(slot.fileCount).toBe(4);
        const listed = await listSaveSlots(CONTAINER);
        expect(listed.map((s) => s.id)).toEqual([slot.id]);
        const data = await (await (await c.getDirectoryHandle("slots")).getDirectoryHandle(slot.id)).getDirectoryHandle("data");
        expect(await tree(data as FDir)).toEqual([
            "overlay-shadow.json={\"shadowed\":[\"c:\\\\x\"]}", "overlay/", "overlay/empty/", "overlay/empty/.keep=", "overlay/saves/", "overlay/saves/a.sav=one", "registry.json={}",
        ]);
    });

    test("restore makes the container an exact mirror and keeps the previous state in the auto slot", async () => {
        const c = await container();
        await put(c, "overlay/saves/a.sav", "one");
        await put(c, "overlay-shadow.json", "S1");
        const slot = await createSaveSlot(CONTAINER, "A");
        await put(c, "overlay/saves/a.sav", "two");
        await put(c, "overlay/saves/b.sav", "extra");
        await put(c, "overlay-shadow.json", "S2");
        await put(c, "registry.json", "added later");
        await restoreSaveSlot(CONTAINER, slot.id);
        expect(await tree(c)).toEqual(["overlay-shadow.json=S1", "overlay/", "overlay/saves/", "overlay/saves/a.sav=one"]);

        const auto = (await listSaveSlots(CONTAINER)).find((s) => s.id === AUTO_SLOT_ID)!;
        expect(auto.auto).toBe(true);
        await restoreSaveSlot(CONTAINER, AUTO_SLOT_ID);
        expect(await tree(c)).toEqual([
            "overlay-shadow.json=S2", "overlay/", "overlay/saves/", "overlay/saves/a.sav=two", "overlay/saves/b.sav=extra", "registry.json=added later",
        ]);
    });

    test("a copy that hits a locked file fails and leaves no slot", async () => {
        const c = await container();
        await put(c, "overlay/a.sav", "x");
        const orig = FFile.prototype.createWritable;
        FFile.prototype.createWritable = async function (this: FFile) {
            if (this.name === "a.sav") this.failWrite = true;
            return orig.call(this);
        };
        try {
            await expect(createSaveSlot(CONTAINER, "bad")).rejects.toThrow("locked");
        } finally { FFile.prototype.createWritable = orig; }
        expect(await listSaveSlots(CONTAINER)).toEqual([]);
        expect([...(await c.getDirectoryHandle("slots")).children.keys()]).toEqual([]);
    });

    test("delete removes the slot; restoring a missing or incomplete slot is refused", async () => {
        const c = await container();
        await put(c, "overlay/a.sav", "x");
        const slot = await createSaveSlot(CONTAINER, "");
        expect(slot.name.startsWith("Save ")).toBe(true);
        await deleteSaveSlot(CONTAINER, slot.id);
        expect(await listSaveSlots(CONTAINER)).toEqual([]);
        await expect(restoreSaveSlot(CONTAINER, slot.id)).rejects.toThrow("missing");
        const dir = await (await c.getDirectoryHandle("slots")).getDirectoryHandle("half", { create: true });
        await dir.getDirectoryHandle("data", { create: true });
        expect(await listSaveSlots(CONTAINER)).toEqual([]);
        await expect(restoreSaveSlot(CONTAINER, "half")).rejects.toThrow("incomplete");
    });

    test("a game with no container cannot be snapshotted", async () => {
        await expect(createSaveSlot("nope", "x")).rejects.toThrow("no saved data");
    });
});
