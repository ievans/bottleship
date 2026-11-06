/**
 * The Direct3D 11 device, immediate context and DXGI objects, as guest COM objects.
 *
 * Each object is a guest COM block whose vtable dispatches to the handlers below; the
 * handlers decode guest arguments and drive the WebGPU renderer
 * (backends/webgpu/d3d11/renderer.ts). Methods with no handler succeed as no-ops, and an
 * unanswered Create* writes NULL and returns E_NOTIMPL so the caller never holds garbage.
 *
 * Every call is also counted in `globalThis.__d3d11Trace` (read it with the harness's
 * evalWorker): the per-method census and a ring of recent calls are the quickest way to see
 * what a renderer does that this device does not.
 */

import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { installComVtable } from "../../core/com/install-com-vtable";
import { allocateComObject, freeComObject } from "../../core/com/com-memory";
import { Mem } from "../../core/memory/mem-accessor";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { INTERFACES, IID, iidName } from "./interfaces";
import {
    D3D11Renderer, type BufferRes, type TextureRes, type ViewRes, type ShaderRes, type InputLayoutRes,
    type SamplerRes, type StateRes, type InputElement,
} from "../../backends/webgpu/d3d11/renderer";
import type { BlendState, RasterState, DepthStencilState } from "../../backends/webgpu/d3d11/states";

const S_OK = 0;
const S_FALSE = 1;
const E_NOINTERFACE = 0x80004002;
/** D3D11_MAP: READ = 1, WRITE = 2, READ_WRITE = 3, WRITE_DISCARD = 4, WRITE_NO_OVERWRITE = 5. */
const MAP_READ = 1, MAP_READ_WRITE = 3;
const E_POINTER = 0x80004003;
const E_NOTIMPL = 0x80004001;
const E_FAIL = 0x80004005;
const E_INVALIDARG = 0x80070057;
const DXGI_ERROR_NOT_FOUND = 0x887a0002;
const COM_MODULE = "d3d11_com";
const RECENT_CALLS = 400;
const BIND_SHADER_RESOURCE = 0x8, BIND_RENDER_TARGET = 0x20;

interface TraceRecord {
    counts: Record<string, number>;
    recent: Array<{ m: string; a: string[]; r: string }>;
    presents: number;
}

type Res = BufferRes | TextureRes | ViewRes | ShaderRes | InputLayoutRes | SamplerRes | StateRes<unknown>;

interface ComObj {
    /** The vtable layout (an INTERFACES key). */
    iface: string;
    /** The real interfaces the object answers QueryInterface for, beyond `iface` and IUnknown. */
    iids?: ReadonlyArray<keyof typeof IID>;
    refs: number;
    /** Device-level objects live as long as the device: their last Release frees nothing. */
    pinned?: boolean;
    aliases: Map<string, number>;
    desc?: Uint8Array;
    res?: Res;
    /** The resource a view was made from (ID3D11View::GetResource). */
    resource?: number;
    /** Guest memory Map hands out, per subresource, and how it is mapped. */
    maps?: Map<number, { ptr: number; size: number; rowPitch: number; type: number }>;
    queryType?: number;
    /** Swap chain: the current back buffer object. */
    backBuffer?: number;
}

/** Buffers and textures answer QueryInterface for ID3D11Resource as well as their own interface. */
const RESOURCE_IIDS = ["ID3D11Resource"] as const;

const hex = (n: number): string => "0x" + (n >>> 0).toString(16);
const f32 = (bits: number): number => new Float32Array(new Uint32Array([bits >>> 0]).buffer)[0]!;

function readGuid(ptr: number): string {
    const b = Mem.readBytes(ptr, 16);
    if (!b) return "?";
    const v = new DataView(b.buffer, b.byteOffset, 16);
    const h = (n: number, w: number) => n.toString(16).padStart(w, "0");
    const tail = Array.from(b.subarray(8), (x) => h(x, 2)).join("");
    return `${h(v.getUint32(0, true), 8)}-${h(v.getUint16(4, true), 4)}-${h(v.getUint16(6, true), 4)}-` +
        `${tail.slice(0, 4)}-${tail.slice(4)}`;
}

function writeWide(ptr: number, text: string, maxChars: number): void {
    const n = Math.min(text.length, maxChars - 1);
    const b = new Uint8Array(maxChars * 2);
    for (let i = 0; i < n; i++) b[i * 2] = text.charCodeAt(i) & 0xff;
    Mem.writeBytes(ptr, b);
}

const readU32 = (p: number): number => (Mem.readUint32(p) ?? 0) >>> 0;
const readF32 = (p: number): number => f32(readU32(p));
const readStruct = (p: number, size: number): Uint8Array | null => (p ? Mem.readBytes(p, size)?.slice() ?? null : null);
/**
 * D3D11_SRV_DIMENSION: 2 TEXTURE1D, 3 TEXTURE1DARRAY, 4 TEXTURE2D, 5 TEXTURE2DARRAY, 6 TEXTURE2DMS,
 * 7 TEXTURE2DMSARRAY, 8 TEXTURE3D, 9 TEXTURECUBE, 10 TEXTURECUBEARRAY. WebGPU has no 1D arrays,
 * and this device creates no multisampled textures, so the MS views read single-sample 2D.
 */
const SRV_DIM: Record<number, GPUTextureViewDimension> = { 2: "1d", 3: "2d-array", 4: "2d", 5: "2d-array", 6: "2d", 7: "2d-array", 8: "3d", 9: "cube", 10: "cube-array" };

