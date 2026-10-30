/**
 * GetCharWidth{A,W,32A,32W} share one implementation and must reject a reversed or oversized
 * range instead of walking guest memory.
 */
import { afterEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { GDIContext } from "../../src/worker/modules/gdi32/context";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";

type Thunk = (c: unknown, m: Uint8Array, a: number[]) => number;

const savedInstance = (System as unknown as { instance: unknown }).instance;
afterEach(() => { (System as unknown as { instance: unknown }).instance = savedInstance; });

function setup() {
    const mem = new Uint8Array(0x1000);
    (System as unknown as { instance: unknown }).instance = { gdiContext: new GDIContext(), process: { getCurrentMemory: () => mem } };
    return { mem, exports: createPaintingExports() as Record<string, Thunk> };
}

test("every spelling is exported and writes one positive width per character", () => {
    const { mem, exports } = setup();
    const dv = new DataView(mem.buffer);
    for (const name of ["GetCharWidthA", "GetCharWidthW", "GetCharWidth32A", "GetCharWidth32W"]) {
        mem.fill(0);
        expect(exports[name]!({}, mem, [0, 0x41, 0x43, 0x100])).toBe(1);
        for (let i = 0; i < 3; i++) expect(dv.getInt32(0x100 + i * 4, true)).toBeGreaterThan(0);
        expect(dv.getInt32(0x100 + 12, true)).toBe(0);
    }
});

test("a reversed range, a null buffer and an oversized range fail", () => {
    const { mem, exports } = setup();
    const f = exports["GetCharWidth32W"]!;
    expect(f({}, mem, [0, 0x43, 0x41, 0x100])).toBe(0);
    expect(f({}, mem, [0, 0x41, 0x43, 0])).toBe(0);
    expect(f({}, mem, [0, 0, 0x10000, 0x100])).toBe(0);
});
