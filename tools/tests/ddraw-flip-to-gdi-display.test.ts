/**
 * Who owns the display after FlipToGDISurface: with a flip chain on screen the GDI surface
 * takes the display back until the app puts pixels on the primary again, so GDI window output
 * (a lobby, a modal) is what the screen shows. A single-buffered primary never flips away, so
 * it never enters this state.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { gdiSurfaceOnDisplay, noteFlipToGdiSurface } from "../../src/worker/modules/ddraw/gdi-visibility";
import { DDrawPresenter } from "../../src/worker/modules/ddraw/presenter";
import { getOverlayCompositePlan } from "../../src/worker/modules/user32/dialog-overlay";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { System } from "../../src/worker/core/system";
import type { DDrawContext } from "../../src/worker/modules/ddraw/context";

const EXCLUSIVE_FULLSCREEN = 0x11;

function ctx(over: Partial<{ gdiSurfaceVisible: boolean; flags: number; frames: number; hwnd: number }> = {}) {
    const state = { frames: over.frames ?? 10 };
    const c = {
        cooperative: { hwnd: over.hwnd ?? 1, flags: over.flags ?? EXCLUSIVE_FULLSCREEN },
        gdiSurfaceVisible: over.gdiSurfaceVisible ?? false,
        presenter: { contentPresentCount: () => state.frames },
    } as unknown as DDrawContext;
    return { c, state };
}

describe("FlipToGDISurface display ownership", () => {
    test("flip chain on screen -> GDI surface owns the display until content is presented", () => {
        const { c, state } = ctx();
        expect(gdiSurfaceOnDisplay(c)).toBe(false);
        noteFlipToGdiSurface(c);
        expect(c.gdiSurfaceVisible).toBe(true);
        expect(gdiSurfaceOnDisplay(c)).toBe(true);
        state.frames++;
        expect(gdiSurfaceOnDisplay(c)).toBe(false);
    });

    test("a single-buffered primary (never flipped away) is unaffected", () => {
        const { c } = ctx({ gdiSurfaceVisible: true });
        noteFlipToGdiSurface(c);
        expect(gdiSurfaceOnDisplay(c)).toBe(false);
    });

    test("not exclusive fullscreen: never a GDI-owned display", () => {
        const { c } = ctx({ flags: 0x8 });
        noteFlipToGdiSurface(c);
        expect(gdiSurfaceOnDisplay(c)).toBe(false);
    });

    test("a Flip hides the GDI surface again", () => {
        const { c } = ctx();
        noteFlipToGdiSurface(c);
        c.gdiSurfaceVisible = false;
        c.gdiFlippedAtPresent = undefined;
        expect(gdiSurfaceOnDisplay(c)).toBe(false);
    });

    test("a FlipToGDISurface that fails to present still leaves the GDI surface on display", () => {
        const { c } = ctx();
        noteFlipToGdiSurface(c);
        // The failed present never reaches the presenter, so no content was presented.
        expect(gdiSurfaceOnDisplay(c)).toBe(true);
    });
});

describe("presenter content-present count", () => {
    function presenter() {
        // pumpRunning keeps the draw loop from starting; only the request bookkeeping runs.
        return Object.assign(Object.create(DDrawPresenter.prototype), {
            presentCallCount: 0, contentPresents: 0, pendingResolvers: [], pendingSurface: null, pumpRunning: true,
        }) as DDrawPresenter;
    }

    test("displayOnly requests (palette, FlipToGDISurface) are not content", () => {
        const p = presenter();
        void p.present({} as any, new Uint8Array(0), { displayOnly: true });
        void p.present({} as any, new Uint8Array(0), { throttle: true, displayOnly: true });
        expect(p.contentPresentCount()).toBe(0);
    });

    test("a Blt/Unlock/Flip present counts, even when a later request supersedes it", () => {
        const p = presenter();
        void p.present({} as any, new Uint8Array(0));
        void p.present({} as any, new Uint8Array(0), { displayOnly: true });
        expect(p.contentPresentCount()).toBe(1);
    });
});

describe("overlay plan while GDI owns the display", () => {
    const system = System.getInstance();
    const savedProcess = system.process;
    const added: number[] = [];

    function win(handle: number, x: number, y: number, w: number, h: number, extra: Partial<WindowInfo> = {}) {
        windows.set(handle, {
            handle, title: "", style: 0, x, y, width: w, height: h, children: [], visible: true, wndProc: 0, ...extra,
        } as WindowInfo);
        added.push(handle);
    }
    function install(c: DDrawContext) {
        (system as any).process = { getModule: (n: string) => (n === "ddraw" ? { context: c } : undefined) };
    }
    afterEach(() => {
        for (const h of added.splice(0)) windows.delete(h);
        (system as any).process = savedProcess;
    });

    test("composites the screen-owner window, never the whole overlay", () => {
        const { c } = ctx({ hwnd: 7001 });
        win(7001, 0, 0, 640, 480);
        win(7002, 100, 100, 300, 200); // a window left over from before the game took the screen
        noteFlipToGdiSurface(c);
        install(c);
        const plan = getOverlayCompositePlan();
        expect(plan).toEqual({ mode: "rects", rects: [{ x: 0, y: 0, w: 640, h: 480 }], gdiOwnsDisplay: true });
    });

    test("a hidden owner window contributes nothing", () => {
        const { c } = ctx({ hwnd: 7003 });
        win(7003, 0, 0, 640, 480, { visible: false });
        noteFlipToGdiSurface(c);
        install(c);
        expect(getOverlayCompositePlan()).toEqual({ mode: "none" });
    });

    test("a content present ends the GDI-owned plan", () => {
        const { c, state } = ctx({ hwnd: 7004 });
        win(7004, 0, 0, 640, 480);
        noteFlipToGdiSurface(c);
        install(c);
        state.frames++;
        expect((getOverlayCompositePlan() as { gdiOwnsDisplay?: true }).gdiOwnsDisplay).toBeUndefined();
    });
});
