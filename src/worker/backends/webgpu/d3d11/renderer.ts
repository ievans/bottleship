/**
 * Direct3D 11 on WebGPU: resources, the immediate context's state, and draw execution.
 *
 * Commands are recorded into one encoder per frame and submitted at Present, so anything
 * written through the queue (writeBuffer/writeTexture) would land before every draw of the
 * frame. Two rules keep D3D11's in-order semantics:
 *  - A buffer update made mid-frame goes to a fresh slice of a per-frame upload arena, and
 *    draws bind that slice; draws recorded earlier keep the slice they saw. NO_OVERWRITE
 *    maps write only the bytes that changed, in place, which is what the flag promises is
 *    safe. After submit every buffer's latest bytes are written back to its own GPUBuffer.
 *  - A texture write first submits whatever has been recorded.
 */

import { Logger, LogCategory } from "../../../core/logger";
import { recordGpuError } from "../../../core/gpu-error-log";
import { framePacer } from "../../../core/frame-pacer";
import { System } from "../../../core/system";
import { statsOverlay } from "../../../core/stats-overlay";
import { getOverlayCompositePlan } from "../../../modules/user32/dialog-overlay";
import type { RenderActive } from "../../../runtime/runtime-services";
import type { WebGPUBackend } from "../webgpu-backend";
import { parseDxbc, type DxbcContainer } from "./sm4/dxbc";
import { pixelLinkage, translateShader, semanticKey, type TranslatedShader, type ShaderBindings,
    CB_BINDING_BASE, TEXTURE_BINDING_BASE, SAMPLER_BINDING_BASE, UnsupportedShader } from "./sm4/wgsl";
import { textureFormat, viewFormat, vertexFormat, isFloat32Format, isDepthFamily, type FormatFeatures, type TextureFormatInfo } from "./formats";
import { decodeBlend, decodeRaster, decodeDepthStencil, decodeSampler, type BlendState, type RasterState, type DepthStencilState } from "./states";
import * as frameCapture from "../../../modules/ddraw/frame-capture";

const BIND_VERTEX = 0x1, BIND_INDEX = 0x2, BIND_CONSTANT = 0x4, BIND_RENDER_TARGET = 0x20, BIND_DEPTH_STENCIL = 0x40;
const MISC_GENERATE_MIPS = 0x1;
const MAP_WRITE_DISCARD = 4, MAP_WRITE_NO_OVERWRITE = 5;
const ARENA_ALIGN = 256;
const ARENA_INITIAL = 4 << 20;

export interface BufferRes {
    kind: "buffer";
    size: number;
    bind: number;
    gpu: GPUBuffer;
    shadow: Uint8Array;
    /** Where draws read the buffer now: its own GPUBuffer or an arena slice. */
    current: { buffer: GPUBuffer; offset: number };
}

export interface TextureRes {
    kind: "texture";
    width: number; height: number; mips: number; layers: number;
    dxgi: number;
    info: TextureFormatInfo;
    gpu: GPUTexture;
    generateMips: boolean;
}

export interface ViewRes {
    kind: "view";
    texture: TextureRes;
    view: GPUTextureView;
    format: GPUTextureFormat;
    baseMip: number;
}

export interface ShaderRes {
    kind: "shader";
    stage: "vertex" | "pixel" | "geometry";
    id: number;
    dxbc: DxbcContainer | null;
    standalone?: TranslatedShader;
    error?: string;
}

export interface InputElement { semantic: string; index: number; format: number; slot: number; offset: number; perInstance: boolean; stepRate: number }
export interface InputLayoutRes { kind: "layout"; id: number; elements: InputElement[] }
export interface StateRes<T> { kind: "state"; value: T }
export interface SamplerRes { kind: "sampler"; sampler: GPUSampler; comparison: boolean }

interface Viewport { x: number; y: number; w: number; h: number; minDepth: number; maxDepth: number }

// @transient(host renderer identity sequence; no guest pointer or persisted state)
let nextId = 1;

export class D3D11Renderer implements RenderActive {
    readonly suppressGdiOverlay = true;
    presentsExclusiveFullscreen = false;

    private readonly device: GPUDevice;
    private encoder: GPUCommandEncoder | null = null;
    private pass: GPURenderPassEncoder | null = null;
    private passKey = "";
    private passWidth = 1;
    private passHeight = 1;

    private arena: GPUBuffer;
    private arenaCursor = 0;
    private readonly arenaResident = new Set<BufferRes>();

    // Immediate-context state.
    private vs: ShaderRes | null = null;
    private ps: ShaderRes | null = null;
    private gs: ShaderRes | null = null;
    private layout: InputLayoutRes | null = null;
    private topology = 4;
    private readonly vbs: Array<{ buf: BufferRes; stride: number; offset: number } | null> = [];
    private ib: { buf: BufferRes; format: GPUIndexFormat; offset: number } | null = null;
    private readonly cbs: Record<"vs" | "ps", Array<BufferRes | null>> = { vs: [], ps: [] };
    private readonly srvs: Record<"vs" | "ps", Array<ViewRes | null>> = { vs: [], ps: [] };
    private readonly samplers: Record<"vs" | "ps", Array<SamplerRes | null>> = { vs: [], ps: [] };
    private rtvs: Array<ViewRes | null> = [];
    private dsv: ViewRes | null = null;
    private blend: BlendState = decodeBlend(null);
    private blendFactor: GPUColor = { r: 1, g: 1, b: 1, a: 1 };
    private raster: RasterState = decodeRaster(null);
    private depthStencil: DepthStencilState = decodeDepthStencil(null);
    private stencilRef = 0;
    private viewport: Viewport | null = null;
    private scissor: { x: number; y: number; w: number; h: number } | null = null;

    private readonly pipelines = new Map<string, GPURenderPipeline | null>();
    private readonly bindLayouts = new Map<string, GPUBindGroupLayout>();
    private readonly linked = new Map<string, { vs: TranslatedShader; ps: TranslatedShader | null; vsModule: GPUShaderModule; psModule: GPUShaderModule | null } | null>();
    private readonly dummies: { texture: Map<string, GPUTextureView>; sampler: GPUSampler; comparison: GPUSampler; buffer: GPUBuffer };
    private readonly mipPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
    private readonly warned = new Set<string>();

    // Harness instruments: captureFrame records every draw (frame-capture.ts), and drawScrub
    // renders only draws [min, max] of each frame, numbered within one render target when
    // scoped (as D3D9's scrub does). Textures are numbered for both.
    private readonly textureIds = new WeakMap<TextureRes, number>();
    private readonly texturesById = new Map<number, WeakRef<TextureRes>>();
    /** How each texture got its contents, for textureHistory(id). */
    private readonly textureEvents = new WeakMap<TextureRes, Record<string, number>>();
    private nextTextureId = 1;
    private scrubMin = 0;
    private scrubMax = -1;
    private scrubTarget = 0;
    private scrubExclude = false;
    private scrubDrawIndex = 0;
    private scrubLastFrameDraws = 0;
    private scrubLastCut: { index: number; vertexShader: number; pixelShader: number } | null = null;

