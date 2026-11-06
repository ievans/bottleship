/**
 * Miles' AIL_decompress_ADPCM path decodes MS ADPCM with the standard coefficient table:
 * each block's header names the predictor, then nibbles correct it high half first.
 */
import { describe, expect, test } from "bun:test";
import { decodeAdpcmToS16 } from "../../src/worker/modules/mss32/audio-decode";

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
});
