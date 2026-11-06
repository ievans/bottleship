/**
 * Wave segments: a RIFF WAVE file loaded as a DirectMusic segment, and the mix of the
 * waves sounding on one audio path. The path's DirectSound buffer carries that mix, so
 * the volume, pan and 3D position the application sets on the buffer apply to it.
 */
import { decodeImaAdpcmBlock, decodeMsAdpcmBlock, MS_STANDARD_COEFS } from "./msacm32";

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_ADPCM = 2;
const WAVE_FORMAT_IMA_ADPCM = 17;

/** Decoded 16-bit PCM, interleaved. */
export interface WaveSound {
    channels: number;
    sampleRate: number;
    pcm: Int16Array;
    frames: number;
}

interface WaveFormat {
    tag: number; channels: number; rate: number; blockAlign: number; bits: number;
    /** From the ADPCM extension, 0 when absent. */
    samplesPerBlock: number;
    /** MS ADPCM coefficient pairs, from the extension when it carries them. */
    coefs: Int16Array;
}

/** The fmt chunk (with its ADPCM extension) and the data chunk of a RIFF WAVE image. */
function waveChunks(b: Uint8Array): { format: WaveFormat; data: Uint8Array } | null {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let format: WaveFormat | null = null;
    for (let at = 12; at + 8 <= b.length;) {
        const id = String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
        const size = v.getUint32(at + 4, true), body = at + 8;
        const end = Math.min(b.length, body + size);
        if (id === "fmt " && size >= 16) {
            format = {
                tag: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true),
                blockAlign: v.getUint16(body + 12, true), bits: v.getUint16(body + 14, true), samplesPerBlock: 0, coefs: MS_STANDARD_COEFS,
            };
            if (size >= 20) format.samplesPerBlock = v.getUint16(body + 18, true);
            if (format.tag === WAVE_FORMAT_ADPCM && size >= 22) {
                const count = v.getUint16(body + 20, true);
                if (count > 0 && body + 22 + count * 4 <= end) {
                    format.coefs = new Int16Array(count * 2);
                    for (let i = 0; i < count * 2; i++) format.coefs[i] = v.getInt16(body + 22 + i * 2, true);
                }
            }
        } else if (id === "data" && format) {
            return { format, data: b.subarray(body, end) };
        }
        at = body + size + (size & 1);
    }
    return null;
}

/** Decode block after block; a malformed block ends the sound there. */
function decodeAdpcm(f: WaveFormat, data: Uint8Array): Int16Array {
    const perBlock = f.samplesPerBlock > 0 ? f.samplesPerBlock
        : f.tag === WAVE_FORMAT_ADPCM ? Math.floor(((f.blockAlign - 7 * f.channels) * 2) / f.channels) + 2
        : Math.floor(((f.blockAlign - 4 * f.channels) * 2) / f.channels) + 1;
    const blocks = Math.ceil(data.length / f.blockAlign);
    const out = new Int16Array(blocks * perBlock * f.channels);
    let frames = 0;
    for (let at = 0; at < data.length; at += f.blockAlign) {
        const size = Math.min(f.blockAlign, data.length - at);
        const got = f.tag === WAVE_FORMAT_ADPCM
            ? decodeMsAdpcmBlock(data, at, size, f.channels, f.coefs, perBlock, out, frames * f.channels)
            : decodeImaAdpcmBlock(data, at, size, f.channels, perBlock, out, frames * f.channels);
        if (got <= 0) break;
        frames += got;
    }
    return out.subarray(0, frames * f.channels);
}

