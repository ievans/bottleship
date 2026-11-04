/**
 * GetGlyphOutline (issue #37): D3DX8's ID3DXFont calls this once per glyph while building its
 * font-texture atlas. Before this, every uChar failed, so the atlas cell kept whatever was
 * already there — collapsing comma/period/quote/etc. onto one leftover glyph (usually a
 * colon). These tests pin the rasterizer's math (ink-box metrics, GGO_BITMAP/GRAY8_BITMAP
 * packing) against a scriptable fake OffscreenCanvas, the same technique
 * gdi-drawtext-aliasing.test.ts uses for the sibling TextOut/DrawText aliased path.
 */
import { afterEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { getGlyphOutline } from "../../src/worker/modules/gdi32/gdi-text";
import { GDIContext } from "../../src/worker/modules/gdi32/context";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";

const GGO_METRICS = 0, GGO_BITMAP = 1, GGO_GRAY8_BITMAP = 6;
const GDI_ERROR = 0xFFFFFFFF;

/** Mutable scenario the fake canvas's measureText/getImageData read on every call, so the
 *  module-level scratch-canvas singleton in gdi-text.ts can be reused across calls/tests
 *  without staling: behavior comes from this object, not from when the canvas was built. */
let scenario = {
    width: 0,
    abLeft: 0, abRight: 0, abAscent: 0, abDescent: 0,
    /** alpha[y][x], exactly blackBoxY rows by blackBoxX columns for the format tests. */
    alpha: [] as number[][],
};

class FakeContext {
    canvas: Record<string, unknown> = {};
    font = "";
    fillStyle: string = "";
    textBaseline: CanvasTextBaseline = "alphabetic";
    textAlign: CanvasTextAlign = "left";
    measureText(_text: string) {
        return {
            width: scenario.width,
            actualBoundingBoxLeft: scenario.abLeft,
            actualBoundingBoxRight: scenario.abRight,
            actualBoundingBoxAscent: scenario.abAscent,
            actualBoundingBoxDescent: scenario.abDescent,
        } as TextMetrics;
    }
    clearRect() {}
    fillText() {}
    getImageData(_x: number, _y: number, w: number, h: number) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                data[(y * w + x) * 4 + 3] = scenario.alpha[y]?.[x] ?? 0;
            }
        }
        return { data, width: w, height: h } as ImageData;
    }
}

function installFakeOffscreenCanvas(): () => void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
    class FakeOffscreenCanvas {
        width: number;
        height: number;
        private readonly ctx = new FakeContext();
        constructor(width: number, height: number) {
            this.width = width;
            this.height = height;
        }
        getContext() { return this.ctx; }
    }
    (globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;
    return () => {
        if (previous) Object.defineProperty(globalThis, 'OffscreenCanvas', previous);
        else delete (globalThis as any).OffscreenCanvas;
    };
}

function fakeGdi(fontSize = 16) {
    return {
        getMeasureContext() { return { font: "16px sans-serif" } as unknown as OffscreenCanvasRenderingContext2D; },
        hdcStates: new Map([[1, { fontSize } as any]]),
    } as unknown as GDIContext;
}

test("GGO_METRICS reports the glyph's ink box and advance without rasterizing", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { width: 10, abLeft: 1, abRight: 5, abAscent: 8, abDescent: 2, alpha: [] };
        const r = getGlyphOutline(fakeGdi(), 1, 'A', GGO_METRICS);
        expect(r).not.toBeNull();
        expect(r!.blackBoxX).toBe(6);  // ceil(abLeft + abRight)
        expect(r!.blackBoxY).toBe(10); // ceil(abAscent + abDescent)
        expect(r!.originX).toBe(-1);   // -abLeft
        expect(r!.originY).toBe(8);    // abAscent
        expect(r!.cellIncX).toBe(10);  // advance width
        expect(r!.bitmap).toBeNull();
    } finally { restore(); }
});

test("a glyph with no ink (space) still reports a usable 1x1 box", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { width: 8, abLeft: 0, abRight: 0, abAscent: 0, abDescent: 0, alpha: [] };
        const r = getGlyphOutline(fakeGdi(), 1, ' ', GGO_METRICS);
        expect(r!.blackBoxX).toBe(1);
        expect(r!.blackBoxY).toBe(1);
    } finally { restore(); }
});

test("GGO_BITMAP packs 1bpp rows MSB-first, padded to a DWORD", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        // A 3x2 box: row0 = 1,0,1 ; row1 = 0,1,0 (coverage thresholded at >=128).
        scenario = {
            width: 3, abLeft: 0, abRight: 3, abAscent: 2, abDescent: 0,
            alpha: [[255, 0, 255], [0, 255, 0]],
        };
        const r = getGlyphOutline(fakeGdi(), 1, 'x', GGO_BITMAP);
        expect(r).not.toBeNull();
        expect(r!.blackBoxX).toBe(3);
        expect(r!.blackBoxY).toBe(2);
        const bmp = r!.bitmap!;
        expect(bmp.length).toBe(8); // stride 4 (padded from 1 byte) * 2 rows
        expect(bmp[0]).toBe(0b10100000);
        expect(bmp[1]).toBe(0);
        expect(bmp[4]).toBe(0b01000000);
        expect(bmp[5]).toBe(0);
    } finally { restore(); }
});

