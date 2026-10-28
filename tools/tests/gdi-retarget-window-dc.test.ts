/**
 * A GetDC window DC held across a resize follows the window: its target rect updates and
 * its backing canvas is resized without losing what the guest already drew.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GDIContext } from "../../src/worker/modules/gdi32/context";

const realOffscreen = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
let copies = 0;

class FakeCanvas {
    constructor(public width: number, public height: number) {}
    getContext() { return { drawImage: () => { copies++; } }; }
}

beforeEach(() => {
    copies = 0;
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeCanvas;
});
afterEach(() => { (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = realOffscreen; });

function windowDc(gdi: GDIContext, hdc: number, hwnd: number, w: number, h: number, extra: object = {}) {
    const canvas = new FakeCanvas(w, h);
    const ctx = { canvas, fillStyle: "", strokeStyle: "", textBaseline: "", drawImage: () => { copies++; } };
    gdi.contexts.set(hdc, ctx as never);
    gdi.hdcStates.set(hdc, {
        hwnd, windowBlit: { absX: 0, absY: 0, width: w, height: h }, dirty: false, dirtyRect: null,
        imageDataDirty: true, ...extra,
    } as never);
    return { canvas, ctx };
}

test("a held window DC is resized to the window's new extent", () => {
    const gdi = new GDIContext();
    const { canvas } = windowDc(gdi, 1, 0x10009, 100, 100);
    gdi.retargetWindowDCs(0x10009, 5, 6, 1024, 768);
    expect([canvas.width, canvas.height]).toEqual([1024, 768]);
    expect(gdi.hdcStates.get(1)!.windowBlit).toEqual({ absX: 5, absY: 6, width: 1024, height: 768 });
});

test("drawn content survives a resize only when the DC is dirty", () => {
    const gdi = new GDIContext();
    windowDc(gdi, 1, 7, 100, 100, { dirty: true });
    windowDc(gdi, 2, 7, 100, 100);
    gdi.retargetWindowDCs(7, 0, 0, 200, 200);
    expect(copies).toBe(2);
});

test("a move without a resize leaves the canvas alone", () => {
    const gdi = new GDIContext();
    const { canvas } = windowDc(gdi, 1, 7, 100, 100);
    gdi.retargetWindowDCs(7, 40, 50, 100, 100);
    expect([canvas.width, canvas.height]).toEqual([100, 100]);
    expect(gdi.hdcStates.get(1)!.windowBlit).toEqual({ absX: 40, absY: 50, width: 100, height: 100 });
});

test("other windows' DCs and paint DCs are untouched", () => {
    const gdi = new GDIContext();
    const other = windowDc(gdi, 1, 8, 100, 100);
    const paint = windowDc(gdi, 2, 7, 100, 100, { paintDc: true });
    gdi.retargetWindowDCs(7, 0, 0, 300, 300);
    expect(other.canvas.width).toBe(100);
    expect(paint.canvas.width).toBe(100);
});