export class D3D11Device {
    private readonly vtables = new Map<string, number>();
    private readonly objects = new Map<number, ComObj>();
    device = 0;
    private context = 0;
    private dxgiDevice = 0;
    private adapter = 0;
    private factory = 0;
    private output = 0;
    private readonly record: TraceRecord = { counts: {}, recent: [], presents: 0 };
    private readonly unimplemented = new Set<string>();

    constructor(private readonly process: Process, readonly featureLevel: number, private readonly renderer: D3D11Renderer) {
        (globalThis as Record<string, unknown>).__d3d11Trace = this.record;
        // The device itself, for harness probes that resolve guest pointers to resources.
        (globalThis as Record<string, unknown>).__d3d11Device = this;
    }

    // ---- objects ----

    private vtable(iface: string): number {
        let vt = this.vtables.get(iface);
        if (vt !== undefined) return vt;
        const methods = INTERFACES[iface]!;
        const handlers: Record<string, ThunkImplementation> = {};
        for (const [name, argCount] of methods) handlers[`${iface}_${name}`] = this.handler(iface, name, argCount);
        const installed = installComVtable(this.process, {
            moduleName: COM_MODULE,
            methods: methods.map(([name, argCount]) => ({ name: `${iface}_${name}`, argCount, stackCleanupBytes: argCount * 4 })),
            handlers,
            logLabel: iface,
        });
        if (!installed) throw new Error(`d3d11: could not install ${iface}`);
        vt = installed.vtableAddr;
        this.vtables.set(iface, vt);
        return vt;
    }

    /** A new object holding one reference, which belongs to whoever receives it. */
    private create(iface: string, extra: Partial<ComObj> = {}): number {
        const mem = this.process.getCurrentMemory();
        const ptr = allocateComObject(this.process.memory, mem, this.vtable(iface)) >>> 0;
        this.objects.set(ptr, { iface, refs: 1, aliases: new Map(), ...extra });
        return ptr;
    }

    /** Hand a just-created object to the caller: its first reference is theirs. */
    private give(pp: number, ptr: number): number {
        if (!pp) { this.release(ptr); return E_POINTER; }
        Mem.writeUint32(pp, ptr >>> 0);
        return S_OK;
    }

    /** Hand out an existing object, adding the caller's reference. */
    private out(pp: number, ptr: number): number {
        if (!pp) return E_POINTER;
        Mem.writeUint32(pp, ptr >>> 0);
        const o = this.objects.get(ptr);
        if (o) o.refs++;
        return S_OK;
    }

    /**
     * Drop one reference; the last one frees the guest COM block and whatever the object
     * holds (a view its resource, a swap chain its back buffer). GPU objects are left to
     * garbage collection: the context may still have them bound, which in D3D11 keeps them
     * alive.
     */
    private release(ptr: number): number {
        const o = this.objects.get(ptr >>> 0);
        if (!o) return 0;
        if (o.refs > 0) o.refs--;
        if (o.refs > 0 || o.pinned) return o.refs;
        this.objects.delete(ptr >>> 0);
        for (const m of o.maps?.values() ?? []) this.process.memory.free(m.ptr);
        if (o.resource) this.release(o.resource);
        if (o.backBuffer) this.release(o.backBuffer);
        freeComObject(this.process.memory, ptr >>> 0);
        return 0;
    }

    private res<T extends Res["kind"]>(ptr: number, kind: T): Extract<Res, { kind: T }> | null {
        const r = this.objects.get(ptr >>> 0)?.res;
        return r && r.kind === kind ? (r as Extract<Res, { kind: T }>) : null;
    }

    init(): void {
        this.device = this.create("ID3D11Device");
        this.context = this.create("ID3D11DeviceContext");
        this.dxgiDevice = this.create("IDXGIDevice");
        this.adapter = this.create("IDXGIAdapter");
        this.factory = this.create("IDXGIFactory");
        this.output = this.create("IDXGIOutput");
        for (const p of [this.device, this.context, this.dxgiDevice, this.adapter, this.factory, this.output]) this.objects.get(p)!.pinned = true;
        const dev = this.objects.get(this.device)!;
        for (const iid of [IID.IDXGIDevice, IID.IDXGIDevice1, IID.IDXGIObject]) dev.aliases.set(iid, this.dxgiDevice);
        this.objects.get(this.dxgiDevice)!.aliases.set(IID.ID3D11Device, this.device);
        this.objects.get(this.adapter)!.aliases.set(IID.IDXGIAdapter1, this.adapter);
        this.objects.get(this.factory)!.aliases.set(IID.IDXGIFactory1, this.factory);
    }

    get immediateContext(): number { return this.context; }

    // ---- dispatch ----