    presentCount = 0;
    drawCount = 0;
    /** The optional WebGPU texture formats this device enabled. */
    private readonly formatFeatures: FormatFeatures;

    constructor(private readonly backend: WebGPUBackend) {
        const device = backend.getDevice();
        if (!device) throw new Error("D3D11: no WebGPU device");
        this.device = device;
        const features = device.features as ReadonlySet<string> | undefined;
        this.formatFeatures = {
            norm16: !!features && (features.has("texture-formats-tier1") || (features.has("unorm16-texture-formats") && features.has("snorm16-texture-formats"))),
            depth32Stencil8: !!features?.has("depth32float-stencil8"),
        };
        this.arena = this.createArena(ARENA_INITIAL);
        this.dummies = {
            texture: new Map(),
            sampler: device.createSampler({ label: "d3d11 dummy sampler" }),
            comparison: device.createSampler({ label: "d3d11 dummy comparison", compare: "less-equal" }),
            buffer: device.createBuffer({ label: "d3d11 dummy buffer", size: 65536, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }),
        };
    }

    private warnOnce(key: string, msg: string): void {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        Logger.warn(LogCategory.D3D9, `[D3D11] ${msg}`);
        // Readable from the harness (evalWorker) alongside globalThis.__d3d11Trace.
        const g = globalThis as { __d3d11Warnings?: string[] };
        (g.__d3d11Warnings ??= []).push(msg);
    }

    // ---- resources ----

