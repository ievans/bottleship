/** D3D11 device COM objects: reference counts, QueryInterface, failures, and per-subresource Map. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { D3D11Device } from "../../src/worker/modules/d3d11/device";
import { D3D11Renderer, type TextureRes } from "../../src/worker/backends/webgpu/d3d11/renderer";
import { IID } from "../../src/worker/modules/d3d11/interfaces";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { resetComMemory } from "../../src/worker/core/com/com-memory";

const S_OK = 0, E_INVALIDARG = 0x80070057, E_NOTIMPL = 0x80004001, E_NOINTERFACE = 0x80004002;

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

describe("D3D11Renderer.formatSupport", () => {
    test("reports what the renderer can create", () => {
        Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 1, INDEX: 2, UNIFORM: 4, COPY_DST: 8 } });
        const gpu = { createBuffer: () => ({}), createSampler: () => ({}), features: new Set<string>() };
        const r = new D3D11Renderer({ getDevice: () => gpu } as any);
        const TEXTURE2D = 0x20, RENDER_TARGET = 0x4000, DEPTH_STENCIL = 0x10000, IA_INDEX = 0x4, IA_VERTEX = 0x2;
        expect(r.formatSupport(28) & (TEXTURE2D | RENDER_TARGET)).toBe(TEXTURE2D | RENDER_TARGET);   // R8G8B8A8_UNORM
        // R16G16B16A16_UNORM: no texture without the optional WebGPU feature, but still a vertex format.
        expect(r.formatSupport(11) & (TEXTURE2D | RENDER_TARGET)).toBe(0);
        expect(r.formatSupport(11) & IA_VERTEX).toBe(IA_VERTEX);
        expect(r.formatSupport(40) & DEPTH_STENCIL).toBe(DEPTH_STENCIL);                             // D32_FLOAT
        expect(r.formatSupport(57) & IA_INDEX).toBe(IA_INDEX);                                       // R16_UINT
    });
});