    private handler(iface: string, name: string, argCount: number): ThunkImplementation {
        const key = `${iface}::${name}`;
        return (_ctx, _mem, args) => {
            const impl = this.impls[name];
            if (!impl) {
                // Not implemented: say so once, NULL an object out-parameter, and fail rather than
                // report a success nothing backs.
                if (!this.unimplemented.has(key)) {
                    this.unimplemented.add(key);
                    Logger.warn(LogCategory.D3D9, `[D3D11] ${key} is not implemented (E_NOTIMPL)`);
                }
                if (/^(Create|Get|Enum|Open)/.test(name) && argCount > 1 && args[argCount - 1]) Mem.writeUint32(args[argCount - 1]! >>> 0, 0);
            }
            let result: number | Promise<number>;
            try {
                result = impl ? impl.call(this, args.map((a) => a >>> 0), iface) : E_NOTIMPL;
            } catch (e) {
                Logger.error(LogCategory.D3D9, `[D3D11] ${key} threw: ${e}`);
                result = E_INVALIDARG;
            }
            this.record.counts[key] = (this.record.counts[key] ?? 0) + 1;
            const note = (r: number) => {
                this.record.recent.push({ m: key, a: args.slice(1, argCount).map(hex), r: hex(r) });
                if (this.record.recent.length > RECENT_CALLS) this.record.recent.shift();
                return r >>> 0;
            };
            if (result instanceof Promise) return result.then(note) as Promise<number>;
            return note(result);
        };
    }

