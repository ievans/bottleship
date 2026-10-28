import { describe, expect, test } from "bun:test";
import { zeroDirtyPages } from "../../src/worker/core/memory/zero-dirty";

class RecordingMem extends Uint8Array {
    fills: [number, number][] = [];
    fill(value: number, start?: number, end?: number): this {
        this.fills.push([start ?? 0, end ?? this.length]);
        return super.fill(value, start, end);
    }
}
const PAGE = 4096;
const mk = (pages: number) => new RecordingMem(new ArrayBuffer(pages * PAGE), 0, pages * PAGE);

describe("zeroDirtyPages", () => {
    test("leaves a pristine range unwritten", () => {
        const mem = mk(64);
        zeroDirtyPages(mem, 0, mem.length);
        expect(mem.fills).toEqual([]);
    });

    test("zeroes exactly the dirty pages and coalesces runs", () => {
        const mem = mk(64);
        for (const p of [3, 4, 5, 20, 63]) mem[p * PAGE + 17] = 0xaa;
        zeroDirtyPages(mem, 0, mem.length);
        expect(mem.every(b => b === 0)).toBe(true);
        expect(mem.fills).toEqual([[3 * PAGE, 6 * PAGE], [20 * PAGE, 21 * PAGE], [63 * PAGE, 64 * PAGE]]);
    });

    test("an unaligned range is cleared edge to edge and nothing outside it is touched", () => {
        const mem = mk(64);
        mem.fill(0xff);
        mem.fills.length = 0;
        const start = 5 * PAGE + 100, end = 40 * PAGE + 7;
        zeroDirtyPages(mem, start, end);
        for (let i = 0; i < mem.length; i++) expect(mem[i]).toBe(i >= start && i < end ? 0 : 0xff);
    });

    test("a small range is a plain fill", () => {
        const mem = mk(64);
        mem[100] = 1;
        zeroDirtyPages(mem, 50, 200);
        expect(mem[100]).toBe(0);
        expect(mem.fills).toEqual([[50, 200]]);
    });

    test("honours a nonzero byteOffset", () => {
        const buf = new ArrayBuffer(80 * PAGE);
        const mem = new RecordingMem(buf, 8 * PAGE, 64 * PAGE);
        new Uint8Array(buf).fill(0xff);
        mem.fills.length = 0;
        zeroDirtyPages(mem, 0, mem.length);
        const raw = new Uint8Array(buf);
        for (let i = 0; i < raw.length; i++) expect(raw[i]).toBe(i >= 8 * PAGE && i < 72 * PAGE ? 0 : 0xff);
    });

    test("an end past the view is clamped like fill, not thrown", () => {
        const mem = mk(64);
        mem[63 * PAGE + 1] = 1;
        zeroDirtyPages(mem, 0, mem.length + 8 * PAGE);
        expect(mem.every(b => b === 0)).toBe(true);
        zeroDirtyPages(mem, mem.length + PAGE, mem.length + 2 * PAGE);
    });
});
