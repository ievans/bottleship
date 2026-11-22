import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { drawText, textOut } from "../../src/worker/modules/gdi32/gdi-text";
import { createSystemExports } from "../../src/worker/modules/user32/system";

class FakeContext {
    canvas: Record<string, unknown> = {};
    font = "12px sans-serif";
    fillStyle: string | CanvasGradient | CanvasPattern = "#000";
    textBaseline: CanvasTextBaseline = "top";
    textAlign: CanvasTextAlign = "left";
    directFillTextCalls = 0;
    putImageDataCalls = 0;
    lastGetImageDataX: number | null = null;

    measureText(text: string) {
        return {
            width: text.length * 6,
            fontBoundingBoxAscent: 9,
            fontBoundingBoxDescent: 3,
        } as TextMetrics;
    }
    fillText() { this.directFillTextCalls++; }
    clearRect() {}
    save() {}
    restore() {}
    beginPath() {}
    rect() {}
    clip() {}
    fillRect() {}
    getImageData(x: number, _y: number, w: number, h: number) {
        this.lastGetImageDataX = x;
        const data = new Uint8ClampedArray(w * h * 4);
        // The scratch glyph has solid coverage at one pixel.
        if (this.canvas.__scratch) data[3] = 255;
        return { data, width: w, height: h } as ImageData;
    }
    putImageData() { this.putImageDataCalls++; }
    imageSmoothingEnabled = true;
    drawImageCalls = 0;
    lastDrawImageDest: { x: number; y: number } | null = null;
    lastDrawImageSmoothing: boolean | null = null;
    drawImage(_src: unknown, ..._args: number[]) {
        this.drawImageCalls++;
        this.lastDrawImageSmoothing = this.imageSmoothingEnabled;
        this.lastDrawImageDest = { x: _args[4], y: _args[5] };
    }
}

test("SystemParametersInfo controls smoothing for default fonts already selected into a DC", () => {
    const systemGdi = System.getInstance().gdiContext;
    const previousSmoothing = systemGdi.fontSmoothingEnabled;
    const previousCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
    const spi = createSystemExports().SystemParametersInfoW!;
    const mem = new Uint8Array(0x20000);
    const result = 0x11000;
    const target = new FakeContext();
    const state = {
        font: "12px sans-serif", appliedFont: "", fontQuality: 0, fontSize: 12,
        textColorValue: 0, textColor: "#000", appliedFillStyle: "", bkMode: 1,
        hBitmap: 0, textAlign: 0, textEscapement: 0,
    };
    const gdi = {
        get fontSmoothingEnabled() { return systemGdi.fontSmoothingEnabled; },
        contexts: new Map([[1, target]]), hdcStates: new Map([[1, state]]), overlayCtx: null,
        markDirty() {}, expandDirtyRect() {}, invalidateImageDataCache() {},
        beginClipOn() { return false; }, clipCopyRect() { return null; },
    };
    (globalThis as any).OffscreenCanvas = class {
        constructor(public width: number, public height: number) {}
        getContext() { return new FakeContext(); }
    };
    const smoothing = () => {
        expect(spi({} as never, mem, [74, 0, result, 0])).toBe(1); // SPI_GETFONTSMOOTHING
        return new DataView(mem.buffer).getUint32(result, true);
    };
    const setSmoothing = (enabled: number) =>
        expect(spi({} as never, mem, [75, enabled, 0, 0])).toBe(1); // SPI_SETFONTSMOOTHING

    try {
        setSmoothing(1);
        expect(smoothing()).toBe(1);
        expect(textOut(gdi as any, 1, 0, 0, "%")).toBe(true);

        setSmoothing(0);
        expect(smoothing()).toBe(0);
        expect(textOut(gdi as any, 1, 0, 0, "%")).toBe(true);
        expect(drawText(gdi as any, 1, "Score")).not.toBeNull();
        expect(target.directFillTextCalls).toBe(1);
        expect(target.drawImageCalls).toBe(2);

        state.fontQuality = 4; // ANTIALIASED_QUALITY overrides the desktop setting.
        expect(textOut(gdi as any, 1, 0, 0, "%")).toBe(true);
        state.fontQuality = 0;
        setSmoothing(1);
        expect(textOut(gdi as any, 1, 0, 0, "%")).toBe(true);
        expect(target.directFillTextCalls).toBe(3);
    } finally {
        systemGdi.fontSmoothingEnabled = previousSmoothing;
        if (previousCanvas) Object.defineProperty(globalThis, "OffscreenCanvas", previousCanvas);
        else delete (globalThis as any).OffscreenCanvas;
    }
});

