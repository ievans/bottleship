/**
 * DXGI_FORMAT → WebGPU, for textures (with the typeless families resolved by how the
 * resource is bound) and for vertex attributes.
 */

export interface TextureFormatInfo {
    format: GPUTextureFormat;
    /** Bytes per texel, or per 4×4 block when `block`. */
    bytes: number;
    block: boolean;
    depth: boolean;
    stencil: boolean;
    /** Other formats a view may take (the sRGB twin of a typeless resource). */
    viewFormats?: GPUTextureFormat[];
}

const color = (format: GPUTextureFormat, bytes: number, viewFormats?: GPUTextureFormat[]): TextureFormatInfo =>
    ({ format, bytes, block: false, depth: false, stencil: false, viewFormats });
const bc = (format: GPUTextureFormat, bytes: number): TextureFormatInfo =>
    ({ format, bytes, block: true, depth: false, stencil: false });
const depth = (format: GPUTextureFormat, bytes: number, stencil: boolean): TextureFormatInfo =>
    ({ format, bytes, block: false, depth: true, stencil });

/** The depth format a typeless/depth/shader-view DXGI format resolves to when bound as depth. */
function depthFamily(f: number): TextureFormatInfo | null {
    switch (f) {
        case 39: case 40: case 41: return depth("depth32float", 4, false);       // R32_TYPELESS, D32_FLOAT, R32_FLOAT
        case 44: case 45: case 46: case 47: return depth("depth24plus-stencil8", 4, true); // R24G8 family
        case 19: case 20: case 21: case 22: return depth("depth24plus-stencil8", 8, true); // R32G8X24 family
        case 53: case 55: case 56: return depth("depth16unorm", 2, false);       // R16_TYPELESS, D16_UNORM, R16_UNORM
        default: return null;
    }
}

export function isDepthFamily(format: number): boolean {
    return depthFamily(format) !== null && [40, 45, 20, 55, 39, 44, 19, 53].includes(format);
}

/**
 * Resolve a resource's DXGI format; `asDepth` when the resource is bound DEPTH_STENCIL.
 * The 16-bit normalized formats exist in WebGPU only with an optional device feature, so
 * they resolve only when `norm16` says the device enabled it.
 */
export function textureFormat(f: number, asDepth: boolean, norm16 = false): TextureFormatInfo | null {
    if (asDepth) return depthFamily(f);
    switch (f) {
        case 1: case 2: return color("rgba32float", 16);
        case 3: return color("rgba32uint", 16);
        case 4: return color("rgba32sint", 16);
        case 9: case 10: return color("rgba16float", 8);
        case 11: return norm16 ? color("rgba16unorm" as GPUTextureFormat, 8) : null;
        case 12: return color("rgba16uint", 8);
        case 13: return norm16 ? color("rgba16snorm" as GPUTextureFormat, 8) : null;
        case 14: return color("rgba16sint", 8);
        case 15: case 16: return color("rg32float", 8);
        case 17: return color("rg32uint", 8);
        case 23: case 24: return color("rgb10a2unorm", 4);
        case 25: return color("rgb10a2uint", 4);
        case 26: return color("rg11b10ufloat", 4);
        case 27: case 28: return color("rgba8unorm", 4, ["rgba8unorm-srgb"]);
        case 29: return color("rgba8unorm-srgb", 4, ["rgba8unorm"]);
        case 30: return color("rgba8uint", 4);
        case 31: return color("rgba8snorm", 4);
        case 32: return color("rgba8sint", 4);
        case 33: case 34: return color("rg16float", 4);
        case 35: return norm16 ? color("rg16unorm" as GPUTextureFormat, 4) : null;
        case 36: return color("rg16uint", 4);
        case 39: case 41: return color("r32float", 4);
        case 42: return color("r32uint", 4);
        case 43: return color("r32sint", 4);
        case 48: case 49: return color("rg8unorm", 2);
        case 50: return color("rg8uint", 2);
        case 51: return color("rg8snorm", 2);
        case 53: case 54: return color("r16float", 2);
        case 56: return norm16 ? color("r16unorm" as GPUTextureFormat, 2) : null;
        case 57: return color("r16uint", 2);
        case 60: case 61: case 65: return color("r8unorm", 1);
        case 62: return color("r8uint", 1);
        case 63: return color("r8snorm", 1);
        case 70: case 71: return bc("bc1-rgba-unorm", 8);
        case 72: return bc("bc1-rgba-unorm-srgb", 8);
        case 73: case 74: return bc("bc2-rgba-unorm", 16);
        case 75: return bc("bc2-rgba-unorm-srgb", 16);
        case 76: case 77: return bc("bc3-rgba-unorm", 16);
        case 78: return bc("bc3-rgba-unorm-srgb", 16);
        case 79: case 80: return bc("bc4-r-unorm", 8);
        case 81: return bc("bc4-r-snorm", 8);
        case 82: case 83: return bc("bc5-rg-unorm", 16);
        case 84: return bc("bc5-rg-snorm", 16);
        case 87: case 88: case 90: return color("bgra8unorm", 4, ["bgra8unorm-srgb"]);
        case 91: case 93: return color("bgra8unorm-srgb", 4, ["bgra8unorm"]);
        default: return null;
    }
}

