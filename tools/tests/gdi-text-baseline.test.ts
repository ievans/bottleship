import { expect, test } from "bun:test";
import { textOut } from "../../src/worker/modules/gdi32/gdi-text";

// Canvas' "top" baseline is the em-box top (it reports fontBoundingBoxAscent 2 here), while
// "alphabetic" gives GDI's tmAscent split (11 + 3). A GDI cell starts at the ascent line.
class RecordingContext {
    canvas: Record<string, unknown> = {};
    font = "12px Tahoma";
    fillStyle = "#000";
    textBaseline: CanvasTextBaseline = "top";
    textAlign: CanvasTextAlign = "left";
    fills: Array<{ text: string; x: number; y: number; baseline: string }> = [];

    measureText(text: string) {
        const top = this.textBaseline === "top";
        return {
            width: text.length * 6,
            fontBoundingBoxAscent: top ? 1.7 : 10.6,
            fontBoundingBoxDescent: top ? 12.3 : 2.4,
        } as TextMetrics;
    }
    fillText(text: string, x: number, y: number) { this.fills.push({ text, x, y, baseline: this.textBaseline }); }
    fillRect() {}
}

function setup(textAlign = 0) {
    const ctx = new RecordingContext();
    const state = {
        font: "12px Tahoma", appliedFont: "", fontQuality: 0, fontSize: 12, textColorValue: 0, textColor: "#000",
        appliedFillStyle: "", bkMode: 1, bkColor: "#fff", hBitmap: 0, textAlign, textEscapement: 0,
    };
    const gdi = {
        contexts: new Map([[1, ctx]]), hdcStates: new Map([[1, state]]), overlayCtx: null,
        setOverlayDirty() {}, markDirty() {}, expandDirtyRect() {}, invalidateImageDataCache() {},
        beginClipOn() { return false; }, clipCopyRect() { return null; }, getCurrentPosition: () => ({ x: 0, y: 0 }),
        setCurrentPosition() {},
    };
    return { ctx, gdi };
}

test("TextOut puts the glyph baseline tmAscent below the cell top, on an integer", () => {
    const { ctx, gdi } = setup();
    expect(textOut(gdi as any, 1, 10, 20, "Hello")).toBe(true);
    expect(ctx.fills).toEqual([{ text: "Hello", x: 10, y: 31, baseline: "alphabetic" }]);
    expect(ctx.textBaseline).toBe("top");
});

test("TextOut with TA_BASELINE draws the baseline at the given y", () => {
    const { ctx, gdi } = setup(24);
    textOut(gdi as any, 1, 10, 40, "Hello");
    expect(ctx.fills[0]!.y).toBe(40);
});