    private readonly impls: Record<string, (this: D3D11Device, a: number[], iface: string) => number | Promise<number>> = {
        QueryInterface(a) {
            const [self, riid, ppv] = a;
            const iid = readGuid(riid!);
            const obj = this.objects.get(self!);
            if (!ppv) return E_POINTER;
            const own = obj && (iid === IID.IUnknown || IID[obj.iface as keyof typeof IID] === iid
                || (obj.iface.startsWith("ID3D11") && obj.iface !== "ID3D11Device" && iid === IID.ID3D11DeviceChild)
                || obj.iids?.some((name) => IID[name] === iid));
            const target = own ? self! : obj?.aliases.get(iid);
            if (target === undefined) {
                Mem.writeUint32(ppv, 0);
                Logger.warn(LogCategory.D3D9, `[D3D11] ${obj?.iface ?? "?"}::QueryInterface(${iidName(iid)}) -> E_NOINTERFACE`);
                return E_NOINTERFACE;
            }
            return this.out(ppv, target);
        },
        AddRef(a) { const o = this.objects.get(a[0]!); return o ? ++o.refs : 1; },
        Release(a) { return this.release(a[0]!); },

        // ---- device: resources ----
        CreateBuffer(a) {
            // D3D11_BUFFER_DESC: ByteWidth, Usage, BindFlags, CPUAccessFlags, MiscFlags, StructureByteStride.
            const desc = readStruct(a[1]!, 24);
            if (!desc) return E_INVALIDARG;
            const v = new DataView(desc.buffer);
            const size = v.getUint32(0, true), bind = v.getUint32(8, true);
            const sysMem = a[2] ? readU32(a[2]!) : 0;
            const init = sysMem ? Mem.readBytes(sysMem, size) : null;
            const res = this.renderer.createBuffer(size, bind, init);
            if (!a[3]) return S_FALSE; // a parameter check: no object wanted
            return this.give(a[3]!, this.create("ID3D11Buffer", { desc, res, iids: RESOURCE_IIDS }));
        },
        CreateTexture2D(a) {
            // D3D11_TEXTURE2D_DESC: Width, Height, MipLevels, ArraySize, Format, SampleDesc, Usage, BindFlags, CPUAccessFlags, MiscFlags.
            const desc = readStruct(a[1]!, 44);
            if (!desc) return E_INVALIDARG;
            const v = new DataView(desc.buffer);
            const u = (o: number) => v.getUint32(o, true);
            const res = this.renderer.createTexture2D(u(0), u(4), u(8), u(12), u(16), u(32), u(40));
            if (res && a[2]) {
                for (let layer = 0; layer < res.layers; layer++) {
                    for (let mip = 0; mip < res.mips; mip++) {
                        const sub = a[2]! + (layer * res.mips + mip) * 12;
                        const ptr = readU32(sub), pitch = readU32(sub + 4);
                        if (!ptr || !pitch) continue;
                        const h = Math.max(1, res.height >> mip);
                        const rows = res.info.block ? Math.ceil(h / 4) : h;
                        const bytes = Mem.readBytes(ptr, pitch * rows);
                        if (bytes) this.renderer.writeTexture(res, mip, layer, bytes, pitch);
                    }
                }
            }
            if (!res) { if (a[3]) Mem.writeUint32(a[3]!, 0); return E_INVALIDARG; } // format the renderer cannot create
            if (!a[3]) return S_FALSE;
            return this.give(a[3]!, this.create("ID3D11Texture2D", { desc, res, iids: RESOURCE_IIDS }));
        },
        CreateShaderResourceView(a) {
            const tex = this.res(a[1]!, "texture");
            let view: ViewRes | undefined;
            if (tex) {
                const d = readStruct(a[2]!, 24);
                if (d) {
                    const v = new DataView(d.buffer);
                    const dim = SRV_DIM[v.getUint32(4, true)] ?? "2d";
                    const arr = dim === "2d-array" || dim === "cube-array";
                    view = this.renderer.createView(tex, v.getUint32(0, true), v.getUint32(8, true), v.getUint32(12, true),
                        arr ? v.getUint32(16, true) : 0, arr ? v.getUint32(20, true) : 1, dim, false);
                } else {
                    view = this.renderer.createView(tex, 0, 0, 0, 0, tex.layers, tex.layers > 1 ? "2d-array" : "2d", false);
                }
            }
            return this.view(a[1]!, view, a[3]!, "ID3D11ShaderResourceView");
        },
        CreateRenderTargetView(a) {
            const tex = this.res(a[1]!, "texture");
            let view: ViewRes | undefined;
            if (tex) {
                const d = readStruct(a[2]!, 20);
                const v = d ? new DataView(d.buffer) : null;
                const mip = v ? v.getUint32(8, true) : 0;
                const layer = v && v.getUint32(4, true) === 5 ? v.getUint32(12, true) : 0;
                view = this.renderer.createView(tex, v ? v.getUint32(0, true) : 0, mip, 1, layer, 1, "2d", true);
            }
            return this.view(a[1]!, view, a[3]!, "ID3D11RenderTargetView");
        },
        CreateDepthStencilView(a) {
            const tex = this.res(a[1]!, "texture");
            let view: ViewRes | undefined;
            if (tex) {
                const d = readStruct(a[2]!, 24);
                const mip = d ? new DataView(d.buffer).getUint32(12, true) : 0;
                view = this.renderer.createView(tex, 0, mip, 1, 0, 1, "2d", true);
            }
            return this.view(a[1]!, view, a[3]!, "ID3D11DepthStencilView");
        },
        CreateInputLayout(a) {
            // D3D11_INPUT_ELEMENT_DESC: SemanticName, SemanticIndex, Format, InputSlot, AlignedByteOffset, InputSlotClass, InstanceDataStepRate.
            const elements: InputElement[] = [];
            for (let i = 0; i < a[2]!; i++) {
                const e = a[1]! + i * 28;
                const namePtr = readU32(e);
                const nameBytes = namePtr ? Mem.readBytes(namePtr, 64) : null;
                const end = nameBytes ? nameBytes.indexOf(0) : 0;
                elements.push({
                    semantic: nameBytes ? String.fromCharCode(...nameBytes.subarray(0, end < 0 ? 64 : end)) : "",
                    index: readU32(e + 4), format: readU32(e + 8), slot: readU32(e + 12), offset: readU32(e + 16),
                    perInstance: readU32(e + 20) === 1, stepRate: readU32(e + 24),
                });
            }
            return this.give(a[5]!, this.create("ID3D11Shader", { res: this.renderer.createInputLayout(elements), iids: ["ID3D11InputLayout"] }));
        },
        CreateVertexShader(a) { return this.shader("vertex", a[1]!, a[2]!, a[4]!); },
        CreatePixelShader(a) { return this.shader("pixel", a[1]!, a[2]!, a[4]!); },
        CreateGeometryShader(a) { return this.shader("geometry", a[1]!, a[2]!, a[4]!); },
        CreateGeometryShaderWithStreamOutput(a) { return this.shader("geometry", a[1]!, a[2]!, a[9]!); },
        CreateBlendState(a) { return this.give(a[2]!, this.create("ID3D11State", { desc: readStruct(a[1]!, 264) ?? undefined, res: this.renderer.blendState(readStruct(a[1]!, 264)), iids: ["ID3D11BlendState"] })); },
        CreateDepthStencilState(a) { return this.give(a[2]!, this.create("ID3D11State", { desc: readStruct(a[1]!, 52) ?? undefined, res: this.renderer.depthStencilState(readStruct(a[1]!, 52)), iids: ["ID3D11DepthStencilState"] })); },
        CreateRasterizerState(a) { return this.give(a[2]!, this.create("ID3D11State", { desc: readStruct(a[1]!, 40) ?? undefined, res: this.renderer.rasterState(readStruct(a[1]!, 40)), iids: ["ID3D11RasterizerState"] })); },
        CreateSamplerState(a) { return this.give(a[2]!, this.create("ID3D11State", { desc: readStruct(a[1]!, 52) ?? undefined, res: this.renderer.createSampler(readStruct(a[1]!, 52)), iids: ["ID3D11SamplerState"] })); },
        CreateQuery(a) { return a[2] ? this.give(a[2]!, this.create("ID3D11Query", { queryType: a[1] ? readU32(a[1]!) : 0, iids: ["ID3D11Asynchronous"] })) : S_FALSE; },
        CreatePredicate(a) { return a[2] ? this.give(a[2]!, this.create("ID3D11Query", { queryType: 1, iids: ["ID3D11Asynchronous", "ID3D11Predicate"] })) : S_FALSE; },
        CheckFormatSupport(a) {
            const bits = this.renderer.formatSupport(a[1]!);
            if (a[2]) Mem.writeUint32(a[2]!, bits);
            return bits ? S_OK : E_FAIL;
        },
        CheckMultisampleQualityLevels(a) { if (a[3]) Mem.writeUint32(a[3]!, a[2] === 1 ? 1 : 0); return S_OK; },
        CheckFeatureSupport(a) { if (a[2]) Mem.writeBytes(a[2]!, new Uint8Array(a[3]!)); return S_OK; },
        GetFeatureLevel() { return this.featureLevel; },
        GetImmediateContext(a) { this.out(a[1]!, this.context); return 0; },
        GetDevice(a, iface) {
            if (iface === "IDXGISwapChain") return this.impls.QueryInterface!.call(this, [this.device, a[1]!, a[2]!], iface);
            this.out(a[1]!, this.device);
            return 0;
        },
        GetDeviceRemovedReason() { return S_OK; },

        // ---- context: input assembler ----
        IASetInputLayout(a) { this.renderer.setInputLayout(this.res(a[1]!, "layout")); return 0; },
        IASetVertexBuffers(a) {
            const [, start, n, ppVB, pStrides, pOffsets] = a;
            for (let i = 0; i < n!; i++) {
                const buf = this.res(readU32(ppVB! + i * 4), "buffer");
                this.renderer.setVertexBuffer(start! + i, buf, pStrides ? readU32(pStrides + i * 4) : 0, pOffsets ? readU32(pOffsets + i * 4) : 0);
            }
            return 0;
        },
        IASetIndexBuffer(a) { this.renderer.setIndexBuffer(this.res(a[1]!, "buffer"), a[2]!, a[3]!); return 0; },
        IASetPrimitiveTopology(a) { this.renderer.setTopology(a[1]!); return 0; },

        // ---- context: shader stages ----
        VSSetShader(a) { this.renderer.setShader("vs", this.res(a[1]!, "shader")); return 0; },
        PSSetShader(a) { this.renderer.setShader("ps", this.res(a[1]!, "shader")); return 0; },
        GSSetShader(a) { this.renderer.setShader("gs", this.res(a[1]!, "shader")); return 0; },
        // Draws with a geometry shader are skipped, so its resources have nowhere to go yet.
        GSSetConstantBuffers() { return 0; },
        GSSetShaderResources() { return 0; },
        GSSetSamplers() { return 0; },
        VSSetConstantBuffers(a) { return this.stageBuffers("vs", a); },
        PSSetConstantBuffers(a) { return this.stageBuffers("ps", a); },
        VSSetShaderResources(a) { return this.stageViews("vs", a); },
        PSSetShaderResources(a) { return this.stageViews("ps", a); },
        VSSetSamplers(a) { return this.stageSamplers("vs", a); },
        PSSetSamplers(a) { return this.stageSamplers("ps", a); },

        // ---- context: rasterizer and output merger ----
        RSSetState(a) { this.renderer.setRaster(this.res(a[1]!, "state")?.value as RasterState ?? null); return 0; },
        RSSetViewports(a) {
            if (!a[1] || !a[2]) return 0;
            const p = a[2]!;
            this.renderer.setViewport({ x: readF32(p), y: readF32(p + 4), w: readF32(p + 8), h: readF32(p + 12), minDepth: readF32(p + 16), maxDepth: readF32(p + 20) });
            return 0;
        },
        RSSetScissorRects(a) {
            if (!a[1] || !a[2]) { this.renderer.setScissor(null); return 0; }
            const p = a[2]!;
            const l = readU32(p) | 0, t = readU32(p + 4) | 0, r = readU32(p + 8) | 0, b = readU32(p + 12) | 0;
            this.renderer.setScissor({ x: l, y: t, w: Math.max(0, r - l), h: Math.max(0, b - t) });
            return 0;
        },
        OMSetRenderTargets(a) {
            const rtvs: Array<ViewRes | null> = [];
            for (let i = 0; i < a[1]!; i++) rtvs.push(this.res(readU32(a[2]! + i * 4), "view"));
            this.renderer.setRenderTargets(rtvs, this.res(a[3]!, "view"));
            return 0;
        },
        OMSetBlendState(a) {
            const p = a[2]!;
            const factor = p ? { r: readF32(p), g: readF32(p + 4), b: readF32(p + 8), a: readF32(p + 12) } : null;
            this.renderer.setBlend(this.res(a[1]!, "state")?.value as BlendState ?? null, factor);
            return 0;
        },
        OMSetDepthStencilState(a) { this.renderer.setDepthStencil(this.res(a[1]!, "state")?.value as DepthStencilState ?? null, a[2]!); return 0; },

        // ---- context: draws ----
        Draw(a) { this.renderer.draw(a[1]!, 1, a[2]!, 0, false); return 0; },
        DrawIndexed(a) { this.renderer.draw(a[1]!, 1, a[2]!, 0, true, a[3]! | 0); return 0; },
        DrawInstanced(a) { this.renderer.draw(a[1]!, a[2]!, a[3]!, a[4]!, false); return 0; },
        DrawIndexedInstanced(a) { this.renderer.draw(a[1]!, a[2]!, a[3]!, a[5]!, true, a[4]! | 0); return 0; },
        ClearRenderTargetView(a) {
            const v = this.res(a[1]!, "view");
            const p = a[2]!;
            if (v && p) this.renderer.clearRenderTarget(v, { r: readF32(p), g: readF32(p + 4), b: readF32(p + 8), a: readF32(p + 12) });
            return 0;
        },
        ClearDepthStencilView(a) {
            const v = this.res(a[1]!, "view");
            if (v) this.renderer.clearDepthStencil(v, a[2]!, f32(a[3]!), a[4]! & 0xff);
            return 0;
        },
        ClearState() { this.renderer.setShader("vs", null); this.renderer.setShader("ps", null); this.renderer.setShader("gs", null); return 0; },

        // ---- context: resource updates ----
        Map(a) {
            const [, resPtr, sub, mapType, , pMapped] = a;
            const o = this.objects.get(resPtr!);
            if (!o?.res || !pMapped || (o.res.kind !== "buffer" && o.res.kind !== "texture")) return E_INVALIDARG;
            const census = `Map:${o.res.kind}:type${mapType}`;
            this.record.counts[census] = (this.record.counts[census] ?? 0) + 1;
            const layout = this.subresourceLayout(o.res, sub!);
            if (!layout) return E_INVALIDARG;
            o.maps ??= new Map();
            let m = o.maps.get(sub!);
            if (!m) {
                const ptr = this.process.memory.alloc(Math.max(layout.size, 16), "HEAP", "rw") >>> 0;
                if (o.res.kind === "buffer") Mem.writeBytes(ptr, o.res.shadow.subarray(0, o.res.size));
                m = { ptr, size: layout.size, rowPitch: layout.rowPitch, type: mapType! };
                o.maps.set(sub!, m);
            }
            m.type = mapType!;
            const mapping = m;
            const answer = (): number => {
                Mem.writeUint32(pMapped!, mapping.ptr);
                Mem.writeUint32(pMapped! + 4, mapping.rowPitch);
                Mem.writeUint32(pMapped! + 8, mapping.size);
                return S_OK;
            };
            // A READ or READ_WRITE map of a texture sees what the GPU holds: a staging copy of
            // a render target (Rise of Nations builds its minimap this way) reads back here.
            if (o.res.kind === "texture" && (mapType === MAP_READ || mapType === MAP_READ_WRITE)) {
                return this.renderer.readTextureData(o.res, layout.mip, layout.layer).then((data) => {
                    if (data) Mem.writeBytes(mapping.ptr, data.bytes.subarray(0, mapping.size));
                    return answer();
                });
            }
            return answer();
        },
        Unmap(a) {
            const o = this.objects.get(a[1]!);
            const m = o?.maps?.get(a[2]!);
            if (!o?.res || !m) return 0;
            if (m.type === MAP_READ) return 0; // nothing written: leave the GPU copy as it is
            const bytes = Mem.readBytes(m.ptr, m.size);
            if (!bytes) return 0;
            if (o.res.kind === "buffer") this.renderer.updateBuffer(o.res, bytes, 0, m.type);
            else if (o.res.kind === "texture") {
                const layout = this.subresourceLayout(o.res, a[2]!)!;
                this.renderer.writeTexture(o.res, layout.mip, layout.layer, bytes, m.rowPitch);
            }
            return 0;
        },
        UpdateSubresource(a) {
            const [, resPtr, sub, pBox, pSrc, rowPitch] = a;
            const o = this.objects.get(resPtr!);
            if (!o?.res || !pSrc) return 0;
            const box = pBox ? { l: readU32(pBox), t: readU32(pBox + 4), r: readU32(pBox + 12), b: readU32(pBox + 16) } : null;
            if (o.res.kind === "buffer") {
                const lo = box ? box.l : 0, hi = box ? box.r : o.res.size;
                const bytes = Mem.readBytes(pSrc, Math.max(0, hi - lo));
                if (bytes) this.renderer.updateBuffer(o.res, bytes, lo, 0);
            } else if (o.res.kind === "texture") {
                const tex = o.res;
                const mip = sub! % tex.mips, layer = Math.floor(sub! / tex.mips);
                const mw = Math.max(1, tex.width >> mip), mh = Math.max(1, tex.height >> mip);
                const r = box ? { x: box.l, y: box.t, w: box.r - box.l, h: box.b - box.t } : { x: 0, y: 0, w: mw, h: mh };
                const rows = tex.info.block ? Math.ceil(r.h / 4) : r.h;
                const bytes = Mem.readBytes(pSrc, rowPitch! * Math.max(1, rows));
                if (bytes && r.w > 0 && r.h > 0) this.renderer.writeTexture(tex, mip, layer, bytes, rowPitch!, r);
            }
            return 0;
        },
        CopySubresourceRegion(a) {
            const [, dstPtr, dstSub, dx, dy, , srcPtr, srcSub, pBox] = a;
            const dst = this.objects.get(dstPtr!)?.res, src = this.objects.get(srcPtr!)?.res;
            // D3D11_BOX: left, top, front, right, bottom, back.
            const box = pBox ? { l: readU32(pBox), t: readU32(pBox + 4), r: readU32(pBox + 12), b: readU32(pBox + 16) } : null;
            if (dst?.kind === "texture" && src?.kind === "texture") {
                this.renderer.copyTextureRegion(dst, dstSub! % dst.mips, Math.floor(dstSub! / dst.mips), dx!, dy!,
                    src, srcSub! % src.mips, Math.floor(srcSub! / src.mips),
                    box && { x: box.l, y: box.t, w: box.r - box.l, h: box.b - box.t });
            } else if (dst?.kind === "buffer" && src?.kind === "buffer") {
                this.renderer.copyBufferRegion(dst, dx!, src, box ? box.l : 0, box ? box.r : src.size);
            }
            return 0;
        },
        CopyResource(a) {
            const dst = this.objects.get(a[1]!)?.res, src = this.objects.get(a[2]!)?.res;
            if (dst?.kind === "texture" && src?.kind === "texture") this.renderer.copyTexture(dst, src);
            else if (dst?.kind === "buffer" && src?.kind === "buffer") this.renderer.copyBuffer(dst, src);
            return 0;
        },
        GenerateMips(a) { const v = this.res(a[1]!, "view"); if (v) this.renderer.generateMips(v.texture); return 0; },
        GetData(a) {
            const o = this.objects.get(a[1]!);
            if (a[2] && a[3]) {
                Mem.writeBytes(a[2]!, new Uint8Array(a[3]!));
                // An event has completed, and an occlusion query saw its geometry.
                if (o?.queryType === 0 || o?.queryType === 1 || o?.queryType === 2) Mem.writeUint32(a[2]!, 1);
            }
            return S_OK;
        },

        // ---- views and resources ----
        GetDesc(a, iface) {
            const o = this.objects.get(a[0]!);
            if (!a[1]) return 0;
            if (iface === "IDXGIAdapter") return this.adapterDesc(a[1]!);
            if (iface === "IDXGIOutput") return this.outputDesc(a[1]!);
            if (o?.desc) Mem.writeBytes(a[1]!, o.desc);
            return 0;
        },
        GetResource(a) { const o = this.objects.get(a[0]!); this.out(a[1]!, o?.resource ?? 0); return 0; },

        // ---- DXGI ----
        GetParent(a, iface) {
            const iid = readGuid(a[1]!);
            const parent = iface === "IDXGIDevice" ? this.adapter : iface === "IDXGIAdapter" ? this.factory
                : iface === "IDXGIOutput" ? this.adapter : this.factory;
            const p = this.objects.get(parent)!;
            if (IID[p.iface as keyof typeof IID] !== iid && !p.aliases.has(iid)) {
                Mem.writeUint32(a[2]!, 0);
                return E_NOINTERFACE;
            }
            return this.out(a[2]!, parent);
        },
        GetAdapter(a) { return this.out(a[1]!, this.adapter); },
        EnumAdapters(a) { return a[1] === 0 ? this.out(a[2]!, this.adapter) : DXGI_ERROR_NOT_FOUND; },
        EnumAdapters1(a) { return a[1] === 0 ? this.out(a[2]!, this.adapter) : DXGI_ERROR_NOT_FOUND; },
        EnumOutputs(a) { return a[1] === 0 ? this.out(a[2]!, this.output) : DXGI_ERROR_NOT_FOUND; },
        GetContainingOutput(a) { return this.out(a[1]!, this.output); },
        IsCurrent() { return 1; },
        SetMaximumFrameLatency() { return S_OK; },
        GetMaximumFrameLatency(a) { if (!a[1]) return E_INVALIDARG; Mem.writeUint32(a[1]!, 3); return S_OK; },
        GetDesc1(a) {
            if (!a[1]) return E_INVALIDARG;
            this.adapterDesc(a[1]!);
            Mem.writeUint32(a[1]! + 292, 0); // DXGI_ADAPTER_DESC1::Flags: a hardware adapter
            return S_OK;
        },
        GetDisplayModeList(a) { return this.modeList(a[1]!, a[3]!, a[4]!); },
        FindClosestMatchingMode(a) { const m = Mem.readBytes(a[1]!, 28); if (m && a[2]) Mem.writeBytes(a[2]!, m); return S_OK; },
        CreateSwapChain(a) {
            // DXGI_SWAP_CHAIN_DESC: BufferDesc (DXGI_MODE_DESC, 28), SampleDesc (8), BufferUsage, BufferCount,
            // OutputWindow, Windowed, SwapEffect, Flags.
            const desc = readStruct(a[2]!, 60);
            if (!desc) return E_INVALIDARG;
            const v = new DataView(desc.buffer);
            const chain = this.create("IDXGISwapChain", { desc });
            this.objects.get(chain)!.backBuffer = this.backBuffer(v.getUint32(0, true), v.getUint32(4, true), v.getUint32(16, true));
            const windowed = v.getUint32(48, true) !== 0;
            System.getInstance().requestHostResize(v.getUint32(0, true), v.getUint32(4, true), { modeSet: !windowed });
            this.renderer.presentsExclusiveFullscreen = !windowed;
            return this.give(a[3]!, chain);
        },
        GetBuffer(a) { return this.out(a[3]!, this.objects.get(a[0]!)?.backBuffer ?? 0); },
        ResizeBuffers(a) {
            const o = this.objects.get(a[0]!);
            if (!o?.desc) return E_INVALIDARG;
            const v = new DataView(o.desc.buffer);
            const w = a[2] || v.getUint32(0, true), h = a[3] || v.getUint32(4, true), fmt = a[4] || v.getUint32(16, true);
            v.setUint32(0, w, true); v.setUint32(4, h, true); v.setUint32(16, fmt, true);
            if (o.backBuffer) this.release(o.backBuffer);
            o.backBuffer = this.backBuffer(w, h, fmt);
            System.getInstance().requestHostResize(w, h, { modeSet: this.renderer.presentsExclusiveFullscreen });
            return S_OK;
        },
        SetFullscreenState(a) {
            const o = this.objects.get(a[0]!);
            this.renderer.presentsExclusiveFullscreen = a[1] !== 0;
            if (o?.desc) {
                const v = new DataView(o.desc.buffer);
                System.getInstance().requestHostResize(v.getUint32(0, true), v.getUint32(4, true), { modeSet: a[1] !== 0 });
            }
            return S_OK;
        },
        GetFullscreenState(a) {
            if (a[1]) Mem.writeUint32(a[1]!, this.renderer.presentsExclusiveFullscreen ? 1 : 0);
            if (a[2]) Mem.writeUint32(a[2]!, 0);
            return S_OK;
        },
        Present(a) {
            const o = this.objects.get(a[0]!);
            const bb = o?.backBuffer ? this.res(o.backBuffer, "texture") : null;
            this.record.presents++;
            if (!bb) return S_OK;
            return this.renderer.present(bb, a[1]!).then(() => S_OK);
        },
    };