test("DrawText keeps font smoothing for DEFAULT_QUALITY", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
    class FakeOffscreenCanvas {
        width: number;
        height: number;
        private readonly ctx = new FakeContext();
        constructor(width: number, height: number) {
            this.width = width;
            this.height = height;
            this.ctx.canvas = { __scratch: true };
        }
        getContext() { return this.ctx; }
    }
    (globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;

    try {
        const target = new FakeContext();
        const state = {
            font: "12px sans-serif",
            appliedFont: "",
            fontQuality: 0,
            fontSize: 12,
            textColorValue: 0x00332211,
            textColor: "#112233",
            appliedFillStyle: "",
            bkMode: 1,
            bkColor: "#ff00ff",
            hBitmap: 0,
        };
        const gdi = {
            contexts: new Map([[1, target]]),
            hdcStates: new Map([[1, state]]),
            overlayCtx: null,
            setOverlayDirty() {},
            markDirty() {},
            invalidateImageDataCache() {},
            // No clip region on this DC: the text path must not save/restore for one.
            beginClipOn() { return false; },
            clipCopyRect() { return null; },
        };

        expect(drawText(gdi as any, 1, "Begin the Journey", {
            left: 0, top: 0, right: 200, bottom: 30,
        }, 0x21)).not.toBeNull(); // DT_SINGLELINE | DT_CENTER

        expect(target.directFillTextCalls).toBe(1);
        expect(target.putImageDataCalls).toBe(0);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'OffscreenCanvas', previous);
        else delete (globalThis as any).OffscreenCanvas;
    }
});

test("DrawText thresholds only explicitly NONANTIALIASED_QUALITY fonts", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
    class FakeOffscreenCanvas {
        width: number;
        height: number;
        private readonly ctx = new FakeContext();
        constructor(width: number, height: number) {
            this.width = width;
            this.height = height;
            this.ctx.canvas = { __scratch: true };
        }
        getContext() { return this.ctx; }
    }
    (globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;

    try {
        const target = new FakeContext();
        const state = {
            font: "12px sans-serif", appliedFont: "", fontQuality: 3, fontSize: 12,
            textColorValue: 0x00332211, textColor: "#112233", appliedFillStyle: "",
            bkMode: 1, bkColor: "#ff00ff", hBitmap: 0,
        };
        const gdi = {
            contexts: new Map([[1, target]]), hdcStates: new Map([[1, state]]),
            overlayCtx: null, setOverlayDirty() {}, markDirty() {}, invalidateImageDataCache() {},
            beginClipOn() { return false; },
            clipCopyRect() { return null; },
        };

        expect(drawText(gdi as any, 1, "Begin the Journey", {
            left: 0, top: 0, right: 200, bottom: 30,
        }, 0x21)).not.toBeNull(); // DT_SINGLELINE | DT_CENTER
        expect(target.directFillTextCalls).toBe(0);
        // The thresholded mask is COMPOSITED (drawImage), not written past the clip
        // (putImageData), and with filtering off so the hard edges survive a transform.
        expect(target.putImageDataCalls).toBe(0);
        expect(target.drawImageCalls).toBe(1);
        expect(target.lastDrawImageSmoothing).toBe(false);
        expect(target.imageSmoothingEnabled).toBe(true); // restored
        expect(target.lastDrawImageDest?.x).toBe(47);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'OffscreenCanvas', previous);
        else delete (globalThis as any).OffscreenCanvas;
    }
});
