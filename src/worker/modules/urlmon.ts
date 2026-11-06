/**
 * URL Moniker Services (urlmon.dll), file URLs only: CreateURLMoniker, bind contexts with a
 * registered IBindStatusCallback, and IMoniker::BindToStorage producing a read-only IStream over
 * the file. That is the path MSXML's DOMDocument::load takes for a local document.
 *
 * A bind is delivered synchronously: the callback's GetBindInfo, OnStartBinding,
 * OnDataAvailable (one notification carrying the whole file) and OnStopBinding all run, as real
 * guest calls in that order, before BindToStorage returns. An asynchronous bind
 * (BINDF_ASYNCHRONOUS) then answers MK_S_ASYNCHRONOUS with no object, as urlmon does; the data
 * has already arrived through the callback.
 *
 * ole32's CreateBindCtx forwards here, so any bind context a client hands back is one of ours.
 */

import { urlmonModule } from "../api/urlmon.api";
import { createVTablesFromDescriptor, VTableInfo } from "../api/adapters/module-adapter";
import { BaseComObject } from "../core/com/base-com-object";
import { allocateComObject } from "../core/com/com-memory";
import { InterfaceRegistry } from "../core/com/interface-registry";
import { Logger, LogCategory } from "../core/logger";
import { isValidAddress } from "../core/memory/address-guard";
import { Mem } from "../core/memory/mem-accessor";
import { IModule } from "../core/module";
import { Process } from "../core/process";
import { SystemResourceProvider } from "../core/resources/system-resource-provider";
import { System } from "../core/system";
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { pathDirectory, pathToFileUrl, urlToPath } from "./urlmon/url-path";

const IID_IUnknown = "00000000-0000-0000-c000-000000000046";
const IID_IBindCtx = "0000000e-0000-0000-c000-000000000046";
const IID_IStream = "0000000c-0000-0000-c000-000000000046";
const IID_ISequentialStream = "0c733a30-2a1c-11ce-ade5-00aa0044773d";
const IID_IMoniker = "0000000f-0000-0000-c000-000000000046";
const IID_IPersist = "0000010c-0000-0000-c000-000000000046";
const IID_IPersistStream = "00000109-0000-0000-c000-000000000046";
const IID_IBinding = "79eac9c0-baf9-11ce-8c82-00aa004ba90b";
const CLSID_StdURLMoniker = "79eac9e0-baf9-11ce-8c82-00aa004ba90b";

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const E_FAIL = 0x80004005;
const E_INVALIDARG = 0x80070057;
const E_OUTOFMEMORY = 0x8007000e;
const STG_E_INVALIDFUNCTION = 0x80030001;
const MK_S_ASYNCHRONOUS = 0x000401e8;
const MK_S_REDUCED_TO_SELF = 0x000401e2;
const MK_E_NOOBJECT = 0x800401e5;
const INET_E_RESOURCE_NOT_FOUND = 0x800c0005;
const INET_E_UNKNOWN_PROTOCOL = 0x800c000d;

const MKSYS_URLMONIKER = 6;
const BINDF_ASYNCHRONOUS = 0x1;
const BSCF_FIRST_LAST_FULL = 0x1 | 0x4 | 0x8;
const TYMED_ISTREAM = 4;
const DVASPECT_CONTENT = 1;
const STGTY_STREAM = 2;
const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;

// IBindStatusCallback slots (urlmon.h).
const BSC_ON_START_BINDING = 3;
const BSC_ON_STOP_BINDING = 7;
const BSC_GET_BIND_INFO = 8;
const BSC_ON_DATA_AVAILABLE = 9;

const BINDINFO_SIZE = 0x54;
const FORMATETC_SIZE = 20;
const STGMEDIUM_SIZE = 12;
const STATSTG_SIZE = 72;
const BIND_STACK_CLEANUP = 20;
const MAX_URL_CHARS = 2084;

function validPointer(ptr: number, size: number, perms: "r" | "rw"): boolean {
    const mem = Mem.getView();
    return !!ptr && !!mem && ptr + size <= mem.length && isValidAddress(mem, ptr, size, perms);
}

function out32(ptr: number, value: number): void {
    if (validPointer(ptr, 4, "rw")) Mem.writeUint32(ptr, value >>> 0);
}