/** A WAVE image as 16-bit PCM: PCM (8- or 16-bit), MS ADPCM or IMA ADPCM, mono or stereo. */
export function decodeWave(bytes: Uint8Array): WaveSound | null {
    const chunks = waveChunks(bytes);
    if (!chunks) return null;
    const { format: f, data } = chunks;
    if (f.rate <= 0 || f.channels < 1 || f.channels > 2) return null;
    let pcm: Int16Array;
    if (f.tag === WAVE_FORMAT_PCM && f.bits === 16) {
        pcm = new Int16Array(data.length >> 1);
        new Uint8Array(pcm.buffer).set(data.subarray(0, pcm.length * 2));
    } else if (f.tag === WAVE_FORMAT_PCM && f.bits === 8) {
        pcm = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) pcm[i] = (data[i]! - 128) << 8;
    } else if ((f.tag === WAVE_FORMAT_ADPCM || f.tag === WAVE_FORMAT_IMA_ADPCM) && f.blockAlign > 0) {
        pcm = decodeAdpcm(f, data);
    } else {
        return null;
    }
    return { channels: f.channels, sampleRate: f.rate, pcm, frames: Math.floor(pcm.length / f.channels) };
}

interface Voice {
    owner: unknown;
    sound: WaveSound;
    /** Position in source frames. */
    pos: number;
}

/** The waves sounding on one audio path, mixed at the path buffer's rate. */
export class WaveMixer {
    private voices: Voice[] = [];
    /** Linear gain the mix is heading to (the path's volume), and where the last render left it. */
    private target = 1;
    private gain = 1;
    private left = new Float32Array(0);
    private right = new Float32Array(0);

    get active(): number { return this.voices.length; }

    /** The path's volume in hundredths of a decibel (0 is full, -9600 silent), as SetVolume gives it. */
    setVolume(hundredthsDb: number): void {
        const db = Math.max(-9600, Math.min(0, hundredthsDb | 0)) / 100;
        this.target = db <= -96 ? 0 : Math.pow(10, db / 20);
    }

    /** Start `sound` from its beginning; `owner` is what stop() names it by. */
    play(owner: unknown, sound: WaveSound): void {
        if (sound.frames > 0) this.voices.push({ owner, sound, pos: 0 });
    }

    stop(owner: unknown): void {
        this.voices = this.voices.filter((v) => v.owner !== owner);
    }

    clear(): void {
        this.voices = [];
    }

    /** Mix `frames` frames at `rate` into `pcm` (interleaved, `channels` 1 or 2), replacing it. */
    render(pcm: Int16Array, frames: number, channels: number, rate: number): void {
        if (this.left.length < frames) {
            this.left = new Float32Array(frames);
            this.right = new Float32Array(frames);
        }
        const left = this.left, right = this.right;
        left.fill(0, 0, frames);
        right.fill(0, 0, frames);
        for (const v of this.voices) {
            const { pcm: src, channels: ch, frames: length } = v.sound;
            const step = v.sound.sampleRate / rate;
            let pos = v.pos;
            for (let i = 0; i < frames && pos < length; i++, pos += step) {
                // Linear interpolation between the two source frames around `pos`.
                const at = Math.floor(pos), frac = pos - at, next = Math.min(at + 1, length - 1);
                const l = src[at * ch]! + (src[next * ch]! - src[at * ch]!) * frac;
                const r = ch === 2 ? src[at * 2 + 1]! + (src[next * 2 + 1]! - src[at * 2 + 1]!) * frac : l;
                left[i]! += l;
                right[i]! += r;
            }
            v.pos = pos;
        }
        this.voices = this.voices.filter((v) => v.pos < v.sound.frames);
        // Ramp to a new volume across this render instead of stepping, which would click.
        const from = this.gain, to = this.target;
        for (let i = 0; i < frames; i++) {
            const g = from === to ? to : from + ((to - from) * (i + 1)) / frames;
            left[i]! *= g;
            right[i]! *= g;
        }
        this.gain = to;
        const clamp = (x: number): number => (x > 32767 ? 32767 : x < -32768 ? -32768 : Math.round(x));
        if (channels === 1) {
            for (let i = 0; i < frames; i++) pcm[i] = clamp((left[i]! + right[i]!) / 2);
        } else {
            for (let i = 0; i < frames; i++) {
                pcm[i * 2] = clamp(left[i]!);
                pcm[i * 2 + 1] = clamp(right[i]!);
            }
        }
    }
}
