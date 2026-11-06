/**
 * D3D11 state objects, decoded from their guest descriptors into the WebGPU pieces a
 * pipeline or sampler takes. Every decoder accepts `null` for the D3D11 default state.
 */

export interface BlendTarget { blend: GPUBlendState | null; writeMask: number }
export interface BlendState { alphaToCoverage: boolean; targets: BlendTarget[]; key: string }
export interface RasterState { cullMode: GPUCullMode; frontFace: GPUFrontFace; depthBias: number; slopeScale: number; biasClamp: number; scissor: boolean; key: string }
export interface DepthStencilState {
    depthEnable: boolean; depthWrite: boolean; depthCompare: GPUCompareFunction;
    stencilEnable: boolean; readMask: number; writeMask: number;
    front: GPUStencilFaceState; back: GPUStencilFaceState; key: string;
}

const BLEND: Record<number, GPUBlendFactor> = {
    1: "zero", 2: "one", 3: "src", 4: "one-minus-src", 5: "src-alpha", 6: "one-minus-src-alpha",
    7: "dst-alpha", 8: "one-minus-dst-alpha", 9: "dst", 10: "one-minus-dst", 11: "src-alpha-saturated",
    14: "constant", 15: "one-minus-constant",
};
const BLEND_ALPHA: Record<number, GPUBlendFactor> = { ...BLEND, 3: "src-alpha", 4: "one-minus-src-alpha", 9: "dst-alpha", 10: "one-minus-dst-alpha" };
const BLEND_OP: Record<number, GPUBlendOperation> = { 1: "add", 2: "subtract", 3: "reverse-subtract", 4: "min", 5: "max" };
export const COMPARE: Record<number, GPUCompareFunction> = {
    1: "never", 2: "less", 3: "equal", 4: "less-equal", 5: "greater", 6: "not-equal", 7: "greater-equal", 8: "always",
};
const STENCIL_OP: Record<number, GPUStencilOperation> = {
    1: "keep", 2: "zero", 3: "replace", 4: "increment-clamp", 5: "decrement-clamp", 6: "invert",
    7: "increment-wrap", 8: "decrement-wrap",
};

const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const f32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(o, true);

function component(src: number, dst: number, op: number, alpha: boolean): GPUBlendComponent {
    const factors = alpha ? BLEND_ALPHA : BLEND;
    const operation = BLEND_OP[op] ?? "add";
    // min/max ignore the factors in D3D11; WebGPU requires them to be one.
    if (operation === "min" || operation === "max") return { operation, srcFactor: "one", dstFactor: "one" };
    return { operation, srcFactor: factors[src] ?? "one", dstFactor: factors[dst] ?? "zero" };
}

/** D3D11_BLEND_DESC: AlphaToCoverageEnable, IndependentBlendEnable, RenderTarget[8] (32 bytes each). */
export function decodeBlend(d: Uint8Array | null): BlendState {
    const targets: BlendTarget[] = [];
    if (!d) {
        for (let i = 0; i < 8; i++) targets.push({ blend: null, writeMask: 0xf });
        return { alphaToCoverage: false, targets, key: "default" };
    }
    const independent = u32(d, 4) !== 0;
    for (let i = 0; i < 8; i++) {
        const o = 8 + (independent ? i : 0) * 32;
        const enable = u32(d, o) !== 0;
        const blend = enable ? {
            color: component(u32(d, o + 4), u32(d, o + 8), u32(d, o + 12), false),
            alpha: component(u32(d, o + 16), u32(d, o + 20), u32(d, o + 24), true),
        } : null;
        targets.push({ blend, writeMask: d[o + 28]! & 0xf });
    }
    return { alphaToCoverage: u32(d, 0) !== 0, targets, key: Array.from(d.subarray(0, 8 + 8 * 32)).join(",") };
}