    // ---- helpers ----

    /** A view object: it holds a reference on its resource, as D3D11 views do. */
    private view(resourcePtr: number, view: ViewRes | undefined, pp: number, iid: keyof typeof IID): number {
        if (!view) { if (pp) Mem.writeUint32(pp, 0); return E_INVALIDARG; }
        if (!pp) return S_FALSE;
        const resource = this.objects.get(resourcePtr);
        if (resource) resource.refs++;
        return this.give(pp, this.create("ID3D11View", { res: view, resource: resourcePtr, iids: ["ID3D11View", iid] }));
    }

    /** Where subresource `sub` lives and how Map lays it out: tightly packed rows, mip size. */
    private subresourceLayout(res: BufferRes | TextureRes, sub: number): { mip: number; layer: number; rowPitch: number; size: number } | null {
        if (res.kind === "buffer") return sub === 0 ? { mip: 0, layer: 0, rowPitch: res.size, size: res.size } : null;
        const mip = sub % res.mips, layer = Math.floor(sub / res.mips);
        if (layer >= res.layers) return null;
        const w = Math.max(1, res.width >> mip), h = Math.max(1, res.height >> mip);
        const rowPitch = res.info.block ? Math.ceil(w / 4) * res.info.bytes : w * res.info.bytes;
        const rows = res.info.block ? Math.ceil(h / 4) : h;
        return { mip, layer, rowPitch, size: rowPitch * rows };
    }

