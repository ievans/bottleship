/**
 * D3D11 resource copies and CPU readback: CopySubresourceRegion (Rise of Nations fills its
 * terrain tiles with it) and Map(READ) of a staging texture (its minimap is a GPU render
 * the game reads back through one).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { D3D11Device } from "../../src/worker/modules/d3d11/device";
import { D3D11Renderer, type TextureRes } from "../../src/worker/backends/webgpu/d3d11/renderer";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const saved = { GPUBufferUsage: globalThis.GPUBufferUsage, GPUTextureUsage: globalThis.GPUTextureUsage };
afterEach(() => Object.assign(globalThis, saved));

function texture(width: number, height: number, opts: Partial<TextureRes> & { format?: string; block?: boolean } = {}): TextureRes {
    return {
        kind: "texture", width, height, mips: 1, layers: 1, dxgi: 28, generateMips: false,
        info: { bytes: opts.block ? 8 : 4, block: !!opts.block, depth: false, stencil: false } as TextureRes["info"],
        gpu: { format: opts.format ?? (opts.block ? "bc1-rgba-unorm" : "rgba8unorm") } as GPUTexture,
        ...opts,
    } as TextureRes;
}

describe("D3D11Renderer.copyTextureRegion", () => {
    let copies: Array<{ src: any; dst: any; size: any }>;
    let renderer: D3D11Renderer;
    beforeEach(() => {
        Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 1, INDEX: 2, UNIFORM: 4, COPY_DST: 8, COPY_SRC: 16, MAP_READ: 32 } });
        copies = [];
        const encoder = { copyTextureToTexture: (src: any, dst: any, size: any) => copies.push({ src, dst, size }), finish: () => ({}) };
        const device = {
            createBuffer: () => ({}), createSampler: () => ({}), createCommandEncoder: () => encoder,
            queue: { submit: () => undefined },
        };
        renderer = new D3D11Renderer({ getDevice: () => device } as any);
    });

    test("copies the source box to the destination point", () => {
        renderer.copyTextureRegion(texture(85, 85), 0, 0, 0, 0, texture(1024, 1024), 0, 0, { x: 170, y: 85, w: 85, h: 85 });
        expect(copies).toEqual([{ src: expect.objectContaining({ origin: { x: 170, y: 85, z: 0 } }), dst: expect.objectContaining({ origin: { x: 0, y: 0, z: 0 } }), size: { width: 85, height: 85, depthOrArrayLayers: 1 } }]);
    });

    test("no box copies the whole source mip, clamped to the destination", () => {
        renderer.copyTextureRegion(texture(64, 64), 0, 0, 32, 16, texture(256, 256), 0, 0, null);
        expect(copies[0]!.size).toEqual({ width: 32, height: 48, depthOrArrayLayers: 1 });
    });

    test("different formats and a block copy off a 4x4 boundary are skipped", () => {
        renderer.copyTextureRegion(texture(8, 8), 0, 0, 0, 0, texture(8, 8, { format: "bgra8unorm" }), 0, 0, null);
        renderer.copyTextureRegion(texture(16, 16, { block: true }), 0, 0, 2, 0, texture(16, 16, { block: true }), 0, 0, null);
        expect(copies).toEqual([]);
    });
});

describe("D3D11Device CopySubresourceRegion, Map and Unmap", () => {
    let mem: Uint8Array;
    let calls: Array<[string, ...unknown[]]>;
    let device: D3D11Device;
    const impl = (name: string, args: number[]) => (device as any).impls[name].call(device, [0, ...args], "ID3D11DeviceContext");

    beforeEach(() => {
        mem = new Uint8Array(0x10000);
        Mem.bind(() => mem, (a, n) => a >= 0 && a + n <= mem.length);
        let heap = 0x8000;
        const process = { memory: { alloc: (n: number) => { const p = heap; heap += (n + 15) & ~15; return p; } } };
        calls = [];
        const renderer = new Proxy({}, {
            get: (_t, name: string) => name === "readTextureData"
                ? async (...a: unknown[]) => { calls.push([name, ...a]); return { width: 2, height: 1, texel: 4, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }; }
                : (...a: unknown[]) => { calls.push([name, ...a]); },
        });
        device = new D3D11Device(process as any, 0xb000, renderer as any);
    });

    const put = (ptr: number, res: object, extra: object = {}) => (device as any).objects.set(ptr, { iface: "ID3D11Texture2D", refs: 1, aliases: new Map(), res, ...extra });

    test("CopySubresourceRegion splits subresources into mip/layer and reads the source box", () => {
        const dst = { ...texture(85, 85), mips: 2, layers: 2 }, src = texture(512, 512);
        put(0x100, dst); put(0x200, src);
        new DataView(mem.buffer).setUint32(0x300, 85, true);      // left
        new DataView(mem.buffer).setUint32(0x304, 170, true);     // top
        new DataView(mem.buffer).setUint32(0x30c, 170, true);     // right
        new DataView(mem.buffer).setUint32(0x310, 255, true);     // bottom
        impl("CopySubresourceRegion", [0x100, 3, 4, 8, 0, 0x200, 0, 0x300]);
        expect(calls).toEqual([["copyTextureRegion", dst, 1, 1, 4, 8, src, 0, 0, { x: 85, y: 170, w: 85, h: 85 }]]);
    });

    test("Map(READ) of a texture fills the mapping from the GPU, and its Unmap writes nothing back", async () => {
        const tex = texture(2, 1);
        put(0x100, tex);
        const pMapped = 0x400;
        expect(await impl("Map", [0x100, 0, 1, 0, pMapped])).toBe(0);
        const ptr = new DataView(mem.buffer).getUint32(pMapped, true);
        expect([...mem.subarray(ptr, ptr + 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(new DataView(mem.buffer).getUint32(pMapped + 4, true)).toBe(8); // RowPitch
        impl("Unmap", [0x100, 0]);
        expect(calls.map((c) => c[0])).toEqual(["readTextureData"]);
    });

    test("Map(WRITE) of a texture uploads on Unmap without a readback", () => {
        const tex = texture(2, 1);
        put(0x100, tex);
        expect(impl("Map", [0x100, 0, 2, 0, 0x400])).toBe(0);
        impl("Unmap", [0x100, 0]);
        expect(calls.map((c) => c[0])).toEqual(["writeTexture"]);
    });
});
