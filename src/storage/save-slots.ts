/**
 * Named save slots (main thread): point-in-time copies of a game's persistent layer
 * (overlay/** + registry.json + the CoW shadow index) kept inside the same container, so
 * "save game / load game" works for titles whose own save UI has one slot, or none.
 *
 *   games/<containerDir>/slots/<slotId>/slot.json   ← written LAST; a slot without it is incomplete
 *   games/<containerDir>/slots/<slotId>/data/        ← mirror of the container's persistent layer
 *
 * Slot operations assume NO guest is running on the container: a live guest holds exclusive
 * handles on its files and keeps authoritative content in memory, so a copy taken or applied
 * underneath it would be partial or silently overwritten. Callers gate on that; a copy that hits
 * a locked file throws instead of skipping, so a slot is complete or absent.
 */
import { SLOT_ROOT_FILES, getContainerDirByName } from "../worker/runtime/filesystem/container-store";

export const SLOTS_DIR = "slots";
export const AUTO_SLOT_ID = "auto-before-restore";
const SLOT_META = "slot.json";
const SLOT_DATA = "data";
const OVERLAY = "overlay";
const MAX_NAME = 80;

export interface SaveSlot {
    id: string;
    name: string;
    createdAt: number;
    fileCount: number;
    bytes: number;
    /** The safety copy made automatically before a restore. */
    auto: boolean;
}

type Entries = AsyncIterable<[string, FileSystemHandle]>;
const entriesOf = (dir: FileSystemDirectoryHandle): Entries => (dir as unknown as { entries(): Entries }).entries();

function isNotFound(e: unknown): boolean {
    return (e as { name?: string })?.name === "NotFoundError";
}

async function tryDir(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
    try { return await parent.getDirectoryHandle(name); } catch (e) { if (isNotFound(e)) return null; throw e; }
}

async function tryFile(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
    try { return await parent.getFileHandle(name); } catch (e) { if (isNotFound(e)) return null; throw e; }
}

async function copyFile(src: FileSystemFileHandle, dstDir: FileSystemDirectoryHandle, name: string): Promise<number> {
    const file = await src.getFile();
    const w = await (await dstDir.getFileHandle(name, { create: true })).createWritable();
    try {
        await w.write(file);
        await w.close();
    } catch (e) {
        try { await w.abort(); } catch { /* already closed */ }
        throw e;
    }
    return file.size;
}

interface Tally { files: number; bytes: number }

/** Make `dst` an exact mirror of `src`: copy everything in, remove everything not in `src`. */
async function mirrorDir(src: FileSystemDirectoryHandle, dst: FileSystemDirectoryHandle, tally: Tally): Promise<void> {
    const keep = new Set<string>();
    for await (const [name, handle] of entriesOf(src)) {
        keep.add(name);
        if (handle.kind === "file") {
            tally.bytes += await copyFile(handle as FileSystemFileHandle, dst, name);
            tally.files++;
        } else {
            await mirrorDir(handle as FileSystemDirectoryHandle, await dst.getDirectoryHandle(name, { create: true }), tally);
        }
    }
    const stale: string[] = [];
    for await (const [name] of entriesOf(dst)) if (!keep.has(name)) stale.push(name);
    for (const name of stale) await dst.removeEntry(name, { recursive: true });
}

/** Mirror the persistent layer of `from` into `to` (a container, or a slot's data dir), in either direction. */
async function mirrorPersistentLayer(
    from: FileSystemDirectoryHandle,
    to: FileSystemDirectoryHandle,
    tally: Tally,
): Promise<void> {
    for (const name of SLOT_ROOT_FILES) {
        const f = await tryFile(from, name);
        if (f) {
            tally.bytes += await copyFile(f, to, name);
            tally.files++;
        } else {
            try { await to.removeEntry(name); } catch (e) { if (!isNotFound(e)) throw e; }
        }
    }
    const srcOverlay = await tryDir(from, OVERLAY);
    if (srcOverlay) {
        await mirrorDir(srcOverlay, await to.getDirectoryHandle(OVERLAY, { create: true }), tally);
    } else {
        try { await to.removeEntry(OVERLAY, { recursive: true }); } catch (e) { if (!isNotFound(e)) throw e; }
    }
}

