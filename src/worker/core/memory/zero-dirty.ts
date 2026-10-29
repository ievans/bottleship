const PAGE = 4096;
const WORDS_PER_PAGE = PAGE >>> 2;
/** Below this a plain fill is as cheap as the scan and the extent is rarely worth a view. */
const SCAN_THRESHOLD = 64 * 1024;

/**
 * Zero [start, end) writing only the pages that hold a nonzero byte. Guest RAM starts zero and
 * reading a never-written page maps the kernel's shared zero page, whereas a store makes it
 * resident — a blanket fill over a large reserve (a heap, a surface pool) would turn every
 * untouched page into real host memory. The result is byte-identical to `mem.fill(0, start, end)`.
 */
export function zeroDirtyPages(mem: Uint8Array, start: number, end: number): void {
    if (end - start < SCAN_THRESHOLD) { mem.fill(0, start, end); return; }
    const lo = Math.ceil(start / PAGE) * PAGE;
    const hi = Math.floor(end / PAGE) * PAGE;
    if (lo > start) mem.fill(0, start, lo);
    if (end > hi) mem.fill(0, hi, end);
    const words = new Uint32Array(mem.buffer, mem.byteOffset + lo, (hi - lo) >>> 2);
    let runStart = -1;
    for (let p = 0; p < words.length; p += WORDS_PER_PAGE) {
        let dirty = false;
        for (let i = p, stop = p + WORDS_PER_PAGE; i < stop; i++) {
            if (words[i] !== 0) { dirty = true; break; }
        }
        if (dirty) {
            if (runStart < 0) runStart = p;
        } else if (runStart >= 0) {
            mem.fill(0, lo + runStart * 4, lo + p * 4);
            runStart = -1;
        }
    }
    if (runStart >= 0) mem.fill(0, lo + runStart * 4, hi);
}
