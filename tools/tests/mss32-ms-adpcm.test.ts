/**
 * Miles' AIL_decompress_ADPCM path decodes MS ADPCM with the standard coefficient table:
 * each block's header names the predictor, then nibbles correct it high half first.
 */
import { describe, expect, test } from "bun:test";
import { buildPcmWavImage } from "@bottleship/formats/audio";
import { decodeAdpcmToS16, parseWav, convertToFloat, readAilSoundInfo } from "../../src/worker/modules/mss32/audio-decode";
import type { MSSContext } from "../../src/worker/modules/mss32/context";
import { createWavInfoExports } from "../../src/worker/modules/mss32/wav-info";

/** Wrap a raw MS ADPCM block in the RIFF/WAVE/fmt/data container parseWav expects. */
function wrapAdpcmWav(block: Uint8Array, channels: number, formatTag = 2): Uint8Array {
    const blockAlign = block.length;
    const fmt = new Uint8Array(16);
    const fv = new DataView(fmt.buffer);
    fv.setUint16(0, formatTag, true);
    fv.setUint16(2, channels, true);
    fv.setUint32(4, 22050, true);      // sampleRate
    fv.setUint32(8, 22050, true);      // byteRate (not exact; unchecked by the decode path)
    fv.setUint16(12, blockAlign, true);
    fv.setUint16(14, 4, true);         // bitsPerSample

    const bytes: number[] = [];
    const push = (s: string) => { for (const c of s) bytes.push(c.charCodeAt(0)); };
    push("RIFF"); bytes.push(0, 0, 0, 0); push("WAVE");
    push("fmt "); bytes.push(16, 0, 0, 0); bytes.push(...fmt);
    push("data"); bytes.push(block.length, 0, 0, 0); bytes.push(...block);
    const out = new Uint8Array(bytes);
    // Backfill the RIFF chunk size (everything after the first 8 bytes).
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    return out;
}

describe("MS ADPCM (mss32)", () => {
    test("one mono block: header samples oldest first, then predicted samples", () => {
        // Predictor 1 (512, -256: a straight line), delta 16, sample1 30, sample2 20;
        // nibbles 0, 1, 0, 0, 0, 0.
        const block = new Uint8Array([1, 16, 0, 30, 0, 20, 0, 0x01, 0x00, 0x00]);
        expect([...decodeAdpcmToS16(block, 2, 1, block.length)]).toEqual([20, 30, 40, 66, 92, 118, 144, 170]);
    });

    test("stereo blocks interleave left and right, the high nibble left", () => {
        // Both channels predictor 0 (256, 0: hold), delta 16; L 100/50, R -100/-50; nibble L+1, R-1.
        const block = new Uint8Array([0, 0, 16, 0, 16, 0, 100, 0, 0x9c, 0xff, 50, 0, 0xce, 0xff, 0x1f]);
        expect([...decodeAdpcmToS16(block, 2, 2, block.length)]).toEqual([50, -50, 100, -100, 116, -116]);
    });

    test("a RIFF/WAVE container carrying format tag 2 decodes through the sample-playback path", () => {
        // parseWav used to reject format tag 2 outright, and convertToFloat had no branch for
        // it either (every bit-depth fast path there skips bitsPerSample===4), so a real MS
        // ADPCM sample fell through to raw silence rather than a decode error. This exercises
        // the actual playback entry points (parseWav -> convertToFloat), not decodeAdpcmToS16
        // directly, since that part already worked and was already covered above.
        const block = new Uint8Array([1, 16, 0, 30, 0, 20, 0, 0x01, 0x00, 0x00]);
        const wav = wrapAdpcmWav(block, 1);

        const parsed = parseWav(wav);
        expect(parsed).not.toBeNull();
        expect(parsed!.formatTag).toBe(2);

        const floats = convertToFloat(parsed!.data, parsed!.channels, parsed!.bitsPerSample, parsed!.formatTag, parsed!.blockAlign);
        const expectedS16 = [...decodeAdpcmToS16(block, 2, 1, block.length)];
        expect([...floats].map((f) => Math.round(f * 32768))).toEqual(expectedS16);
    });
});

describe("Miles WAV inspection", () => {
    test.each([
        { tag: 1, wav: buildPcmWavImage(new Uint8Array(16), 2, 22050), channels: 2, samples: 4 },
        { tag: 17, wav: wrapAdpcmWav(new Uint8Array(8), 1, 17), channels: 1, samples: 9 },
        { tag: 2, wav: wrapAdpcmWav(new Uint8Array(8), 1), channels: 1, samples: 4 },
        { tag: 2, wav: wrapAdpcmWav(new Uint8Array(16), 2), channels: 2, samples: 4 },
    ])("returns WAV format tag $tag in AILSOUNDINFO", ({ tag, wav, channels, samples }) => {
        const mem = new Uint8Array(0x4000);
        const wavPtr = 0x1000, infoPtr = 0x2000, outputPtr = 0x3000;
        mem.set(wav, wavPtr);
        const ctx = {
            process: { memory: { alloc: () => outputPtr } },
            memAllocatedByMss: new Set(),
            wavFormatByDataPtr: new Map(),
        } as unknown as MSSContext;
        const exports = createWavInfoExports(ctx);
        expect(exports.AIL_WAV_info!({} as never, mem, [wavPtr, infoPtr])).toBe(1);
        expect(readAilSoundInfo(mem, infoPtr)).toMatchObject({ format: tag, channels, samples });
        const decoded = exports.AIL_decompress_ADPCM!({} as never, mem, [infoPtr, infoPtr + 40, infoPtr + 44]);
        if (tag === 1) {
            expect(decoded).toBe(0);
        } else {
            expect(decoded).toBe(1);
            const view = new DataView(mem.buffer);
            expect(view.getUint32(infoPtr + 40, true)).toBe(outputPtr);
            const outputBytes = view.getUint32(infoPtr + 44, true);
            expect(parseWav(mem.subarray(outputPtr, outputPtr + outputBytes))?.formatTag).toBe(1);
        }
    });
});