/** D3D11_RASTERIZER_DESC (40 bytes). */
export function decodeRaster(d: Uint8Array | null): RasterState {
    if (!d) return { cullMode: "back", frontFace: "cw", depthBias: 0, slopeScale: 0, biasClamp: 0, scissor: false, key: "default" };
    const cull = u32(d, 4);
    return {
        cullMode: cull === 1 ? "none" : cull === 2 ? "front" : "back",
        frontFace: u32(d, 8) !== 0 ? "ccw" : "cw",
        depthBias: u32(d, 12) | 0,
        biasClamp: f32(d, 16),
        slopeScale: f32(d, 20),
        scissor: u32(d, 28) !== 0,
        key: Array.from(d.subarray(0, 40)).join(","),
    };
}

function face(d: Uint8Array, o: number): GPUStencilFaceState {
    return {
        failOp: STENCIL_OP[u32(d, o)] ?? "keep",
        depthFailOp: STENCIL_OP[u32(d, o + 4)] ?? "keep",
        passOp: STENCIL_OP[u32(d, o + 8)] ?? "keep",
        compare: COMPARE[u32(d, o + 12)] ?? "always",
    };
}

/** D3D11_DEPTH_STENCIL_DESC (52 bytes). */
export function decodeDepthStencil(d: Uint8Array | null): DepthStencilState {
    const keep: GPUStencilFaceState = { failOp: "keep", depthFailOp: "keep", passOp: "keep", compare: "always" };
    if (!d) {
        return { depthEnable: true, depthWrite: true, depthCompare: "less", stencilEnable: false, readMask: 0xff, writeMask: 0xff, front: keep, back: keep, key: "default" };
    }
    const depthEnable = u32(d, 0) !== 0;
    const stencilEnable = u32(d, 12) !== 0;
    return {
        depthEnable,
        depthWrite: depthEnable && u32(d, 4) !== 0,
        depthCompare: depthEnable ? (COMPARE[u32(d, 8)] ?? "less") : "always",
        stencilEnable,
        readMask: d[16]!,
        writeMask: d[17]!,
        front: stencilEnable ? face(d, 20) : keep,
        back: stencilEnable ? face(d, 36) : keep,
        key: Array.from(d.subarray(0, 52)).join(","),
    };
}

const ADDRESS: Record<number, GPUAddressMode> = { 1: "repeat", 2: "mirror-repeat", 3: "clamp-to-edge", 4: "clamp-to-edge", 5: "mirror-repeat" };

/** D3D11_SAMPLER_DESC (52 bytes) → GPUSamplerDescriptor. */
export function decodeSampler(d: Uint8Array | null): GPUSamplerDescriptor {
    if (!d) {
        return { minFilter: "linear", magFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" };
    }
    const filter = u32(d, 0);
    const comparison = (filter & 0x80) !== 0;
    const anisotropic = (filter & 0x40) !== 0;
    const lin = (bit: number): GPUFilterMode => (anisotropic || (filter & bit) ? "linear" : "nearest");
    const maxAniso = Math.max(1, Math.min(16, u32(d, 20)));
    const desc: GPUSamplerDescriptor = {
        minFilter: lin(0x10),
        magFilter: lin(0x4),
        mipmapFilter: lin(0x1) as GPUMipmapFilterMode,
        addressModeU: ADDRESS[u32(d, 4)] ?? "clamp-to-edge",
        addressModeV: ADDRESS[u32(d, 8)] ?? "clamp-to-edge",
        addressModeW: ADDRESS[u32(d, 12)] ?? "clamp-to-edge",
        lodMinClamp: Math.max(0, f32(d, 44)),
        lodMaxClamp: Math.min(32, Math.max(0, f32(d, 48))),
    };
    if (anisotropic && maxAniso > 1) desc.maxAnisotropy = maxAniso;
    if (comparison) desc.compare = COMPARE[u32(d, 24)] ?? "less-equal";
    if ((desc.lodMaxClamp ?? 32) < (desc.lodMinClamp ?? 0)) desc.lodMaxClamp = desc.lodMinClamp;
    return desc;
}