    private shader(stage: ShaderRes["stage"], code: number, length: number, pp: number): number {
        const bytes = Mem.readBytes(code, length);
        const res = this.renderer.createShader(stage, bytes ? bytes.slice() : new Uint8Array(0));
        const iid = stage === "vertex" ? "ID3D11VertexShader" : stage === "pixel" ? "ID3D11PixelShader" : "ID3D11GeometryShader";
        return this.give(pp, this.create("ID3D11Shader", { res, iids: [iid] }));
    }

    private stageBuffers(stage: "vs" | "ps", a: number[]): number {
        for (let i = 0; i < a[2]!; i++) this.renderer.setConstantBuffer(stage, a[1]! + i, this.res(readU32(a[3]! + i * 4), "buffer"));
        return 0;
    }

    private stageViews(stage: "vs" | "ps", a: number[]): number {
        for (let i = 0; i < a[2]!; i++) this.renderer.setShaderResource(stage, a[1]! + i, this.res(readU32(a[3]! + i * 4), "view"));
        return 0;
    }

    private stageSamplers(stage: "vs" | "ps", a: number[]): number {
        for (let i = 0; i < a[2]!; i++) this.renderer.setSampler(stage, a[1]! + i, this.res(readU32(a[3]! + i * 4), "sampler"));
        return 0;
    }

