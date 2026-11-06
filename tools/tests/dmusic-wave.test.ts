/**
 * Wave segments: a WAVE image decodes to PCM, the performance starts and ends the wave with
 * its segment state, and an audio path mixes the waves sounding on it.
 */
import { describe, expect, test } from "bun:test";
import { decodeWave, WaveMixer } from "../../src/worker/modules/dmusic-wave";
import { DMUS_SEGF_SECONDARY, PerfSegment, Performance } from "../../src/worker/core/audio/directmusic/performance";
import type { DlsSynth } from "../../src/worker/core/audio/directmusic/synth";

function wav(channels: number, rate: number, bits: number, samples: number[]): Uint8Array {
    const bytesPer = bits / 8, data = samples.length * bytesPer;
    const b = new Uint8Array(44 + data), v = new DataView(b.buffer);
    b.set(new TextEncoder().encode("RIFF"), 0); v.setUint32(4, 36 + data, true);
    b.set(new TextEncoder().encode("WAVEfmt "), 8); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * channels * bytesPer, true); v.setUint16(32, channels * bytesPer, true); v.setUint16(34, bits, true);
    b.set(new TextEncoder().encode("data"), 36); v.setUint32(40, data, true);
    samples.forEach((s, i) => (bits === 16 ? v.setInt16(44 + i * 2, s, true) : v.setUint8(44 + i, s)));
    return b;
}

describe("decodeWave", () => {
    test("16-bit PCM keeps its samples; 8-bit PCM is recentred and widened", () => {
        expect(decodeWave(wav(2, 22050, 16, [100, -100, 200, -200]))).toMatchObject({ channels: 2, sampleRate: 22050, frames: 2 });
        expect([...decodeWave(wav(2, 22050, 16, [100, -100, 200, -200]))!.pcm]).toEqual([100, -100, 200, -200]);
        expect([...decodeWave(wav(1, 11025, 8, [128, 255, 0]))!.pcm]).toEqual([0, 127 << 8, -128 << 8]);
    });

    test("MS ADPCM decodes block by block with the predictor its header names", () => {
        // Mono, one 10-byte block: predictor 1 (512, -256: a straight line), delta 16,
        // sample1 30, sample2 20, then nibbles 0 (no correction) and 1 (+delta).
        const block = [1, 16, 0, 30, 0, 20, 0, 0x01, 0x00, 0x00];
        const fmt = 20 + 4 * 7 * 2 / 2; // WAVEFORMATEX + cbSize, samplesPerBlock, numCoef, 7 pairs
        const b = new Uint8Array(12 + 8 + fmt + 8 + block.length), v = new DataView(b.buffer);
        b.set(new TextEncoder().encode("RIFF"), 0); v.setUint32(4, b.length - 8, true);
        b.set(new TextEncoder().encode("WAVEfmt "), 8); v.setUint32(16, fmt, true);
        v.setUint16(20, 2, true); v.setUint16(22, 1, true); v.setUint32(24, 22050, true);
        v.setUint16(32, block.length, true); v.setUint16(34, 4, true);
        v.setUint16(36, 32, true); v.setUint16(38, 8, true); v.setUint16(40, 7, true);
        [256, 0, 512, -256, 0, 0, 192, 64, 240, 0, 460, -208, 392, -232].forEach((c, i) => v.setInt16(42 + i * 2, c, true));
        b.set(new TextEncoder().encode("data"), 20 + fmt); v.setUint32(24 + fmt, block.length, true);
        b.set(block, 28 + fmt);
        const w = decodeWave(b)!;
        // Header samples oldest first, then each nibble high half first: 0, 1, 0, 0, 0, 0.
        expect([...w.pcm]).toEqual([20, 30, 40, 66, 92, 118, 144, 170]);
    });

    test("anything that is not a decodable WAVE is refused", () => {
        expect(decodeWave(new TextEncoder().encode("RIFF\0\0\0\0DMSG"))).toBeNull();
    });
});

describe("WaveMixer", () => {
    test("mixes voices, resamples to the path rate, and drops a voice once it has played out", () => {
        const mixer = new WaveMixer();
        const loud = decodeWave(wav(1, 22050, 16, [1000, 1000, 1000, 1000]))!;
        const half = decodeWave(wav(1, 11025, 16, [500, 500]))!;
        mixer.play("a", loud);
        mixer.play("b", half);
        const out = new Int16Array(12);
        mixer.render(out, 6, 2, 22050);
        // Four frames of both, then silence; the 11025 Hz voice lasts as long at twice the step.
        expect([...out.subarray(0, 8)]).toEqual([1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500]);
        expect([...out.subarray(8)]).toEqual([0, 0, 0, 0]);
        expect(mixer.active).toBe(0);
    });

    test("stop silences one owner's voices only, and a mono path gets the average of both sides", () => {
        const mixer = new WaveMixer();
        mixer.play("a", decodeWave(wav(2, 22050, 16, [400, 0, 400, 0]))!);
        mixer.play("b", decodeWave(wav(1, 22050, 16, [100, 100]))!);
        mixer.stop("b");
        const out = new Int16Array(2);
        mixer.render(out, 2, 1, 22050);
        expect([...out]).toEqual([200, 200]);
    });
});

describe("wave track timing", () => {
    const synth = { sampleRate: 15360, render: () => {}, allNotesOff: () => {} } as unknown as DlsSynth;
    const segment = (length: number): PerfSegment => {
        const s = new PerfSegment();
        s.length = length;
        s.waves.push({ time: 0, sound: "boom" });
        return s;
    };

    test("a wave starts with its state, once, and its end is reported when the segment ends", () => {
        const perf = new Performance(synth);
        const started: unknown[] = [], ended: unknown[] = [];
        perf.onWave = (state, wave) => started.push([state, wave.sound]);
        perf.onStateEnd = (state) => ended.push(state);
        const state = perf.playSegment(segment(768), DMUS_SEGF_SECONDARY);
        const l = new Float32Array(4096), r = new Float32Array(4096);
        perf.render(l, r, 2000);
        expect(started).toEqual([[state, "boom"]]);
        expect(ended).toEqual([]);
        perf.render(l, r, 4096); // 120 bpm at 15360 Hz: 768 ticks is 7680 frames
        perf.render(l, r, 4096);
        expect(started.length).toBe(1);
        expect(ended).toEqual([state]);
    });

    test("stopping a state reports its end at once", () => {
        const perf = new Performance(synth);
        const ended: unknown[] = [];
        perf.onStateEnd = (state) => ended.push(state);
        const state = perf.playSegment(segment(100_000), DMUS_SEGF_SECONDARY);
        perf.render(new Float32Array(64), new Float32Array(64), 64);
        perf.stop(null, state, 0);
        expect(ended).toEqual([state]);
    });
});
