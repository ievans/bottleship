/** D3D11 device COM objects: reference counts, QueryInterface, failures, and per-subresource Map. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { D3D11Device } from "../../src/worker/modules/d3d11/device";
import { D3D11Renderer, type TextureRes } from "../../src/worker/backends/webgpu/d3d11/renderer";
import { IID } from "../../src/worker/modules/d3d11/interfaces";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { resetComMemory } from "../../src/worker/core/com/com-memory";

const S_OK = 0, E_INVALIDARG = 0x80070057, E_NOTIMPL = 0x80004001, E_NOINTERFACE = 0x80004002;
const DXGI_ERROR_INVALID_CALL = 0x887a0001;

function texture(width: number, height: number, mips = 1): TextureRes {
    return {
        kind: "texture", width, height, mips, layers: 1, dxgi: 28, generateMips: false,
        info: { bytes: 4, block: false, depth: false, stencil: false } as TextureRes["info"],
        gpu: { format: "rgba8unorm" } as GPUTexture,
    } as TextureRes;
}

describe("D3D11Device objects", () => {
    let mem: Uint8Array;
    let device: D3D11Device;
    let freedBlocks: number[];
    let createTexture: () => TextureRes | null;
    const dv = () => new DataView(mem.buffer);
    const u32 = (p: number) => dv().getUint32(p, true);
    const call = (name: string, args: number[], iface = "ID3D11Device") => (device as any).impls[name].call(device, args, iface);
    const objects = () => (device as any).objects as Map<number, { refs: number }>;
    const guid = (at: number, iid: string) => {
        const h = iid.replace(/-/g, "");
        const b = new Uint8Array(16), v = new DataView(b.buffer);
        v.setUint32(0, parseInt(h.slice(0, 8), 16), true);
        v.setUint16(4, parseInt(h.slice(8, 12), 16), true);
        v.setUint16(6, parseInt(h.slice(12, 16), 16), true);
        for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
        mem.set(b, at);
        return at;
    };

    beforeEach(() => {
        resetComMemory();
        mem = new Uint8Array(0x40000);
        Mem.bind(() => mem, (a, n) => a >= 0 && a + n <= mem.length);
        let heap = 0x10000;
        const alloc = (n: number) => { const p = heap; heap += (n + 15) & ~15; return p; };
        freedBlocks = [];
        const memory = { alloc, free: () => undefined, allocSystemBlock: alloc, freeSystemBlock: (a: number) => freedBlocks.push(a) };
        createTexture = () => texture(64, 64, 3);
        const renderer = {
            createBuffer: (size: number) => ({ kind: "buffer", size, shadow: new Uint8Array(size) }),
            createTexture2D: () => createTexture(),
            createView: (tex: TextureRes) => ({ kind: "view", texture: tex }),
            formatSupport: (f: number) => (f === 28 ? 0x20 : 0),
            writeTexture: () => undefined,
        };
        device = new D3D11Device({ memory, getCurrentMemory: () => mem } as any, 0xb000, renderer as any);
        (device as any).vtable = () => 0x9000;
    });
    afterEach(() => resetComMemory());

    const createTex = () => {
        const desc = 0x100;
        dv().setUint32(desc, 64, true); dv().setUint32(desc + 4, 64, true); dv().setUint32(desc + 8, 3, true);
        dv().setUint32(desc + 12, 1, true); dv().setUint32(desc + 16, 28, true);
        expect(call("CreateTexture2D", [0, desc, 0, 0x200])).toBe(S_OK);
        return u32(0x200);
    };

    test("a created object carries exactly the caller's reference", () => {
        const tex = createTex();
        expect(objects().get(tex)!.refs).toBe(1);
        expect(call("Release", [tex])).toBe(0);
        expect(objects().has(tex)).toBe(false);
        expect(freedBlocks.length).toBe(1);
    });

    test("a view keeps its texture alive until the view goes", () => {
        const tex = createTex();
        expect(call("CreateShaderResourceView", [0, tex, 0, 0x300])).toBe(S_OK);
        const srv = u32(0x300);
        call("Release", [tex]);
        expect(objects().has(tex)).toBe(true);
        call("Release", [srv]);
        expect(objects().has(srv)).toBe(false);
        expect(objects().has(tex)).toBe(false);
    });

    test("QueryInterface answers for the object's real interfaces only", () => {
        const tex = createTex();
        call("CreateShaderResourceView", [0, tex, 0, 0x300]);
        const srv = u32(0x300);
        for (const name of ["ID3D11ShaderResourceView", "ID3D11View", "ID3D11DeviceChild", "IUnknown"] as const) {
            expect(call("QueryInterface", [srv, guid(0x400, IID[name]), 0x420])).toBe(S_OK);
            expect(u32(0x420)).toBe(srv);
        }
        expect(call("QueryInterface", [srv, guid(0x400, IID.ID3D11RenderTargetView), 0x420])).toBe(E_NOINTERFACE);
        expect(call("QueryInterface", [tex, guid(0x400, IID.ID3D11Resource), 0x420])).toBe(S_OK);
    });

    test("a format the renderer cannot create fails and returns no object", () => {
        createTexture = () => null;
        dv().setUint32(0x200, 0xdead, true);
        expect(call("CreateTexture2D", [0, 0x100, 0, 0x200])).toBe(E_INVALIDARG);
        expect(u32(0x200)).toBe(0);
        expect(call("CheckFormatSupport", [0, 11, 0x500])).not.toBe(S_OK);
        expect(u32(0x500)).toBe(0);
    });

    test("an unimplemented method fails and NULLs its object out-parameter", () => {
        const handler = (device as any).handler("ID3D11Device", "CreateClassLinkage", 2);
        dv().setUint32(0x600, 0xdead, true);
        expect(handler({}, mem, [0x9000, 0x600])).toBe(E_NOTIMPL);
        expect(u32(0x600)).toBe(0);
    });

    test("an unimplemented method leaves arguments that are not object out-pointers alone", () => {
        const minLod = (device as any).handler("ID3D11DeviceContext", "GetResourceMinLOD", 2);
        dv().setUint32(0x600, 0xdead, true);
        minLod({}, mem, [0x9000, 0x600]); // pResource is an input
        expect(u32(0x600)).toBe(0xdead);

        const predication = (device as any).handler("ID3D11DeviceContext", "GetPredication", 3);
        dv().setUint32(0x610, 0xdead, true); dv().setUint32(0x614, 0xbeef, true);
        expect(predication({}, mem, [0x9000, 0x610, 0x614])).toBe(E_NOTIMPL);
        expect(u32(0x610)).toBe(0);      // ppPredicate
        expect(u32(0x614)).toBe(0xbeef); // pPredicateValue
    });

    test("every DXGI object answers for IDXGIObject", () => {
        device.init();
        for (const obj of [(device as any).adapter, (device as any).factory, (device as any).output, (device as any).create("IDXGISwapChain")]) {
            expect(call("QueryInterface", [obj, guid(0x400, IID.IDXGIObject), 0x420])).toBe(S_OK);
            expect(u32(0x420)).toBe(obj);
        }
    });

    test("GetBuffer hands out buffer 0 and refuses any other index", () => {
        const tex = createTex();
        const chain = (device as any).create("IDXGISwapChain");
        (objects().get(chain) as any).backBuffer = tex;
        dv().setUint32(0x800, 0xdead, true);
        expect(call("GetBuffer", [chain, 1, 0, 0x800], "IDXGISwapChain")).toBe(DXGI_ERROR_INVALID_CALL);
        expect(u32(0x800)).toBe(0);
        expect(call("GetBuffer", [chain, 0, 0, 0x800], "IDXGISwapChain")).toBe(S_OK);
        expect(u32(0x800)).toBe(tex);
    });

    test("Map lays out each mip by its own size, and Unmap writes that mip", () => {
        const tex = createTex();
        const writes: unknown[][] = [];
        (device as any).renderer.writeTexture = (...a: unknown[]) => writes.push(a);
        expect(call("Map", [0, tex, 1, 2, 0, 0x700], "ID3D11DeviceContext")).toBe(S_OK);
        expect(u32(0x704)).toBe(32 * 4);        // RowPitch of mip 1
        expect(u32(0x708)).toBe(32 * 4 * 32);   // DepthPitch of mip 1
        call("Unmap", [0, tex, 1], "ID3D11DeviceContext");
        expect(writes.map((w) => [w[1], w[2], w[4]])).toEqual([[1, 0, 128]]);
    });
});

function renderer(features: string[] = []): D3D11Renderer {
    Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 1, INDEX: 2, UNIFORM: 4, COPY_DST: 8 } });
    const gpu = { createBuffer: () => ({}), createSampler: () => ({}), features: new Set<string>(features) };
    return new D3D11Renderer({ getDevice: () => gpu } as any);
}

describe("D3D11Renderer.formatSupport", () => {
    test("reports what the renderer can create", () => {
        const r = renderer();
        const TEXTURE2D = 0x20, RENDER_TARGET = 0x4000, DEPTH_STENCIL = 0x10000, IA_INDEX = 0x4, IA_VERTEX = 0x2;
        expect(r.formatSupport(28) & (TEXTURE2D | RENDER_TARGET)).toBe(TEXTURE2D | RENDER_TARGET);   // R8G8B8A8_UNORM
        // R16G16B16A16_UNORM: no texture without the optional WebGPU feature, but still a vertex format.
        expect(r.formatSupport(11) & (TEXTURE2D | RENDER_TARGET)).toBe(0);
        expect(r.formatSupport(11) & IA_VERTEX).toBe(IA_VERTEX);
        expect(r.formatSupport(40) & DEPTH_STENCIL).toBe(DEPTH_STENCIL);                             // D32_FLOAT
        expect(r.formatSupport(57) & IA_INDEX).toBe(IA_INDEX);                                       // R16_UINT
        expect(r.formatSupport(92) & TEXTURE2D).toBe(TEXTURE2D);                                     // B8G8R8X8_TYPELESS
    });

    test("D32_FLOAT_S8X24 exists only where the device has depth32float-stencil8", () => {
        const DEPTH_STENCIL = 0x10000;
        expect(renderer().formatSupport(20)).toBe(0);
        expect(renderer(["depth32float-stencil8"]).formatSupport(20) & DEPTH_STENCIL).toBe(DEPTH_STENCIL);
    });
});

describe("D3D11Renderer.clearState", () => {
    test("drops every binding and restores the default states", () => {
        const r = renderer() as any;
        const fresh = { blend: r.blend, raster: r.raster, depthStencil: r.depthStencil };
        const view = { kind: "view" }, buf = { kind: "buffer" };
        r.setShader("vs", { kind: "shader" }); r.setShader("ps", { kind: "shader" });
        r.setInputLayout({}); r.setTopology(5);
        r.setVertexBuffer(0, buf, 16, 0); r.setIndexBuffer(buf, 57, 0);
        r.setConstantBuffer("ps", 1, buf); r.setShaderResource("ps", 0, view); r.setSampler("vs", 0, {});
        r.setRenderTargets([view], view);
        r.setBlend({ ...fresh.blend }, { r: 0, g: 0, b: 0, a: 0 }); r.setRaster({ ...fresh.raster }); r.setDepthStencil({ ...fresh.depthStencil }, 7);
        r.setViewport({ x: 0, y: 0, w: 8, h: 8, minDepth: 0, maxDepth: 1 }); r.setScissor({ x: 0, y: 0, w: 8, h: 8 });

        r.clearState();
        expect([r.vs, r.ps, r.gs, r.layout, r.ib, r.dsv, r.viewport, r.scissor]).toEqual([null, null, null, null, null, null, null, null]);
        expect(r.topology).toBe(0);
        expect([r.vbs, r.rtvs, r.cbs.ps, r.srvs.ps, r.samplers.vs]).toEqual([[], [], [], [], []]);
        expect([r.blend, r.raster, r.depthStencil]).toEqual([fresh.blend, fresh.raster, fresh.depthStencil]);
        expect(r.blendFactor).toEqual({ r: 1, g: 1, b: 1, a: 1 });
        expect(r.stencilRef).toBe(0);
    });
});