    /** A swap-chain back buffer: a render-target texture the game can also sample. */
    private backBuffer(w: number, h: number, fmt: number): number {
        const desc = new Uint8Array(44);
        const t = new DataView(desc.buffer);
        t.setUint32(0, w, true); t.setUint32(4, h, true); t.setUint32(8, 1, true); t.setUint32(12, 1, true);
        t.setUint32(16, fmt, true); t.setUint32(20, 1, true); t.setUint32(32, BIND_RENDER_TARGET | BIND_SHADER_RESOURCE, true);
        const res = this.renderer.createTexture2D(w, h, 1, 1, fmt, BIND_RENDER_TARGET | BIND_SHADER_RESOURCE, 0);
        return this.create("ID3D11Texture2D", { desc, res: res ?? undefined });
    }

    private adapterDesc(p: number): number {
        // DXGI_ADAPTER_DESC: Description[128], VendorId, DeviceId, SubSysId, Revision,
        // DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory (SIZE_T), LUID.
        Mem.writeBytes(p, new Uint8Array(292));
        writeWide(p, "BottleShip WebGPU Adapter", 128);
        Mem.writeUint32(p + 256, 0x10de);
        Mem.writeUint32(p + 260, 0x1180);
        Mem.writeUint32(p + 272, 512 * 1024 * 1024);
        Mem.writeUint32(p + 280, 512 * 1024 * 1024);
        return S_OK;
    }