function guidAt(address: number): string {
    const b = validPointer(address, 16, "r") ? Mem.readBytes(address, 16) : null;
    if (!b) return "";
    const v = new DataView(b.buffer, b.byteOffset, 16);
    const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
    const tail = Array.from(b.subarray(8), x => hex(x, 2)).join("");
    return `${hex(v.getUint32(0, true), 8)}-${hex(v.getUint16(4, true), 4)}-${hex(v.getUint16(6, true), 4)}-` +
        `${tail.slice(0, 4)}-${tail.slice(4)}`;
}

function guidBytes(guid: string): Uint8Array {
    const p = guid.split("-");
    const out = new Uint8Array(16);
    const v = new DataView(out.buffer);
    v.setUint32(0, parseInt(p[0]!, 16), true);
    v.setUint16(4, parseInt(p[1]!, 16), true);
    v.setUint16(6, parseInt(p[2]!, 16), true);
    const tail = p[3]! + p[4]!;
    for (let i = 0; i < 8; i++) out[8 + i] = parseInt(tail.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function readWide(address: number, maxChars: number): string {
    let out = "";
    for (let i = 0; address && i < maxChars; i++) {
        const code = Mem.readUint16(address + i * 2);
        if (!code) break;
        out += String.fromCharCode(code);
    }
    return out;
}

function wideBytes(s: string): Uint8Array {
    const out = new Uint8Array((s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) {
        out[i * 2] = s.charCodeAt(i) & 0xff;
        out[i * 2 + 1] = s.charCodeAt(i) >> 8;
    }
    return out;
}

function readVtblSlot(objPtr: number, slot: number): number {
    const vtable = validPointer(objPtr, 4, "r") ? Mem.readUint32(objPtr) ?? 0 : 0;
    if (!validPointer(vtable, (slot + 1) * 4, "r")) return 0;
    return Mem.readUint32(vtable + slot * 4) ?? 0;
}

abstract class UrlmonObject extends BaseComObject {
    readonly addresses = new Map<string, number>();
    abstract readonly primaryVtable: string;
    abstract readonly interfaces: Readonly<Record<string, string>>;

    constructor() {
        super(IID_IUnknown, 0);
    }

    protected destroy(): void {
        this.addresses.clear();
    }
}

class BindCtxObject extends UrlmonObject {
    readonly primaryVtable = "IBindCtx";
    readonly interfaces = { [IID_IBindCtx]: "IBindCtx" };
    /** The registered IBindStatusCallback, a guest object. */
    statusCallback = 0;
    /** RegisterObjectParam entries, by upper-cased key. */
    readonly params = new Map<string, number>();
    bindOptions: Uint8Array | null = null;
}

/** A read/write stream over an in-memory copy of the bound file. */
class StreamObject extends UrlmonObject {
    readonly primaryVtable = "IStream";
    readonly interfaces = { [IID_IStream]: "IStream", [IID_ISequentialStream]: "IStream" };
    position = 0;

    constructor(public data: Uint8Array, public length = data.length) {
        super();
    }
}

class MonikerObject extends UrlmonObject {
    readonly primaryVtable = "IMoniker";
    readonly interfaces = { [IID_IMoniker]: "IMoniker", [IID_IPersist]: "IMoniker", [IID_IPersistStream]: "IMoniker" };

    /** `path` is null for a URL whose scheme is not a file: it can name, but never bind. */
    constructor(public url: string, public path: string | null) {
        super();
    }
}

class BindingObject extends UrlmonObject {
    readonly primaryVtable = "IBinding";
    readonly interfaces = { [IID_IBinding]: "IBinding" };
    result = S_OK;
}

export class Urlmon implements IModule {
    name = "urlmon";
    exports: Record<string, ThunkImplementation> = {};
    vtables: Record<string, VTableInfo> = {};
    private process!: Process;
    private taskAlloc: ((cb: number) => number) | null = null;

    initialize(process: Process): void {
        this.process = process;
        InterfaceRegistry.getInstance().registerFromModuleDescriptor(urlmonModule);
        this.vtables = createVTablesFromDescriptor(this.process, urlmonModule);
        for (const iface of urlmonModule.interfaces ?? []) this.registerUnknownExports(iface.name);
        this.registerFunctionExports();
        this.registerBindCtxExports();
        this.registerStreamExports();
        this.registerMonikerExports();
        this.registerBindingExports();
    }

    recreateVTables(): void {
        if (this.process) this.vtables = createVTablesFromDescriptor(this.process, urlmonModule);
    }

    /** CoTaskMemAlloc, for the strings IMoniker::GetDisplayName hands back to be CoTaskMemFree'd. */
    setTaskAllocator(alloc: (cb: number) => number): void {
        this.taskAlloc = alloc;
    }

    // ── objects and interfaces ──────────────────────────────────────────────────

    private object<T extends UrlmonObject>(thisPtr: number | undefined, type: abstract new (...a: never[]) => T): T | null {
        if (!thisPtr) return null;
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(thisPtr >>> 0);
        return obj instanceof type ? obj : null;
    }

    private addressOf(obj: UrlmonObject, vtableName: string): number {
        const known = obj.addresses.get(vtableName);
        if (known) return known;
        const vtable = this.vtables[vtableName];
        const mem = Mem.getView();
        if (!vtable || !mem) return 0;
        const address = allocateComObject(this.process.memory, mem, vtable.address) >>> 0;
        SystemResourceProvider.getInstance().mapAddressToHandle(address, obj.handle);
        obj.addresses.set(vtableName, address);
        return address;
    }

    private queryInterface(obj: UrlmonObject, iid: string, ppOut: number): number {
        if (!validPointer(ppOut, 4, "rw")) return E_POINTER;
        const vtableName = iid === IID_IUnknown ? obj.primaryVtable : obj.interfaces[iid];
        const address = vtableName ? this.addressOf(obj, vtableName) : 0;
        if (!address) {
            Mem.writeUint32(ppOut, 0);
            return E_NOINTERFACE;
        }
        Mem.writeUint32(ppOut, address);
        obj.addRef();
        return S_OK;
    }

    /** A new object's interface pointer; the caller owns the object's one reference. */
    private newObject(obj: UrlmonObject): number {
        return this.addressOf(obj, obj.primaryVtable);
    }

    private registerUnknownExports(iface: string): void {
        const e = this.exports;
        e[`${iface}_QueryInterface`] = (_c, _m, a) => {
            const obj = this.object(a[0], UrlmonObject);
            if (!obj) {
                out32(a[2] >>> 0, 0);
                return E_NOINTERFACE | 0;
            }
            return this.queryInterface(obj, guidAt(a[1] >>> 0), a[2] >>> 0) | 0;
        };
        e[`${iface}_AddRef`] = (_c, _m, a) => this.object(a[0], UrlmonObject)?.addRef() ?? 0;
        e[`${iface}_Release`] = (_c, _m, a) => this.object(a[0], UrlmonObject)?.release() ?? 0;
    }

    // ── flat exports ────────────────────────────────────────────────────────────

    private createMoniker(contextPtr: number, urlPtr: number, ppmk: number): number {
        if (!validPointer(ppmk, 4, "rw")) return E_POINTER;
        Mem.writeUint32(ppmk, 0);
        const url = readWide(urlPtr, MAX_URL_CHARS);
        if (!url) return E_INVALIDARG;
        const context = this.object(contextPtr, MonikerObject);
        const baseDir = context?.path ? pathDirectory(context.path) : null;
        const path = urlToPath(url, baseDir);
        const full = path && System.getInstance().fileSystem ? System.getInstance().fileSystem.resolvePath(path) : path;
        const mon = new MonikerObject(full ? pathToFileUrl(full) : url, full);
        Logger.log(LogCategory.COM, `urlmon: CreateURLMoniker "${url}" → ${full ?? "(not a file URL)"}`);
        Mem.writeUint32(ppmk, this.newObject(mon));
        return S_OK;
    }

    private registerFunctionExports(): void {
        const e = this.exports;
        e["CreateURLMoniker"] = (_c, _m, a) => this.createMoniker(a[0] >>> 0, a[1] >>> 0, a[2] >>> 0) | 0;
        e["CreateURLMonikerEx"] = (_c, _m, a) => this.createMoniker(a[0] >>> 0, a[1] >>> 0, a[2] >>> 0) | 0;

        // HRESULT CreateBindCtx(DWORD reserved, IBindCtx **ppbc) — ole32's export forwards here.
        e["CreateBindCtx"] = (_c, _m, a) => {
            const ppbc = a[1] >>> 0;
            if (!validPointer(ppbc, 4, "rw")) return E_POINTER | 0;
            Mem.writeUint32(ppbc, this.newObject(new BindCtxObject()));
            return S_OK;
        };

        // HRESULT CreateAsyncBindCtx(DWORD reserved, IBindStatusCallback*, IEnumFORMATETC*, IBindCtx**)
        e["CreateAsyncBindCtx"] = (_c, _m, a) => {
            const ppbc = a[3] >>> 0;
            if (!validPointer(ppbc, 4, "rw")) return E_POINTER | 0;
            const ctx = new BindCtxObject();
            ctx.statusCallback = a[1] >>> 0;
            Mem.writeUint32(ppbc, this.newObject(ctx));
            return S_OK;
        };

        // HRESULT RegisterBindStatusCallback(IBindCtx*, IBindStatusCallback*, IBindStatusCallback **prev, DWORD)
        e["RegisterBindStatusCallback"] = (_c, _m, a) => {
            const ctx = this.object(a[0], BindCtxObject);
            if (!ctx || !a[1]) return E_INVALIDARG | 0;
            out32(a[2] >>> 0, 0);
            ctx.statusCallback = a[1] >>> 0;
            return S_OK;
        };
        e["RevokeBindStatusCallback"] = (_c, _m, a) => {
            const ctx = this.object(a[0], BindCtxObject);
            if (!ctx) return E_INVALIDARG | 0;
            if (ctx.statusCallback === a[1] >>> 0) ctx.statusCallback = 0;
            return S_OK;
        };

        // No pluggable-protocol session: a client that registers namespace handlers on it
        // goes without, which leaves file binds unaffected.
        e["CoInternetGetSession"] = (_c, _m, a) => {
            out32(a[1] >>> 0, 0);
            return E_NOTIMPL | 0;
        };
        e["IsAsyncMoniker"] = () => S_FALSE;
    }

    // ── IBindCtx ────────────────────────────────────────────────────────────────

    private registerBindCtxExports(): void {
        const e = this.exports;
        const define = (name: string, fn: (ctx: BindCtxObject, a: number[]) => number): void => {
            e[`IBindCtx_${name}`] = (_c, _m, a) => {
                const ctx = this.object(a[0], BindCtxObject);
                return ctx ? fn(ctx, a) | 0 : E_POINTER | 0;
            };
        };
        define("RegisterObjectBound", () => S_OK);
        define("RevokeObjectBound", () => S_OK);
        define("ReleaseBoundObjects", () => S_OK);
        define("SetBindOptions", (ctx, a) => {
            const p = a[1] >>> 0;
            const size = validPointer(p, 4, "r") ? Mem.readUint32(p) ?? 0 : 0;
            if (size < 4 || !validPointer(p, size, "r")) return E_INVALIDARG;
            ctx.bindOptions = Mem.readBytes(p, size)?.slice() ?? null;
            return S_OK;
        });
        define("GetBindOptions", (ctx, a) => {
            const p = a[1] >>> 0;
            const size = validPointer(p, 4, "r") ? Mem.readUint32(p) ?? 0 : 0;
            if (size < 4 || !validPointer(p, size, "rw")) return E_INVALIDARG;
            if (ctx.bindOptions) Mem.writeBytes(p + 4, ctx.bindOptions.subarray(4, Math.min(size, ctx.bindOptions.length)));
            return S_OK;
        });
        define("GetRunningObjectTable", (_ctx, a) => {
            out32(a[1] >>> 0, 0);
            return E_NOTIMPL;
        });
        // The object is the caller's to keep alive: these entries are looked up for the
        // duration of one bind, and no reference is taken or handed out for a guest object.
        define("RegisterObjectParam", (ctx, a) => {
            const key = readWide(a[1] >>> 0, 256).toUpperCase();
            if (!key) return E_INVALIDARG;
            ctx.params.set(key, a[2] >>> 0);
            return S_OK;
        });
        define("GetObjectParam", (ctx, a) => {
            const key = readWide(a[1] >>> 0, 256).toUpperCase();
            const punk = ctx.params.get(key) ?? 0;
            const ours = this.object(punk, UrlmonObject);
            // A guest object would need its AddRef run as guest code; answer as absent rather
            // than hand out a pointer whose Release the caller would then owe.
            if (!ours) {
                out32(a[2] >>> 0, 0);
                if (punk) Logger.warn(LogCategory.COM, `urlmon: GetObjectParam("${key}") of a guest object — answered absent`);
                return E_FAIL;
            }
            ours.addRef();
            out32(a[2] >>> 0, punk);
            return S_OK;
        });
        define("EnumObjectParam", (_ctx, a) => {
            out32(a[1] >>> 0, 0);
            return E_NOTIMPL;
        });
        define("RevokeObjectParam", (ctx, a) => (ctx.params.delete(readWide(a[1] >>> 0, 256).toUpperCase()) ? S_OK : S_FALSE));
    }

    // ── IStream ─────────────────────────────────────────────────────────────────

    private registerStreamExports(): void {
        const e = this.exports;
        const define = (name: string, fn: (s: StreamObject, a: number[]) => number): void => {
            e[`IStream_${name}`] = (_c, _m, a) => {
                const s = this.object(a[0], StreamObject);
                return s ? fn(s, a) | 0 : E_POINTER | 0;
            };
        };
        define("Read", (s, a) => {
            const pv = a[1] >>> 0;
            const want = a[2] >>> 0;
            const n = Math.max(0, Math.min(want, s.length - s.position));
            if (n && !validPointer(pv, n, "rw")) return E_POINTER;
            if (n) Mem.writeBytes(pv, s.data.subarray(s.position, s.position + n));
            s.position += n;
            out32(a[3] >>> 0, n);
            return n < want ? S_FALSE : S_OK;
        });
        define("Write", (s, a) => {
            const pv = a[1] >>> 0;
            const n = a[2] >>> 0;
            if (n && !validPointer(pv, n, "r")) return E_POINTER;
            const end = s.position + n;
            if (end > s.data.length) {
                const grown = new Uint8Array(Math.max(end, s.data.length * 2));
                grown.set(s.data.subarray(0, s.length));
                s.data = grown;
            }
            if (n) s.data.set(Mem.readBytes(pv, n) ?? new Uint8Array(n), s.position);
            s.position = end;
            s.length = Math.max(s.length, end);
            out32(a[3] >>> 0, n);
            return S_OK;
        });
        define("Seek", (s, a) => {
            const move = (a[1] >>> 0) + (a[2] | 0) * 0x100000000;
            const origin = a[3] >>> 0;
            const base = origin === 0 ? 0 : origin === 1 ? s.position : origin === 2 ? s.length : -1;
            if (base < 0) return STG_E_INVALIDFUNCTION;
            const next = base + move;
            if (next < 0) return STG_E_INVALIDFUNCTION;
            s.position = next;
            const out = a[4] >>> 0;
            if (out && validPointer(out, 8, "rw")) {
                Mem.writeUint32(out, next >>> 0);
                Mem.writeUint32(out + 4, Math.floor(next / 0x100000000));
            }
            return S_OK;
        });
        define("SetSize", (s, a) => {
            const size = a[1] >>> 0;
            if (size > s.data.length) {
                const grown = new Uint8Array(size);
                grown.set(s.data.subarray(0, s.length));
                s.data = grown;
            } else if (size > s.length) {
                s.data.fill(0, s.length, size);
            }
            s.length = size;
            return S_OK;
        });
        define("CopyTo", () => E_NOTIMPL);
        define("Commit", () => S_OK);
        define("Revert", () => S_OK);
        define("LockRegion", () => STG_E_INVALIDFUNCTION);
        define("UnlockRegion", () => STG_E_INVALIDFUNCTION);
        // STATSTG with no name: pwcsName stays NULL, which is what STATFLAG_NONAME asks for and
        // a safe answer to the default (the caller frees it only when non-NULL).
        define("Stat", (s, a) => {
            const p = a[1] >>> 0;
            if (!validPointer(p, STATSTG_SIZE, "rw")) return E_POINTER;
            Mem.writeBytes(p, new Uint8Array(STATSTG_SIZE));
            Mem.writeUint32(p + 4, STGTY_STREAM);
            Mem.writeUint32(p + 8, s.length >>> 0);
            return S_OK;
        });
        define("Clone", (s, a) => {
            const pp = a[1] >>> 0;
            if (!validPointer(pp, 4, "rw")) return E_POINTER;
            const copy = new StreamObject(s.data, s.length);
            copy.position = s.position;
            Mem.writeUint32(pp, this.newObject(copy));
            return S_OK;
        });
    }

    // ── IMoniker ────────────────────────────────────────────────────────────────

    private registerMonikerExports(): void {
        const e = this.exports;
        const define = (name: string, fn: (mon: MonikerObject, a: number[], ctx: { esp: number }) => number | ThunkResult | Promise<ThunkResult>): void => {
            e[`IMoniker_${name}`] = (c, _m, a) => {
                const mon = this.object(a[0], MonikerObject);
                if (!mon) return E_POINTER | 0;
                const r = fn(mon, a, c);
                return typeof r === "number" ? r | 0 : r;
            };
        };
        define("GetClassID", (_mon, a) => {
            const p = a[1] >>> 0;
            if (!validPointer(p, 16, "rw")) return E_POINTER;
            Mem.writeBytes(p, guidBytes(CLSID_StdURLMoniker));
            return S_OK;
        });
        define("IsDirty", () => S_FALSE);
        define("Load", () => E_NOTIMPL);
        define("Save", () => E_NOTIMPL);
        define("GetSizeMax", () => E_NOTIMPL);
        define("BindToObject", (_mon, a) => {
            out32(a[4] >>> 0, 0);
            return E_NOTIMPL;
        });
        define("BindToStorage", (mon, a, ctx) => this.bindToStorage(mon, a, ctx));
        define("Reduce", (_mon, a) => {
            out32(a[4] >>> 0, a[0] >>> 0);
            this.object(a[0], MonikerObject)?.addRef();
            return MK_S_REDUCED_TO_SELF;
        });
        define("ComposeWith", (_mon, a) => {
            out32(a[3] >>> 0, 0);
            return E_NOTIMPL;
        });
        define("Enum", (_mon, a) => {
            out32(a[2] >>> 0, 0);
            return S_OK;
        });
        define("IsEqual", (mon, a) => {
            const other = this.object(a[1], MonikerObject);
            return other && other.url.toLowerCase() === mon.url.toLowerCase() ? S_OK : S_FALSE;
        });
        define("Hash", (mon, a) => {
            let h = 0;
            for (const ch of mon.url.toLowerCase()) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
            out32(a[1] >>> 0, h);
            return S_OK;
        });
        define("IsRunning", () => S_FALSE);
        define("GetTimeOfLastChange", () => MK_E_NOOBJECT);
        define("Inverse", (_mon, a) => {
            out32(a[1] >>> 0, 0);
            return E_NOTIMPL;
        });
        define("CommonPrefixWith", (_mon, a) => {
            out32(a[2] >>> 0, 0);
            return E_NOTIMPL;
        });
        define("RelativePathTo", (_mon, a) => {
            out32(a[2] >>> 0, 0);
            return E_NOTIMPL;
        });
        define("GetDisplayName", (mon, a) => {
            const pp = a[3] >>> 0;
            if (!validPointer(pp, 4, "rw")) return E_POINTER;
            const text = wideBytes(mon.url);
            const ptr = this.taskAlloc?.(text.length) ?? 0;
            if (!ptr) {
                Mem.writeUint32(pp, 0);
                return E_OUTOFMEMORY;
            }
            Mem.writeBytes(ptr, text);
            Mem.writeUint32(pp, ptr);
            return S_OK;
        });
        define("ParseDisplayName", (_mon, a) => {
            out32(a[5] >>> 0, 0);
            return E_NOTIMPL;
        });
        define("IsSystemMoniker", (_mon, a) => {
            out32(a[1] >>> 0, MKSYS_URLMONIKER);
            return S_OK;
        });
    }

    /** HRESULT BindToStorage(IBindCtx *pbc, IMoniker *pmkToLeft, REFIID riid, void **ppvObj) */
    private bindToStorage(mon: MonikerObject, a: number[], ctx: { esp: number }): number | ThunkResult | Promise<ThunkResult> {
        const bindCtx = this.object(a[1], BindCtxObject);
        const iid = guidAt(a[3] >>> 0);
        const ppv = a[4] >>> 0;
        out32(ppv, 0);
        if (iid !== IID_IStream && iid !== IID_ISequentialStream && iid !== IID_IUnknown) {
            Logger.warn(LogCategory.COM, `urlmon: BindToStorage(${mon.url}) for unsupported IID ${iid}`);
            return E_NOINTERFACE;
        }
        if (!mon.path) return INET_E_UNKNOWN_PROTOCOL;

        const callback = bindCtx?.statusCallback ?? 0;
        const vfs = System.getInstance().fileSystem;
        const handle = vfs?.openSync(mon.path, GENERIC_READ, OPEN_EXISTING) ?? null;
        const size = handle ? vfs.getFileSize(mon.path) : 0;
        const data = handle ? (size > 0 ? vfs.readSync(handle, size, "park-preferred") : new Uint8Array(0)) : null;
        if (handle && data) return this.deliver(mon, callback, iid, ppv, data, ctx) ?? E_FAIL;

        return (async (): Promise<ThunkResult> => {
            let bytes: Uint8Array | null = null;
            try {
                const h = handle ?? await vfs.open(mon.path!, GENERIC_READ, OPEN_EXISTING);
                if (h) {
                    const n = vfs.getFileSize(mon.path!);
                    bytes = n > 0 ? await vfs.read(h, n) : new Uint8Array(0);
                }
            } catch (err) {
                Logger.warn(LogCategory.COM, `urlmon: reading ${mon.path} failed: ${err}`);
            }
            if (!callback) return { value: this.finishBind(mon, bytes, iid, ppv, false) | 0 };
            return {
                value: S_OK,
                startCallbackChain: ({ esp, returnAddr }) => this.startBindChain(mon, callback, bytes, iid, ppv, { esp, returnAddr }) !== null,
            };
        })();
    }

    private deliver(mon: MonikerObject, callback: number, iid: string, ppv: number, data: Uint8Array, ctx: { esp: number }): number | ThunkResult | null {
        if (!callback) return this.finishBind(mon, data, iid, ppv, false);
        return this.startBindChain(mon, callback, data, iid, ppv, ctx);
    }

    /** The bind's outcome with no status callback, or after the callback chain: the stream or the error. */
    private finishBind(mon: MonikerObject, data: Uint8Array | null, iid: string, ppv: number, async: boolean, stream?: StreamObject): number {
        if (!data) {
            Logger.warn(LogCategory.COM, `urlmon: BindToStorage(${mon.url}) — file not found`);
            return INET_E_RESOURCE_NOT_FOUND;
        }
        Logger.log(LogCategory.COM, `urlmon: BindToStorage(${mon.url}) → ${data.length} bytes${async ? " (async)" : ""}`);
        if (async) return MK_S_ASYNCHRONOUS;
        const s = stream ?? new StreamObject(data);
        const hr = this.queryInterface(s, iid === IID_IUnknown ? IID_IStream : iid, ppv);
        if (!stream) s.release();
        return hr;
    }

    /**
     * Run the status callback's GetBindInfo → OnStartBinding → OnDataAvailable → OnStopBinding
     * as guest calls, then complete BindToStorage. Returns null when the frame cannot be saved.
     */
    private startBindChain(
        mon: MonikerObject, callback: number, data: Uint8Array | null, iid: string, ppv: number,
        ctx: { esp: number; returnAddr?: number },
    ): ThunkResult | null {
        const callbackManager = this.process.dispatcher.callbackManager;
        if (!callbackManager) return null;
        const returnAddr = ctx.returnAddr !== undefined ? ctx.returnAddr >>> 0 : Mem.readUint32(ctx.esp) ?? 0;
        const frameId = callbackManager.saveSuspendedThunkContext(
            { ...ctx, returnAddr } as Parameters<typeof callbackManager.saveSuspendedThunkContext>[0],
            BIND_STACK_CLEANUP,
            "urlmon-Bind",
        );
        if (!frameId) return null;

        const scratchSize = 4 + BINDINFO_SIZE + FORMATETC_SIZE + STGMEDIUM_SIZE;
        const scratch = this.process.memory.alloc(scratchSize, "THUNK_DATA");
        const pGrfBindf = scratch;
        const pBindInfo = scratch + 4;
        const pFormat = pBindInfo + BINDINFO_SIZE;
        const pMedium = pFormat + FORMATETC_SIZE;
        Mem.writeBytes(scratch, new Uint8Array(scratchSize));
        Mem.writeUint32(pBindInfo, BINDINFO_SIZE);

        const binding = new BindingObject();
        const bindingPtr = this.newObject(binding);
        const stream = data ? new StreamObject(data) : null;
        const resultHr = data ? S_OK : INET_E_RESOURCE_NOT_FOUND;
        binding.result = resultHr;
        let async = false;

        const call = (slot: number, args: number[], label: string, then: (ret: number) => number | null): number | null => {
            const fn = readVtblSlot(callback, slot);
            if (!fn) return then(S_OK);
            callbackManager.invokeCallback(fn, [callback, ...args], (args.length + 1) * 4, then, false, `urlmon-${label}`, frameId);
            return null;
        };
        const finish = (): number => {
            const hr = data ? this.finishBind(mon, data, iid, ppv, async, stream ?? undefined) : this.finishBind(mon, null, iid, ppv, false);
            stream?.release();
            binding.release();
            this.process.memory.free(scratch);
            return hr >>> 0;
        };
        const onStop = (): number | null => call(BSC_ON_STOP_BINDING, [resultHr, 0], "OnStopBinding", () => finish());
        const onData = (): number | null => {
            if (!stream) return onStop();
            Mem.writeUint32(pFormat + 8, DVASPECT_CONTENT);
            Mem.writeUint32(pFormat + 12, 0xffffffff);
            Mem.writeUint32(pFormat + 16, TYMED_ISTREAM);
            Mem.writeUint32(pMedium, TYMED_ISTREAM);
            Mem.writeUint32(pMedium + 4, this.addressOf(stream, "IStream"));
            Mem.writeUint32(pMedium + 8, bindingPtr);
            return call(BSC_ON_DATA_AVAILABLE, [BSCF_FIRST_LAST_FULL, stream.length, pFormat, pMedium], "OnDataAvailable", () => onStop());
        };
        const onStart = (): number | null => call(BSC_ON_START_BINDING, [0, bindingPtr], "OnStartBinding", (hr) => {
            // A callback that refuses to start aborts the bind with its own answer.
            if ((hr | 0) < 0) {
                binding.result = hr >>> 0;
                return onStop();
            }
            return onData();
        });
        const afterBindInfo = (): number | null => {
            async = ((Mem.readUint32(pGrfBindf) ?? 0) & BINDF_ASYNCHRONOUS) !== 0;
            return onStart();
        };

        Logger.log(LogCategory.COM, `urlmon: bind ${mon.url} through status callback 0x${callback.toString(16)}`);
        const fn = readVtblSlot(callback, BSC_GET_BIND_INFO);
        if (!fn) {
            this.process.memory.free(scratch);
            stream?.release();
            binding.release();
            return null;
        }
        const { callbackId } = callbackManager.invokeCallback(
            fn, [callback, pGrfBindf, pBindInfo], 12, () => afterBindInfo(), false, "urlmon-GetBindInfo", frameId,
        );
        return { value: S_OK, suspendedForCallback: true, callbackId, stackCleanup: BIND_STACK_CLEANUP };
    }

    // ── IBinding ────────────────────────────────────────────────────────────────

    private registerBindingExports(): void {
        const e = this.exports;
        const define = (name: string, fn: (b: BindingObject, a: number[]) => number): void => {
            e[`IBinding_${name}`] = (_c, _m, a) => {
                const b = this.object(a[0], BindingObject);
                return b ? fn(b, a) | 0 : E_POINTER | 0;
            };
        };
        define("Abort", () => S_OK);
        define("Suspend", () => E_NOTIMPL);
        define("Resume", () => E_NOTIMPL);
        define("SetPriority", () => S_OK);
        define("GetPriority", (_b, a) => {
            out32(a[1] >>> 0, 0);
            return S_OK;
        });
        define("GetBindResult", (b, a) => {
            const pclsid = a[1] >>> 0;
            if (validPointer(pclsid, 16, "rw")) Mem.writeBytes(pclsid, new Uint8Array(16));
            out32(a[2] >>> 0, b.result);
            out32(a[3] >>> 0, 0);
            return S_OK;
        });
    }
}