    private createArena(size: number): GPUBuffer {
        return this.device.createBuffer({
            label: "d3d11 upload arena", size,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    private arenaAlloc(size: number): { buffer: GPUBuffer; offset: number } {
        const aligned = (this.arenaCursor + ARENA_ALIGN - 1) & ~(ARENA_ALIGN - 1);
        if (aligned + size > this.arena.size) {
            // Commands already recorded keep the old arena alive; later draws use the new one.
            this.arena = this.createArena(Math.max(this.arena.size * 2, size + ARENA_ALIGN));
            this.arenaCursor = 0;
            return this.arenaAlloc(size);
        }
        this.arenaCursor = aligned + size;
        return { buffer: this.arena, offset: aligned };
    }

    createBuffer(size: number, bind: number, init: Uint8Array | null): BufferRes {
        const padded = Math.max(16, (size + 15) & ~15);
        let usage = GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
        if (bind & BIND_VERTEX) usage |= GPUBufferUsage.VERTEX;
        if (bind & BIND_INDEX) usage |= GPUBufferUsage.INDEX;
        if (bind & BIND_CONSTANT) usage |= GPUBufferUsage.UNIFORM;
        if (!(bind & (BIND_VERTEX | BIND_INDEX | BIND_CONSTANT))) usage |= GPUBufferUsage.VERTEX;
        const gpu = this.device.createBuffer({ label: `d3d11 buffer ${size}B bind=${bind}`, size: padded, usage });
        const shadow = new Uint8Array(padded);
        if (init) shadow.set(init.subarray(0, size));
        this.device.queue.writeBuffer(gpu, 0, shadow);
        return { kind: "buffer", size, bind, gpu, shadow, current: { buffer: gpu, offset: 0 } };
    }

    /** New contents for a buffer, in order with the draws recorded so far. */
    updateBuffer(buf: BufferRes, bytes: Uint8Array, offset: number, mapType: number): void {
        if (mapType === MAP_WRITE_NO_OVERWRITE) {
            // The caller promises not to touch bytes a pending draw reads, so the changed
            // span can be written where draws already look.
            let lo = -1, hi = -1;
            for (let i = 0; i < bytes.length; i++) {
                if (bytes[i] !== buf.shadow[offset + i]) { if (lo < 0) lo = i; hi = i; }
            }
            if (lo < 0) return;
            const start = lo & ~3, end = Math.min(bytes.length, (hi + 4) & ~3);
            buf.shadow.set(bytes.subarray(start, end), offset + start);
            this.device.queue.writeBuffer(buf.current.buffer, buf.current.offset + offset + start, buf.shadow, offset + start, end - start);
            return;
        }
        buf.shadow.set(bytes.subarray(0, Math.min(bytes.length, buf.shadow.length - offset)), offset);
        void (mapType === MAP_WRITE_DISCARD);
        const slice = this.arenaAlloc(buf.shadow.length);
        this.device.queue.writeBuffer(slice.buffer, slice.offset, buf.shadow);
        buf.current = slice;
        this.arenaResident.add(buf);
    }

    createTexture2D(width: number, height: number, mips: number, layers: number, dxgi: number, bind: number, misc: number): TextureRes | null {
        const info = textureFormat(dxgi, (bind & BIND_DEPTH_STENCIL) !== 0, this.formatFeatures);
        if (!info) { this.warnOnce(`fmt${dxgi}`, `texture format ${dxgi} has no WebGPU mapping`); return null; }
        const fullChain = Math.floor(Math.log2(Math.max(width, height, 1))) + 1;
        const levels = mips === 0 ? fullChain : Math.min(mips, fullChain);
        let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
        const renderable = !info.block && !(info.format.endsWith("snorm"));
        if (renderable && (bind & (BIND_RENDER_TARGET | BIND_DEPTH_STENCIL) || misc & MISC_GENERATE_MIPS || !info.depth)) usage |= GPUTextureUsage.RENDER_ATTACHMENT;
        if (info.depth) usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
        const gpu = this.device.createTexture({
            label: `d3d11 tex ${width}x${height} fmt${dxgi}`,
            size: { width: Math.max(1, width), height: Math.max(1, height), depthOrArrayLayers: Math.max(1, layers) },
            mipLevelCount: levels, format: info.format, usage, viewFormats: info.viewFormats,
        });
        return { kind: "texture", width, height, mips: levels, layers: Math.max(1, layers), dxgi, info, gpu, generateMips: (misc & MISC_GENERATE_MIPS) !== 0 };
    }

    /** Write one subresource (`pitch` bytes per row of texels or blocks). */
    writeTexture(tex: TextureRes, mip: number, layer: number, data: Uint8Array, pitch: number, box?: { x: number; y: number; w: number; h: number }): void {
        this.noteTexture(tex, `cpuWrite mip${mip}${box ? " box" : ""}`);
        if (tex.info.depth) { this.warnOnce("depthwrite", "CPU write to a depth texture skipped"); return; }
        this.flush();
        const mw = Math.max(1, tex.width >> mip), mh = Math.max(1, tex.height >> mip);
        let r = box ?? { x: 0, y: 0, w: mw, h: mh };
        if (tex.info.block) {
            // Copies of compressed textures cover whole blocks.
            const bw = (v: number) => Math.ceil(v / 4) * 4;
            r = { x: r.x, y: r.y, w: Math.min(bw(r.w), bw(mw) - r.x), h: Math.min(bw(r.h), bw(mh) - r.y) };
        }
        const rows = tex.info.block ? Math.ceil(r.h / 4) : r.h;
        if (data.length < pitch * (rows - 1) + (tex.info.block ? Math.ceil(r.w / 4) : r.w) * tex.info.bytes) return;
        this.device.queue.writeTexture(
            { texture: tex.gpu, mipLevel: mip, origin: { x: r.x, y: r.y, z: layer } },
            data, { bytesPerRow: pitch, rowsPerImage: rows }, { width: r.w, height: r.h, depthOrArrayLayers: 1 },
        );
    }

    createView(tex: TextureRes, viewDxgi: number, baseMip: number, mipCount: number, baseLayer: number, layerCount: number, dimension: GPUTextureViewDimension, forAttachment: boolean): ViewRes {
        const levels = forAttachment ? 1 : Math.max(1, Math.min(mipCount === 0xffffffff || mipCount === 0 ? tex.mips - baseMip : mipCount, tex.mips - baseMip));
        const view = tex.gpu.createView({
            format: viewFormat(tex.info, viewDxgi),
            dimension: tex.layers > 1 && !forAttachment ? dimension : forAttachment ? "2d" : dimension,
            baseMipLevel: Math.min(baseMip, tex.mips - 1), mipLevelCount: levels,
            baseArrayLayer: baseLayer, arrayLayerCount: forAttachment ? 1 : Math.max(1, Math.min(layerCount || tex.layers, tex.layers - baseLayer)),
        });
        return { kind: "view", texture: tex, view, format: viewFormat(tex.info, viewDxgi), baseMip };
    }

    createShader(stage: ShaderRes["stage"], bytes: Uint8Array): ShaderRes {
        const res: ShaderRes = { kind: "shader", stage, id: nextId++, dxbc: null };
        try { res.dxbc = parseDxbc(bytes); } catch (e) { res.error = String(e); }
        return res;
    }

    createInputLayout(elements: InputElement[]): InputLayoutRes {
        return { kind: "layout", id: nextId++, elements };
    }

    createSampler(desc: Uint8Array | null): SamplerRes {
        const d = decodeSampler(desc);
        return { kind: "sampler", sampler: this.device.createSampler(d), comparison: d.compare !== undefined };
    }

    blendState(d: Uint8Array | null): StateRes<BlendState> { return { kind: "state", value: decodeBlend(d) }; }
    rasterState(d: Uint8Array | null): StateRes<RasterState> { return { kind: "state", value: decodeRaster(d) }; }
    depthStencilState(d: Uint8Array | null): StateRes<DepthStencilState> { return { kind: "state", value: decodeDepthStencil(d) }; }

    // ---- context state ----

    setShader(stage: "vs" | "ps" | "gs", s: ShaderRes | null): void {
        if (stage === "vs") this.vs = s; else if (stage === "ps") this.ps = s; else this.gs = s;
    }
    setInputLayout(l: InputLayoutRes | null): void { this.layout = l; }
    setTopology(t: number): void { this.topology = t; }
    setVertexBuffer(slot: number, buf: BufferRes | null, stride: number, offset: number): void {
        this.vbs[slot] = buf ? { buf, stride, offset } : null;
    }
    setIndexBuffer(buf: BufferRes | null, dxgi: number, offset: number): void {
        this.ib = buf ? { buf, format: dxgi === 42 ? "uint32" : "uint16", offset } : null;
    }
    setConstantBuffer(stage: "vs" | "ps", slot: number, buf: BufferRes | null): void { this.cbs[stage][slot] = buf; }
    setShaderResource(stage: "vs" | "ps", slot: number, v: ViewRes | null): void { this.srvs[stage][slot] = v; }
    setSampler(stage: "vs" | "ps", slot: number, s: SamplerRes | null): void { this.samplers[stage][slot] = s; }
    setRenderTargets(rtvs: Array<ViewRes | null>, dsv: ViewRes | null): void { this.rtvs = rtvs; this.dsv = dsv; }
    setBlend(b: BlendState | null, factor: GPUColor | null): void {
        this.blend = b ?? decodeBlend(null);
        this.blendFactor = factor ?? { r: 1, g: 1, b: 1, a: 1 };
    }
    setRaster(r: RasterState | null): void { this.raster = r ?? decodeRaster(null); }
    setDepthStencil(d: DepthStencilState | null, ref: number): void { this.depthStencil = d ?? decodeDepthStencil(null); this.stencilRef = ref; }
    setViewport(v: Viewport): void { this.viewport = v; }
    setScissor(r: { x: number; y: number; w: number; h: number } | null): void { this.scissor = r; }

    /** ID3D11DeviceContext::ClearState: every pipeline binding back to its default. */
    clearState(): void {
        this.vs = this.ps = this.gs = null;
        this.layout = null;
        this.topology = 0; // D3D11_PRIMITIVE_TOPOLOGY_UNDEFINED
        this.vbs.length = 0;
        this.ib = null;
        for (const stage of ["vs", "ps"] as const) {
            this.cbs[stage].length = 0;
            this.srvs[stage].length = 0;
            this.samplers[stage].length = 0;
        }
        this.rtvs = [];
        this.dsv = null;
        this.setBlend(null, null);
        this.setRaster(null);
        this.setDepthStencil(null, 0);
        this.viewport = null;
        this.scissor = null;
    }

    // ---- passes ----

    private ensureEncoder(): GPUCommandEncoder {
        if (!this.encoder) this.encoder = this.device.createCommandEncoder({ label: "d3d11 frame" });
        return this.encoder;
    }

    private endPass(): void {
        if (this.pass) { this.pass.end(); this.pass = null; this.passKey = ""; }
    }

    /** Submit what has been recorded (before a queue write that must follow it). */
    flush(): void {
        this.endPass();
        if (this.encoder) {
            this.device.queue.submit([this.encoder.finish()]);
            this.encoder = null;
        }
    }

    private attachmentSize(): { w: number; h: number } {
        const v = this.rtvs.find((r) => r) ?? this.dsv;
        if (!v) return { w: 1, h: 1 };
        return { w: Math.max(1, v.texture.width >> v.baseMip), h: Math.max(1, v.texture.height >> v.baseMip) };
    }

    private beginPass(): GPURenderPassEncoder {
        if (this.pass && this.passKey === this.passIdentity()) return this.pass;
        this.endPass();
        for (const r of this.rtvs) if (r) this.noteTexture(r.texture, "renderTarget");
        const enc = this.ensureEncoder();
        const color: Array<GPURenderPassColorAttachment | null> = this.rtvs.map((r) => (r ? { view: r.view, loadOp: "load", storeOp: "store" } : null));
        const desc: GPURenderPassDescriptor = { colorAttachments: color };
        if (this.dsv) {
            const d: GPURenderPassDepthStencilAttachment = { view: this.dsv.view, depthLoadOp: "load", depthStoreOp: "store" };
            if (this.dsv.texture.info.stencil) { d.stencilLoadOp = "load"; d.stencilStoreOp = "store"; }
            desc.depthStencilAttachment = d;
        }
        this.pass = enc.beginRenderPass(desc);
        this.passKey = this.passIdentity();
        const size = this.attachmentSize();
        this.passWidth = size.w; this.passHeight = size.h;
        return this.pass;
    }

    private readonly viewIds = new WeakMap<ViewRes, number>();
    private viewId(v: ViewRes | null): number {
        if (!v) return 0;
        let id = this.viewIds.get(v);
        if (!id) { id = nextId++; this.viewIds.set(v, id); }
        return id;
    }
    private passIdentity(): string {
        return this.rtvs.map((r) => this.viewId(r)).join(",") + "#" + this.viewId(this.dsv);
    }

    clearRenderTarget(v: ViewRes, c: GPUColor): void {
        this.endPass();
        this.ensureEncoder().beginRenderPass({ colorAttachments: [{ view: v.view, loadOp: "clear", clearValue: c, storeOp: "store" }] }).end();
    }

    clearDepthStencil(v: ViewRes, flags: number, depth: number, stencil: number): void {
        this.endPass();
        const d: GPURenderPassDepthStencilAttachment = { view: v.view };
        d.depthLoadOp = flags & 1 ? "clear" : "load";
        d.depthStoreOp = "store";
        d.depthClearValue = Math.min(1, Math.max(0, depth));
        if (v.texture.info.stencil) {
            d.stencilLoadOp = flags & 2 ? "clear" : "load";
            d.stencilStoreOp = "store";
            d.stencilClearValue = stencil & 0xff;
        }
        this.ensureEncoder().beginRenderPass({ colorAttachments: [], depthStencilAttachment: d }).end();
    }

    // ---- shaders and pipelines ----

    private link(): { vs: TranslatedShader; ps: TranslatedShader | null; vsModule: GPUShaderModule; psModule: GPUShaderModule | null } | null {
        const vs = this.vs!, ps = this.ps;
        const key = `${vs.id}:${ps?.id ?? 0}`;
        if (this.linked.has(key)) return this.linked.get(key)!;
        let result = null;
        try {
            if (!vs.dxbc) throw new UnsupportedShader(vs.error ?? "no bytecode");
            const pst = ps?.dxbc ? translateShader(ps.dxbc, 1) : null;
            const vst = translateShader(vs.dxbc, 0, ps?.dxbc ? pixelLinkage(ps.dxbc) : new Map());
            const vsModule = this.device.createShaderModule({ label: `d3d11 vs${vs.id}`, code: vst.wgsl });
            const psModule = pst ? this.device.createShaderModule({ label: `d3d11 ps${ps!.id}`, code: pst.wgsl }) : null;
            result = { vs: vst, ps: pst, vsModule, psModule };
        } catch (e) {
            this.warnOnce(`link${key}`, `shader pair vs${vs.id}/ps${ps?.id ?? 0} not translated: ${e}`);
        }
        this.linked.set(key, result);
        return result;
    }

    private bindLayout(b: ShaderBindings, visibility: number): GPUBindGroupLayout {
        const key = `${visibility}|${[...b.cbuffers].map(([s, n]) => `c${s}:${n}`).join(",")}|` +
            `${b.textures.map((t) => `t${t.slot}:${t.viewDimension}:${t.sampleType}`).join(",")}|${b.samplers.map((s) => `s${s.slot}:${s.comparison}`).join(",")}`;
        let l = this.bindLayouts.get(key);
        if (l) return l;
        const entries: GPUBindGroupLayoutEntry[] = [];
        for (const [slot] of b.cbuffers) entries.push({ binding: CB_BINDING_BASE + slot, visibility, buffer: { type: "uniform" } });
        for (const t of b.textures) entries.push({ binding: TEXTURE_BINDING_BASE + t.slot, visibility, texture: { sampleType: t.sampleType, viewDimension: t.viewDimension, multisampled: t.multisampled } });
        for (const s of b.samplers) entries.push({ binding: SAMPLER_BINDING_BASE + s.slot, visibility, sampler: { type: s.comparison ? "comparison" : "filtering" } });
        l = this.device.createBindGroupLayout({ label: `d3d11 bgl ${key}`, entries });
        this.bindLayouts.set(key, l);
        return l;
    }

    private vertexLayouts(vs: TranslatedShader): { buffers: Array<GPUVertexBufferLayout | null>; key: string } | null {
        const buffers: Array<GPUVertexBufferLayout | null> = [];
        const elements = this.layout?.elements ?? [];
        // APPEND_ALIGNED_ELEMENT offsets, per slot, in declaration order.
        const offsets = new Map<InputElement, number>();
        const cursor = new Map<number, number>();
        for (const e of elements) {
            const vf = vertexFormat(e.format);
            const at = e.offset === 0xffffffff ? (cursor.get(e.slot) ?? 0) : e.offset;
            offsets.set(e, at);
            cursor.set(e.slot, at + (vf?.bytes ?? 4));
        }
        const keyParts: string[] = [];
        for (const input of vs.inputs) {
            if (input.systemValue !== 0) continue;
            const e = elements.find((x) => `${x.semantic.toUpperCase()}${x.index}` === semanticKey(input));
            if (!e) { this.warnOnce(`noel${semanticKey(input)}`, `vertex shader input ${semanticKey(input)} has no input-layout element`); return null; }
            const vf = vertexFormat(e.format);
            if (!vf) { this.warnOnce(`vf${e.format}`, `vertex format ${e.format} unsupported`); return null; }
            const vb = this.vbs[e.slot];
            const stride = vb?.stride ?? 0;
            let layout = buffers[e.slot];
            if (!layout) {
                layout = { arrayStride: stride, stepMode: e.perInstance ? "instance" : "vertex", attributes: [] };
                buffers[e.slot] = layout;
            }
            (layout.attributes as GPUVertexAttribute[]).push({ shaderLocation: input.register, format: vf.format, offset: offsets.get(e)! });
            keyParts.push(`${input.register}:${e.slot}:${vf.format}:${offsets.get(e)}:${stride}:${e.perInstance ? 1 : 0}`);
        }
        for (let i = 0; i < buffers.length; i++) if (!buffers[i]) buffers[i] = null;
        return { buffers, key: keyParts.join(",") };
    }

    private pipeline(): { pipeline: GPURenderPipeline; linked: NonNullable<ReturnType<D3D11Renderer["link"]>>; vertexSlots: number[] } | null {
        if (!this.vs) return null;
        const linked = this.link();
        if (!linked) return null;
        const vl = this.vertexLayouts(linked.vs);
        if (!vl) return null;
        const topology: GPUPrimitiveTopology = ({ 1: "point-list", 2: "line-list", 3: "line-strip", 4: "triangle-list", 5: "triangle-strip" } as Record<number, GPUPrimitiveTopology>)[this.topology] ?? "triangle-list";
        const strip = topology === "triangle-strip" || topology === "line-strip";
        const colorFormats = this.rtvs.map((r) => (r ? r.format : null));
        const psOut = new Set((linked.ps?.outputs ?? []).filter((e) => e.semantic.toUpperCase() === "SV_TARGET").map((e) => e.semanticIndex));
        const dsFormat = this.dsv?.texture.gpu.format ?? null;
        const ds = this.depthStencil;
        const key = [linked.vs.wgsl.length, this.vs.id, this.ps?.id ?? 0, vl.key, topology, strip && this.ib ? this.ib.format : "",
            this.blend.key, this.raster.key, dsFormat ? ds.key : "", colorFormats.join(","), dsFormat ?? ""].join("|");
        if (this.pipelines.has(key)) {
            const p = this.pipelines.get(key);
            return p ? { pipeline: p, linked, vertexSlots: vl.buffers.map((b, i) => (b ? i : -1)).filter((i) => i >= 0) } : null;
        }
        let pipeline: GPURenderPipeline | null = null;
        try {
            const layouts = [this.bindLayout(linked.vs.bindings, GPUShaderStage.VERTEX),
                this.bindLayout(linked.ps?.bindings ?? { cbuffers: new Map(), textures: [], samplers: [] }, GPUShaderStage.FRAGMENT)];
            const targets: Array<GPUColorTargetState | null> = colorFormats.map((f, i) => {
                if (!f) return null;
                const t = this.blend.targets[i]!;
                const writeMask = psOut.has(i) ? t.writeMask : 0;
                return { format: f, writeMask, blend: t.blend && !isFloat32Format(f) ? t.blend : undefined };
            });
            const desc: GPURenderPipelineDescriptor = {
                label: `d3d11 vs${this.vs.id} ps${this.ps?.id ?? 0}`,
                layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
                vertex: { module: linked.vsModule, entryPoint: "main", buffers: vl.buffers },
                primitive: {
                    topology,
                    stripIndexFormat: strip && this.ib ? this.ib.format : undefined,
                    cullMode: this.raster.cullMode,
                    frontFace: this.raster.frontFace,
                },
            };
            if (linked.psModule) desc.fragment = { module: linked.psModule, entryPoint: "main", targets };
            if (this.dsv) {
                desc.depthStencil = {
                    format: dsFormat!,
                    depthWriteEnabled: ds.depthWrite,
                    depthCompare: ds.depthCompare,
                    depthBias: this.raster.depthBias,
                    depthBiasSlopeScale: this.raster.slopeScale,
                    depthBiasClamp: this.raster.biasClamp,
                };
                if (this.dsv.texture.info.stencil && ds.stencilEnable) {
                    Object.assign(desc.depthStencil, { stencilFront: ds.front, stencilBack: ds.back, stencilReadMask: ds.readMask, stencilWriteMask: ds.writeMask });
                }
            }
            this.device.pushErrorScope("validation");
            const created = pipeline = this.device.createRenderPipeline(desc);
            const label = desc.label;
            void this.device.popErrorScope().then((err) => {
                if (!err) return;
                recordGpuError("scope", "d3d11.pipeline", err.message);
                Logger.error(LogCategory.D3D9, `[D3D11] pipeline ${label}: ${err.message}`);
                // A draw with an invalid pipeline invalidates the whole frame's command buffer,
                // so later draws that would use it are skipped instead.
                if (this.pipelines.get(key) === created) this.pipelines.set(key, null);
                this.warnOnce(`pipe${key}`, `pipeline ${label} is invalid; its draws are skipped: ${err.message.split("\n")[0]}`);
            });
        } catch (e) {
            this.warnOnce(`pipe${key}`, `pipeline creation failed: ${e}`);
        }
        this.pipelines.set(key, pipeline);
        return pipeline ? { pipeline, linked, vertexSlots: vl.buffers.map((b, i) => (b ? i : -1)).filter((i) => i >= 0) } : null;
    }

    private dummyTexture(dim: GPUTextureViewDimension, sampleType: GPUTextureSampleType): GPUTextureView {
        const key = `${dim}:${sampleType}`;
        let v = this.dummies.texture.get(key);
        if (v) return v;
        const format: GPUTextureFormat = sampleType === "depth" ? "depth32float" : sampleType === "sint" ? "rgba8sint" : sampleType === "uint" ? "rgba8uint" : "rgba8unorm";
        const layers = dim === "cube" || dim === "cube-array" ? 6 : 1;
        const tex = this.device.createTexture({
            label: `d3d11 dummy ${key}`, size: { width: 1, height: 1, depthOrArrayLayers: layers },
            dimension: dim === "3d" ? "3d" : dim === "1d" ? "1d" : "2d", format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | (sampleType === "depth" ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
        });
        v = tex.createView({ dimension: dim });
        this.dummies.texture.set(key, v);
        return v;
    }

    private bindGroup(stage: "vs" | "ps", b: ShaderBindings, layout: GPUBindGroupLayout): GPUBindGroup {
        const entries: GPUBindGroupEntry[] = [];
        for (const [slot, size] of b.cbuffers) {
            const buf = this.cbs[stage][slot];
            if (buf && buf.shadow.length >= size) entries.push({ binding: CB_BINDING_BASE + slot, resource: { buffer: buf.current.buffer, offset: buf.current.offset, size } });
            else {
                if (buf) this.warnOnce(`cbsize${slot}`, `cb${slot} is ${buf.shadow.length}B but the shader declares ${size}B`);
                entries.push({ binding: CB_BINDING_BASE + slot, resource: { buffer: this.dummies.buffer, size } });
            }
        }
        const targets = new Set<TextureRes>(this.rtvs.filter((r): r is ViewRes => !!r).map((r) => r.texture));
        if (this.dsv) targets.add(this.dsv.texture);
        for (const t of b.textures) {
            const v = this.srvs[stage][t.slot];
            let view: GPUTextureView;
            if (!v || targets.has(v.texture)) view = this.dummyTexture(t.viewDimension, t.sampleType);
            else if (v.texture.info.depth && t.sampleType !== "depth") {
                this.warnOnce("depthsrv", "a depth texture bound as a float SRV is not sampled yet (dummy bound)");
                view = this.dummyTexture(t.viewDimension, t.sampleType);
            } else view = v.view;
            entries.push({ binding: TEXTURE_BINDING_BASE + t.slot, resource: view });
        }
        for (const s of b.samplers) {
            const smp = this.samplers[stage][s.slot];
            const sampler = smp && smp.comparison === s.comparison ? smp.sampler : s.comparison ? this.dummies.comparison : this.dummies.sampler;
            entries.push({ binding: SAMPLER_BINDING_BASE + s.slot, resource: sampler });
        }
        return this.device.createBindGroup({ layout, entries });
    }

    // ---- draws ----

    draw(vertexCount: number, instanceCount: number, firstVertex: number, firstInstance: number, indexed: false): void;
    draw(indexCount: number, instanceCount: number, firstIndex: number, firstInstance: number, indexed: true, baseVertex: number): void;
    draw(count: number, instances: number, first: number, firstInstance: number, indexed: boolean, baseVertex = 0): void {
        const target = this.rtvs[0]?.texture ?? this.dsv?.texture ?? null;
        const targetId = target ? this.textureId(target) : 0;
        const skip = (reason: string): void => this.captureDraw(count, instances, first, baseVertex, indexed, target, targetId, reason);
        if (this.gs) { this.warnOnce("gs", "draws with a geometry shader bound are skipped (not emulated yet)"); return skip("geometry shader"); }
        if (!target) return skip("no render target or depth view");
        if (indexed && !this.ib) return skip("no index buffer");
        if (this.scrubCuts(targetId)) return skip("draw scrub");
        const p = this.pipeline();
        if (!p) return skip("no pipeline (see __d3d11Warnings)");
        this.captureDraw(count, instances, first, baseVertex, indexed, target, targetId, null);
        const pass = this.beginPass();
        pass.setPipeline(p.pipeline);
        pass.setBindGroup(0, this.bindGroup("vs", p.linked.vs.bindings, p.pipeline.getBindGroupLayout(0)));
        pass.setBindGroup(1, this.bindGroup("ps", p.linked.ps?.bindings ?? { cbuffers: new Map(), textures: [], samplers: [] }, p.pipeline.getBindGroupLayout(1)));
        for (const slot of p.vertexSlots) {
            const vb = this.vbs[slot];
            if (vb) pass.setVertexBuffer(slot, vb.buf.current.buffer, vb.buf.current.offset + vb.offset);
            else pass.setVertexBuffer(slot, this.dummies.buffer, 0);
        }
        const vp = this.viewport ?? { x: 0, y: 0, w: this.passWidth, h: this.passHeight, minDepth: 0, maxDepth: 1 };
        const x = Math.max(0, Math.min(vp.x, this.passWidth)), y = Math.max(0, Math.min(vp.y, this.passHeight));
        const w = Math.max(0, Math.min(vp.w, this.passWidth - x)), h = Math.max(0, Math.min(vp.h, this.passHeight - y));
        if (w <= 0 || h <= 0) return;
        pass.setViewport(x, y, w, h, Math.min(1, Math.max(0, vp.minDepth)), Math.min(1, Math.max(0, vp.maxDepth)));
        if (this.raster.scissor && this.scissor) {
            const sx = Math.max(0, Math.min(this.scissor.x, this.passWidth)), sy = Math.max(0, Math.min(this.scissor.y, this.passHeight));
            pass.setScissorRect(sx, sy, Math.max(0, Math.min(this.scissor.w, this.passWidth - sx)), Math.max(0, Math.min(this.scissor.h, this.passHeight - sy)));
        } else {
            pass.setScissorRect(0, 0, this.passWidth, this.passHeight);
        }
        pass.setBlendConstant(this.blendFactor);
        if (this.dsv?.texture.info.stencil) pass.setStencilReference(this.stencilRef);
        if (indexed) {
            pass.setIndexBuffer(this.ib!.buf.current.buffer, this.ib!.format, this.ib!.buf.current.offset + this.ib!.offset);
            pass.drawIndexed(count, instances, first, baseVertex, firstInstance);
        } else {
            pass.draw(count, instances, first, firstInstance);
        }
        this.drawCount++;
    }

    private textureId(t: TextureRes): number {
        let id = this.textureIds.get(t);
        if (!id) {
            this.textureIds.set(t, id = this.nextTextureId++);
            this.texturesById.set(id, new WeakRef(t));
        }
        return id;
    }

    /** True when the draw scrub cuts this draw; counts it either way. */
    private scrubCuts(targetId: number): boolean {
        if (this.scrubTarget && targetId !== this.scrubTarget) return false;
        const index = this.scrubDrawIndex++;
        if (this.scrubMax < 0) return false;
        const inside = index >= this.scrubMin && index <= this.scrubMax;
        if (inside === this.scrubExclude) {
            this.scrubLastCut = { index, vertexShader: this.vs?.id ?? 0, pixelShader: this.ps?.id ?? 0 };
            return true;
        }
        return false;
    }

    /** Vertex `first` of this draw (an index position when indexed), per input-layout element, as raw bytes. */
    private captureVertex(first: number, baseVertex: number, indexed: boolean): Array<{ semantic: string; index: number; format: number; slot: number; offset: number; bytes: number[]; floats: number[] }> {
        if (!this.layout) return [];
        let vertex = first;
        if (indexed && this.ib) {
            const size = this.ib.format === "uint32" ? 4 : 2;
            const at = this.ib.offset + first * size;
            const view = new DataView(this.ib.buf.shadow.buffer, this.ib.buf.shadow.byteOffset, this.ib.buf.shadow.byteLength);
            vertex = (at + size <= view.byteLength ? (size === 4 ? view.getUint32(at, true) : view.getUint16(at, true)) : 0) + baseVertex;
        }
        const cursor = new Map<number, number>();
        return this.layout.elements.map((e) => {
            const at = e.offset === 0xffffffff ? (cursor.get(e.slot) ?? 0) : e.offset;
            const vf = vertexFormat(e.format);
            const size = vf?.bytes ?? 4;
            cursor.set(e.slot, at + size);
            const vb = this.vbs[e.slot];
            const start = vb ? vb.offset + vertex * vb.stride + at : -1;
            const bytes = vb && start >= 0 && start + size <= vb.buf.shadow.length ? Array.from(vb.buf.shadow.subarray(start, start + size)) : [];
            const floats = bytes.length >= 4 && bytes.length % 4 === 0 ? Array.from(new Float32Array(new Uint8Array(bytes).buffer)) : [];
            return { semantic: e.semantic, index: e.index, format: e.format, slot: e.slot, offset: at, bytes, floats };
        });
    }

    private captureConstants(stage: "vs" | "ps"): Record<number, number[]> {
        const out: Record<number, number[]> = {};
        this.cbs[stage].forEach((b, slot) => {
            if (b) out[slot] = Array.from(new Float32Array(b.shadow.buffer, b.shadow.byteOffset, Math.min(64, b.shadow.length >> 2)));
        });
        return out;
    }

    private captureDraw(count: number, instances: number, first: number, baseVertex: number, indexed: boolean, target: TextureRes | null, targetId: number, skipped: string | null): void {
        if (!frameCapture.isCapturing()) return;
        const srv = (stage: "vs" | "ps") => this.srvs[stage].map((v, slot) => v && {
            slot, texture: this.textureId(v.texture), width: v.texture.width, height: v.texture.height,
            format: v.format, dxgi: v.texture.dxgi, depth: v.texture.info.depth, mips: v.texture.mips,
        }).filter(Boolean);
        frameCapture.recordRawDraw({
            backend: "d3d11",
            primitiveType: this.topology,
            primitiveTypeName: `D3D11_PRIMITIVE_TOPOLOGY(${this.topology})`,
            vertexCount: indexed ? 0 : count,
            indexCount: indexed ? count : 0,
            programmable: true,
            vertexShader: this.vs?.id ?? 0,
            pixelShader: this.ps?.id ?? 0,
            rtSurfacePtr: targetId,
            rtWidth: target?.width ?? 0,
            rtHeight: target?.height ?? 0,
            rtFormat: target?.gpu.format ?? null,
            viewport: this.viewport && { x: this.viewport.x, y: this.viewport.y, width: this.viewport.w, height: this.viewport.h, minZ: this.viewport.minDepth, maxZ: this.viewport.maxDepth },
            warnings: skipped ? [`skipped: ${skipped}`] : [],
            d3d11: {
                skipped, instances,
                geometryShader: this.gs?.id ?? 0,
                inputLayout: this.layout?.id ?? 0,
                vertexStrides: this.vbs.map((v) => v?.stride ?? 0),
                firstVertex: this.captureVertex(first, baseVertex, indexed),
                // Eight vertices spread over the draw: per-vertex data (colors, visibility) varies across a mesh.
                sampledVertices: Array.from({ length: 8 }, (_, k) => this.captureVertex(first + Math.floor((k * count) / 8), baseVertex, indexed)),
                vsConstants: this.captureConstants("vs"), psConstants: this.captureConstants("ps"),
                renderTargets: this.rtvs.map((v) => v && { texture: this.textureId(v.texture), format: v.format, width: v.texture.width, height: v.texture.height }),
                depthView: this.dsv && { texture: this.textureId(this.dsv.texture), format: this.dsv.format },
                vsResources: srv("vs"), psResources: srv("ps"),
                depthStencil: this.depthStencil, blend: this.blend, raster: this.raster,
            },
        });
    }

    private noteTexture(t: TextureRes, event: string): void {
        let e = this.textureEvents.get(t);
        if (!e) this.textureEvents.set(t, e = {});
        e[event] = (e[event] ?? 0) + 1;
    }

    /** What has written texture #id (harness: evalWorker): event -> count. */
    textureHistory(id: number): Record<string, unknown> {
        const tex = this.texturesById.get(id)?.deref();
        if (!tex) return { error: `no live texture #${id}` };
        return { format: tex.gpu.format, dxgi: tex.dxgi, size: `${tex.width}x${tex.height}`, mips: tex.mips, events: this.textureEvents.get(tex) ?? {} };
    }

    /**
     * Read one subresource back from the GPU, rows packed tightly (width * texel bytes).
     * Null for compressed and depth formats. Everything recorded so far is submitted first,
     * so the bytes include every earlier draw and copy.
     */
    async readTextureData(tex: TextureRes, mip = 0, layer = 0): Promise<{ width: number; height: number; texel: number; bytes: Uint8Array } | null> {
        if (tex.info.block || tex.info.depth) return null;
        const texel = tex.info.bytes;
        const width = Math.max(1, tex.width >> mip), height = Math.max(1, tex.height >> mip);
        const rowBytes = Math.ceil((width * texel) / 256) * 256;
        const staging = this.device.createBuffer({ size: rowBytes * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        this.flush();
        const enc = this.device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: tex.gpu, mipLevel: mip, origin: { x: 0, y: 0, z: layer } }, { buffer: staging, bytesPerRow: rowBytes }, { width, height });
        this.device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(staging.getMappedRange());
        const bytes = new Uint8Array(width * height * texel);
        for (let y = 0; y < height; y++) bytes.set(mapped.subarray(y * rowBytes, y * rowBytes + width * texel), y * width * texel);
        staging.unmap();
        staging.destroy();
        return { width, height, texel, bytes };
    }

    /** readTextureData by capture id (harness: evalWorker). */
    async readTexture(id: number, mip = 0): Promise<{ width: number; height: number; format: string; bytes: Uint8Array } | { error: string }> {
        const tex = this.texturesById.get(id)?.deref();
        if (!tex) return { error: `no live texture #${id}` };
        const data = await this.readTextureData(tex, mip);
        if (!data) return { error: `texture #${id} is ${tex.gpu.format}; compressed and depth formats do not read back` };
        return { width: data.width, height: data.height, format: tex.gpu.format, bytes: data.bytes };
    }

    setDrawScrub(min: number, max: number, target = 0, exclude = false): void {
        this.scrubMin = min | 0;
        this.scrubMax = max | 0;
        this.scrubTarget = target >>> 0;
        this.scrubExclude = exclude;
    }

    getDrawScrub() {
        return {
            backend: "d3d11", min: this.scrubMin, max: this.scrubMax, target: this.scrubTarget,
            exclude: this.scrubExclude, lastFrameDraws: this.scrubLastFrameDraws, lastCut: this.scrubLastCut,
        };
    }

    /**
     * D3D11_FORMAT_SUPPORT bits for a DXGI format, from what this renderer can create:
     * 0 when the format has no texture, vertex or index use here. No multisampling.
     */
    formatSupport(dxgi: number): number {
        const BUFFER = 0x1, IA_VERTEX = 0x2, IA_INDEX = 0x4, TEX = 0x20 | 0x40 | 0x80, LOAD = 0x100, SAMPLE = 0x200,
            COMPARISON = 0x400, MIP = 0x1000, MIP_AUTOGEN = 0x2000, RENDER_TARGET = 0x4000, BLENDABLE = 0x8000,
            DEPTH_STENCIL = 0x10000, CPU_LOCKABLE = 0x20000, DISPLAY = 0x80000;
        let bits = 0;
        const color = textureFormat(dxgi, false, this.formatFeatures);
        if (color) {
            bits |= TEX | LOAD | MIP | CPU_LOCKABLE;
            if (!/int$/.test(color.format)) bits |= SAMPLE;
            if (!color.block) bits |= RENDER_TARGET | (/int$/.test(color.format) ? 0 : BLENDABLE | MIP_AUTOGEN);
            if (dxgi === 28 || dxgi === 29 || dxgi === 87 || dxgi === 91 || dxgi === 24) bits |= DISPLAY;
        }
        if (isDepthFamily(dxgi, this.formatFeatures)) bits |= 0x20 | DEPTH_STENCIL | LOAD | SAMPLE | COMPARISON;
        if (vertexFormat(dxgi)) bits |= BUFFER | IA_VERTEX;
        if (dxgi === 42 || dxgi === 57) bits |= BUFFER | IA_INDEX; // R32_UINT, R16_UINT
        return bits;
    }

    // ---- copies and mips ----

    copyTexture(dst: TextureRes, src: TextureRes): void {
        this.noteTexture(dst, `copyResource from #${this.textureId(src)}`);
        if (dst.gpu.format !== src.gpu.format) { this.warnOnce("copyfmt", "CopyResource between different formats skipped"); return; }
        this.endPass();
        const enc = this.ensureEncoder();
        for (let m = 0; m < Math.min(dst.mips, src.mips); m++) {
            enc.copyTextureToTexture({ texture: src.gpu, mipLevel: m }, { texture: dst.gpu, mipLevel: m },
                { width: Math.max(1, Math.min(dst.width, src.width) >> m), height: Math.max(1, Math.min(dst.height, src.height) >> m), depthOrArrayLayers: Math.min(dst.layers, src.layers) });
        }
    }

    /** CopySubresourceRegion for textures: `box` (in source texels) defaults to the whole source mip. */
    copyTextureRegion(dst: TextureRes, dstMip: number, dstLayer: number, dx: number, dy: number,
        src: TextureRes, srcMip: number, srcLayer: number, box: { x: number; y: number; w: number; h: number } | null): void {
        this.noteTexture(dst, `copyRegion from #${this.textureId(src)} (${src.gpu.format})`);
        if (dst.gpu.format !== src.gpu.format) { this.warnOnce("copyregionfmt", `CopySubresourceRegion ${src.gpu.format} -> ${dst.gpu.format} skipped`); return; }
        if (dst.info.depth || src.info.depth) { this.warnOnce("copyregiondepth", "CopySubresourceRegion of a depth texture skipped"); return; }
        if (dstMip >= dst.mips || srcMip >= src.mips || dstLayer >= dst.layers || srcLayer >= src.layers) return;
        const sw = Math.max(1, src.width >> srcMip), sh = Math.max(1, src.height >> srcMip);
        const dw = Math.max(1, dst.width >> dstMip), dh = Math.max(1, dst.height >> dstMip);
        const r = box ?? { x: 0, y: 0, w: sw, h: sh };
        // Clamp to both mips; a block-compressed copy keeps whole 4x4 blocks except at a mip edge.
        let w = Math.min(r.w, sw - r.x, dw - dx), h = Math.min(r.h, sh - r.y, dh - dy);
        if (w <= 0 || h <= 0) return;
        if (src.info.block) {
            if (r.x % 4 || r.y % 4 || dx % 4 || dy % 4) { this.warnOnce("copyregionblock", "CopySubresourceRegion off a 4x4 block boundary skipped"); return; }
            const pad = (v: number, at: number, size: number) => (at + v === size ? v : v - (v % 4));
            w = Math.min(pad(w, r.x, sw), pad(w, dx, dw));
            h = Math.min(pad(h, r.y, sh), pad(h, dy, dh));
            if (w <= 0 || h <= 0) return;
        }
        this.endPass();
        this.ensureEncoder().copyTextureToTexture(
            { texture: src.gpu, mipLevel: srcMip, origin: { x: r.x, y: r.y, z: srcLayer } },
            { texture: dst.gpu, mipLevel: dstMip, origin: { x: dx, y: dy, z: dstLayer } },
            { width: w, height: h, depthOrArrayLayers: 1 });
    }

    /** CopySubresourceRegion for buffers: bytes [srcStart, srcEnd) of src land at dstOffset. */
    copyBufferRegion(dst: BufferRes, dstOffset: number, src: BufferRes, srcStart: number, srcEnd: number): void {
        const end = Math.min(srcEnd, src.shadow.length), n = Math.min(end - srcStart, dst.shadow.length - dstOffset);
        if (n > 0) this.updateBuffer(dst, src.shadow.slice(srcStart, srcStart + n), dstOffset, 0);
    }

    copyBuffer(dst: BufferRes, src: BufferRes): void {
        const n = Math.min(dst.shadow.length, src.shadow.length);
        this.updateBuffer(dst, src.shadow.subarray(0, n), 0, 0);
    }

    generateMips(tex: TextureRes): void {
        if (tex.mips < 2 || tex.info.block || tex.info.depth || /int$/.test(tex.gpu.format)) return;
        let pipe = this.mipPipelines.get(tex.gpu.format);
        if (!pipe) {
            const module = this.device.createShaderModule({ label: "d3d11 mip", code: MIP_WGSL });
            pipe = this.device.createRenderPipeline({
                label: `d3d11 mip ${tex.gpu.format}`, layout: "auto",
                vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format: tex.gpu.format }] },
                primitive: { topology: "triangle-list" },
            });
            this.mipPipelines.set(tex.gpu.format, pipe);
        }
        this.endPass();
        const enc = this.ensureEncoder();
        const sampler = this.device.createSampler({ minFilter: "linear", magFilter: "linear" });
        for (let layer = 0; layer < tex.layers; layer++) {
            for (let m = 1; m < tex.mips; m++) {
                const src = tex.gpu.createView({ dimension: "2d", baseMipLevel: m - 1, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
                const dst = tex.gpu.createView({ dimension: "2d", baseMipLevel: m, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
                const bg = this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: src }, { binding: 1, resource: sampler }] });
                const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst, loadOp: "clear", storeOp: "store" }] });
                pass.setPipeline(pipe);
                pass.setBindGroup(0, bg);
                pass.draw(3);
                pass.end();
            }
        }
    }

    // ---- present ----

    async present(backBuffer: TextureRes, syncInterval: number): Promise<void> {
        frameCapture.onFrameEnd("d3d11");
        this.scrubLastFrameDraws = this.scrubDrawIndex;
        this.scrubDrawIndex = 0;
        await framePacer.waitForPresentInterval(syncInterval);
        framePacer.reserveFrameSlot();
        try {
            this.endPass();
            const context = this.backend.getContext();
            const encoder = this.ensureEncoder();
            const useScopes = this.presentCount < 10;
            if (useScopes) this.device.pushErrorScope("validation");
            if (context) {
                const canvasTex = context.getCurrentTexture();
                const target = canvasTex.createView();
                this.backend.drawTexture(backBuffer.gpu.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }), target, encoder, true,
                    undefined, undefined, { r: 0, g: 0, b: 0, a: 1 }, false,
                    { srcW: backBuffer.width, srcH: backBuffer.height, outW: canvasTex.width, outH: canvasTex.height, toCanvas: true });
                const system = System.getInstance();
                const overlay = system.gdiContext.getOverlayCanvas();
                if (overlay && system.gdiContext.hasOverlayContent()) {
                    const plan = getOverlayCompositePlan(this);
                    if (plan.mode === "rects") this.backend.blitRects(overlay, target, encoder, plan.rects);
                    else if (plan.mode === "full") this.backend.blit(overlay, target, encoder);
                    if (system.gdiContext.isOverlayDirty()) system.gdiContext.clearOverlayDirty();
                }
                if (statsOverlay.isEnabled()) {
                    const statsCanvas = statsOverlay.getCanvas();
                    if (statsCanvas) {
                        if (statsOverlay.isDirty()) { this.backend.updateStatsTexture(statsCanvas); statsOverlay.clearDirty(); }
                        this.backend.renderStatsOverlay(target, encoder);
                    }
                }
            }
            this.device.queue.submit([encoder.finish()]);
            this.encoder = null;
            if (useScopes) {
                const frame = this.presentCount;
                void this.device.popErrorScope().then((err) => {
                    if (!err) return;
                    recordGpuError("scope", "d3d11Present.validation", err.message);
                    Logger.error(LogCategory.D3D9, `[D3D11 PRESENT] validation error frame=${frame}: ${err.message}`);
                });
            }
            // Every buffer whose latest bytes live in the arena gets them back in its own
            // GPUBuffer, so the arena can be reused next frame.
            for (const buf of this.arenaResident) {
                this.device.queue.writeBuffer(buf.gpu, 0, buf.shadow);
                buf.current = { buffer: buf.gpu, offset: 0 };
            }
            this.arenaResident.clear();
            this.arenaCursor = 0;
            const system = System.getInstance();
            system.gpuResourceManager?.flushPendingDestruction();
            if (system.services.render.getActive() !== this) system.services.render.setActive(this);
            this.presentCount++;
            system.services.render.notifyPresent("d3d11");
        } finally {
            framePacer.releaseFrameSlot();
        }
    }

    async captureFrame(): Promise<Blob> {
        return (await System.getInstance().services.render.tryCaptureScreen()) ?? new Blob([], { type: "image/png" });
    }

    getCounters(): Record<string, number> {
        return { presents: this.presentCount, draws: this.drawCount, pipelines: this.pipelines.size };
    }
}

const MIP_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct V { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var o: V;
    o.pos = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
    o.uv = uv;
    return o;
}
@fragment fn fs(v: V) -> @location(0) vec4<f32> { return textureSample(src, smp, v.uv); }
`;