    private outputDesc(p: number): number {
        // DXGI_OUTPUT_DESC: DeviceName[32], DesktopCoordinates, AttachedToDesktop, Rotation, Monitor.
        Mem.writeBytes(p, new Uint8Array(92));
        writeWide(p, "\\\\.\\DISPLAY1", 32);
        Mem.writeUint32(p + 72, 1024);
        Mem.writeUint32(p + 76, 768);
        Mem.writeUint32(p + 80, 1);
        Mem.writeUint32(p + 84, 1);
        return S_OK;
    }

    private modeList(format: number, pNum: number, pDesc: number): number {
        const modes = [[800, 600], [1024, 768], [1280, 720], [1280, 1024], [1600, 900], [1920, 1080]];
        if (!pNum) return E_POINTER;
        if (!pDesc) { Mem.writeUint32(pNum, modes.length); return S_OK; }
        const n = Math.min(readU32(pNum), modes.length);
        for (let i = 0; i < n; i++) {
            const m = pDesc + i * 28;
            Mem.writeBytes(m, new Uint8Array(28));
            Mem.writeUint32(m, modes[i]![0]!);
            Mem.writeUint32(m + 4, modes[i]![1]!);
            Mem.writeUint32(m + 8, 60);
            Mem.writeUint32(m + 12, 1);
            Mem.writeUint32(m + 16, format);
        }
        Mem.writeUint32(pNum, n);
        return S_OK;
    }
}