test("GGO_GRAY8_BITMAP quantizes alpha coverage to 0..64", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = {
            width: 2, abLeft: 0, abRight: 2, abAscent: 1, abDescent: 0,
            alpha: [[255, 128]],
        };
        const r = getGlyphOutline(fakeGdi(), 1, 'y', GGO_GRAY8_BITMAP);
        expect(r).not.toBeNull();
        const bmp = r!.bitmap!;
        expect(bmp.length).toBe(4); // stride 4 (2 bytes padded to a DWORD) * 1 row
        expect(bmp[0]).toBe(64);
        expect(bmp[1]).toBe(32);
    } finally { restore(); }
});

test("GGO_NATIVE (true vector outline) is not supported and fails cleanly", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { width: 8, abLeft: 0, abRight: 6, abAscent: 8, abDescent: 2, alpha: [] };
        expect(getGlyphOutline(fakeGdi(), 1, 'A', 0x0002)).toBeNull();
    } finally { restore(); }
});

// --- Thunk-level: GetGlyphOutlineA/W and GetKerningPairsA/W -----------------------------

type Thunk = (c: unknown, m: Uint8Array, a: number[]) => number;

const savedInstance = (System as unknown as { instance: unknown }).instance;
afterEach(() => { (System as unknown as { instance: unknown }).instance = savedInstance; });

function setupThunks() {
    const mem = new Uint8Array(0x1000);
    (System as unknown as { instance: unknown }).instance = { gdiContext: new GDIContext(), process: { getCurrentMemory: () => mem } };
    return { mem, exports: createPaintingExports() as Record<string, Thunk> };
}

test("GetGlyphOutlineA fills GLYPHMETRICS and returns the raster size", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = {
            width: 5, abLeft: 0, abRight: 3, abAscent: 2, abDescent: 0,
            alpha: [[255, 255, 0], [0, 0, 0]],
        };
        const { mem, exports } = setupThunks();
        const lpgm = 0x100, lpvBuffer = 0x200, cbBuffer = 0x100;
        const required = exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_BITMAP, lpgm, cbBuffer, lpvBuffer, 0]);
        expect(required).toBeGreaterThan(0);
        expect(required).not.toBe(GDI_ERROR);

        const dv = new DataView(mem.buffer);
        expect(dv.getUint32(lpgm, true)).toBe(3);      // gmBlackBoxX
        expect(dv.getUint32(lpgm + 4, true)).toBe(2);  // gmBlackBoxY
        expect(dv.getInt16(lpgm + 16, true)).toBe(5);  // gmCellIncX

        // 3 columns -> stride 4; row0 bits 110..., row1 all zero.
        expect(mem[lpvBuffer]).toBe(0b11000000);
        expect(mem[lpvBuffer + 4]).toBe(0);
        expect(required).toBe(8);
    } finally { restore(); }
});

test("a too-small buffer fails without a partial write, and NULL buffer queries the size", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { width: 5, abLeft: 0, abRight: 3, abAscent: 2, abDescent: 0, alpha: [[255, 255, 0], [0, 0, 0]] };
        const { mem, exports } = setupThunks();
        const lpgm = 0x100, lpvBuffer = 0x200;

        mem.fill(0xAA, lpvBuffer, lpvBuffer + 16);
        const tooSmall = exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_BITMAP, lpgm, 1, lpvBuffer, 0]);
        expect(tooSmall).toBe(GDI_ERROR);
        expect(mem[lpvBuffer]).toBe(0xAA); // untouched

        const queried = exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_BITMAP, lpgm, 0, 0, 0]);
        expect(queried).toBe(8);
    } finally { restore(); }
});

test("GetGlyphOutlineW takes uChar as a UTF-16 code unit, not an ANSI byte", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { width: 4, abLeft: 0, abRight: 2, abAscent: 2, abDescent: 0, alpha: [[0, 0], [0, 0]] };
        const { mem, exports } = setupThunks();
        // 0x20AC (€) has no single-byte Windows-1252 representation; the W entry must not
        // try to decode it as one.
        const r = exports['GetGlyphOutlineW']!({}, mem, [0, 0x20AC, GGO_METRICS, 0x100, 0, 0, 0]);
        expect(r).toBe(0);
    } finally { restore(); }
});

test("GetKerningPairsA/W report zero kerning pairs instead of failing", () => {
    const { mem, exports } = setupThunks();
    expect(exports['GetKerningPairsA']!({}, mem, [0, 0, 0])).toBe(0);
    expect(exports['GetKerningPairsW']!({}, mem, [0, 0, 0])).toBe(0);
});
