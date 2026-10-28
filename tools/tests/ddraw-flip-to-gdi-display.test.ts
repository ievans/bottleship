/**
 * Who owns the display after FlipToGDISurface: with a flip chain on screen the GDI surface
 * takes the display back until the app presents again, so GDI window output (a lobby, a
 * modal) is what the screen shows. A single-buffered primary never flips away, so it never
 * enters this state.
 */

import { describe, expect, test } from "bun:test";
import { gdiSurfaceOnDisplay, noteFlipToGdiSurface, settleFlipToGdiSurface } from "../../src/worker/modules/ddraw/gdi-visibility";
import type { DDrawContext } from "../../src/worker/modules/ddraw/context";

const EXCLUSIVE_FULLSCREEN = 0x11;

function ctx(over: Partial<{ gdiSurfaceVisible: boolean; flags: number; frames: number }> = {}) {
    const state = { frames: over.frames ?? 10 };
    const c = {
        cooperative: { hwnd: 1, flags: over.flags ?? EXCLUSIVE_FULLSCREEN },
        gdiSurfaceVisible: over.gdiSurfaceVisible ?? false,
        presenter: { presentRequestCount: () => state.frames },
    } as unknown as DDrawContext;
    return { c, state };
}

describe("FlipToGDISurface display ownership", () => {
    test("flip chain on screen -> GDI surface owns the display until the next present", () => {
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

    test("the present FlipToGDISurface itself issues is the display, not new content", () => {
        const { c, state } = ctx();
        noteFlipToGdiSurface(c);
        state.frames++;
        settleFlipToGdiSurface(c);
        expect(gdiSurfaceOnDisplay(c)).toBe(true);
        state.frames++;
        expect(gdiSurfaceOnDisplay(c)).toBe(false);
    });

    test("settling does not revive a display a Flip already took back", () => {
        const { c, state } = ctx();
        noteFlipToGdiSurface(c);
        c.gdiSurfaceVisible = false;
        c.gdiFlippedAtPresent = undefined;
        state.frames++;
        settleFlipToGdiSurface(c);
        expect(gdiSurfaceOnDisplay(c)).toBe(false);
    });
});