async function slotsDir(container: FileSystemDirectoryHandle, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    return create ? container.getDirectoryHandle(SLOTS_DIR, { create: true }) : tryDir(container, SLOTS_DIR);
}

function cleanName(name: string, now: number): string {
    const trimmed = name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    return trimmed || `Save ${new Date(now).toLocaleString()}`;
}

async function readSlotMeta(dir: FileSystemDirectoryHandle, id: string): Promise<SaveSlot | null> {
    const fh = await tryFile(dir, SLOT_META);
    if (!fh) return null;
    try {
        const m = JSON.parse(await (await fh.getFile()).text()) as Partial<SaveSlot>;
        if (typeof m.name !== "string" || typeof m.createdAt !== "number") return null;
        return { id, name: m.name, createdAt: m.createdAt, fileCount: m.fileCount ?? 0, bytes: m.bytes ?? 0, auto: id === AUTO_SLOT_ID };
    } catch { return null; }
}

/** Complete slots, newest first. Incomplete ones (no slot.json) are not listed. */
export async function listSaveSlots(containerDir: string): Promise<SaveSlot[]> {
    const container = await getContainerDirByName(containerDir, false);
    const dir = container && (await slotsDir(container, false));
    if (!dir) return [];
    const out: SaveSlot[] = [];
    for await (const [id, handle] of entriesOf(dir)) {
        if (handle.kind !== "directory") continue;
        const slot = await readSlotMeta(handle as FileSystemDirectoryHandle, id);
        if (slot) out.push(slot);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function writeSlot(container: FileSystemDirectoryHandle, id: string, name: string, now: number): Promise<SaveSlot> {
    const root = await slotsDir(container, true);
    if (!root) throw new Error("OPFS unavailable");
    try { await root.removeEntry(id, { recursive: true }); } catch (e) { if (!isNotFound(e)) throw e; }
    const dir = await root.getDirectoryHandle(id, { create: true });
    const tally: Tally = { files: 0, bytes: 0 };
    try {
        await mirrorPersistentLayer(container, await dir.getDirectoryHandle(SLOT_DATA, { create: true }), tally);
        const slot: SaveSlot = { id, name: cleanName(name, now), createdAt: now, fileCount: tally.files, bytes: tally.bytes, auto: id === AUTO_SLOT_ID };
        const w = await (await dir.getFileHandle(SLOT_META, { create: true })).createWritable();
        await w.write(JSON.stringify({ name: slot.name, createdAt: slot.createdAt, fileCount: slot.fileCount, bytes: slot.bytes }));
        await w.close();
        return slot;
    } catch (e) {
        try { await root.removeEntry(id, { recursive: true }); } catch { /* best effort */ }
        throw e;
    }
}

/** Capture the container's current saves into a new named slot. */
export async function createSaveSlot(containerDir: string, name: string, now = Date.now()): Promise<SaveSlot> {
    const container = await getContainerDirByName(containerDir, false);
    if (!container) throw new Error("This game has no saved data yet.");
    const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return writeSlot(container, id, name, now);
}

/**
 * Make the container's saves exactly what the slot holds. The current state is first kept in the
 * automatic slot (one, overwritten each time), so a restore is itself undoable.
 */
export async function restoreSaveSlot(containerDir: string, id: string, now = Date.now()): Promise<void> {
    const container = await getContainerDirByName(containerDir, false);
    const root = container && (await slotsDir(container, false));
    const slot = root && (await tryDir(root, id));
    const data = slot && (await tryDir(slot, SLOT_DATA));
    if (!container || !slot || !data || !(await readSlotMeta(slot, id))) throw new Error("That save slot is missing or incomplete.");
    if (id !== AUTO_SLOT_ID) await writeSlot(container, AUTO_SLOT_ID, "Before last restore", now);
    await mirrorPersistentLayer(data, container, { files: 0, bytes: 0 });
}

export async function deleteSaveSlot(containerDir: string, id: string): Promise<void> {
    const container = await getContainerDirByName(containerDir, false);
    const root = container && (await slotsDir(container, false));
    if (!root) return;
    try { await root.removeEntry(id, { recursive: true }); } catch (e) { if (!isNotFound(e)) throw e; }
}