/** A view's format: the resource's own unless the view names the sRGB twin. */
export function viewFormat(resource: TextureFormatInfo, viewDxgi: number): GPUTextureFormat {
    if (resource.depth || !viewDxgi) return resource.format;
    const v = textureFormat(viewDxgi, false);
    if (v && resource.viewFormats?.includes(v.format)) return v.format;
    return resource.format;
}

export interface VertexFormatInfo { format: GPUVertexFormat; bytes: number }

export function vertexFormat(f: number): VertexFormatInfo | null {
    const m: Record<number, VertexFormatInfo> = {
        2: { format: "float32x4", bytes: 16 }, 3: { format: "uint32x4", bytes: 16 }, 4: { format: "sint32x4", bytes: 16 },
        6: { format: "float32x3", bytes: 12 }, 7: { format: "uint32x3", bytes: 12 }, 8: { format: "sint32x3", bytes: 12 },
        10: { format: "float16x4", bytes: 8 }, 11: { format: "unorm16x4", bytes: 8 }, 12: { format: "uint16x4", bytes: 8 },
        13: { format: "snorm16x4", bytes: 8 }, 14: { format: "sint16x4", bytes: 8 },
        16: { format: "float32x2", bytes: 8 }, 17: { format: "uint32x2", bytes: 8 }, 18: { format: "sint32x2", bytes: 8 },
        24: { format: "unorm10-10-10-2", bytes: 4 },
        28: { format: "unorm8x4", bytes: 4 }, 30: { format: "uint8x4", bytes: 4 }, 31: { format: "snorm8x4", bytes: 4 },
        32: { format: "sint8x4", bytes: 4 },
        34: { format: "float16x2", bytes: 4 }, 35: { format: "unorm16x2", bytes: 4 }, 36: { format: "uint16x2", bytes: 4 },
        37: { format: "snorm16x2", bytes: 4 }, 38: { format: "sint16x2", bytes: 4 },
        41: { format: "float32", bytes: 4 }, 42: { format: "uint32", bytes: 4 }, 43: { format: "sint32", bytes: 4 },
        49: { format: "unorm8x2", bytes: 2 }, 50: { format: "uint8x2", bytes: 2 }, 51: { format: "snorm8x2", bytes: 2 },
        87: { format: "unorm8x4-bgra" as GPUVertexFormat, bytes: 4 },
    };
    return m[f] ?? null;
}

/** Whether a color format can be a blend target and filtered with float32-filterable absent. */
export function isFloat32Format(format: GPUTextureFormat): boolean {
    return format === "rgba32float" || format === "rg32float" || format === "r32float";
}
