/**
 * Worker-side singleton for the AudioWorklet signal-stats SABs.
 *
 * Any audio-producing module (dsound, winmm waveOut, mss32, openal) calls
 * ensureAudioStatsSab() once; the first call allocates BOTH stats SABs and posts
 * them to the main thread (App.tsx → AudioEngine → worklet "register_stats" /
 * "register_master_stats"), parking references on globalThis.__audioStatsSab
 * (ring stage, pre-mix) and globalThis.__audioMasterStatsSab (master stage,
 * post-mix — what the user actually hears) so dbg.audio() / harness audioSignal
 * can read the counters without an import cycle. One call provisions both: a
 * caller that only cares about the ring never has to remember the master SAB
 * exists, so the two counter sets can't silently drift out of being registered
 * together.
 */

import { createStatsSab, createMasterStatsSab, createCaptureSab } from "../../audio/audio-ring-buffer";

let statsSab: SharedArrayBuffer | null = null;
let masterStatsSab: SharedArrayBuffer | null = null;
let captureSab: SharedArrayBuffer | null = null;

export function ensureAudioStatsSab(): SharedArrayBuffer {
    if (!statsSab) {
        statsSab = createStatsSab();
        (globalThis as any).__audioStatsSab = statsSab;
        self.postMessage({ type: "audio_stats_sab", payload: { sab: statsSab } });
    }
    if (!masterStatsSab) {
        masterStatsSab = createMasterStatsSab();
        (globalThis as any).__audioMasterStatsSab = masterStatsSab;
        self.postMessage({ type: "audio_master_stats_sab", payload: { sab: masterStatsSab } });
    }
    return statsSab;
}

/** Provisions the master-stage raw-PCM capture SAB (see audio.ts's audioCapture
 *  harness verb) and parks it on globalThis the same way the stats SABs are.
 *
 *  Unlike ensureAudioStatsSab, registration is re-posted on EVERY call rather
 *  than gated behind "already created": the stats SABs are wired up early and
 *  from many call sites, so re-posting would be pure waste, but this one is
 *  only ever touched from the one-off audioCapture verb, and a bundle
 *  load/reload between calls replaces the main-thread AudioEngine (and its
 *  worklet nodes) without this worker module noticing — the old registration
 *  then points at a torn-down node and the new one never hears about the SAB
 *  at all, since the guard that skipped "already created" also skipped
 *  "already posted". Re-posting is one SharedArrayBuffer reference (never
 *  copied), so doing it every call is free next to the cost of silently
 *  talking to a dead node. */
export function ensureAudioCaptureSab(): SharedArrayBuffer {
    if (!captureSab) {
        captureSab = createCaptureSab();
        (globalThis as any).__audioCaptureSab = captureSab;
    }
    self.postMessage({ type: "audio_capture_sab", payload: { sab: captureSab } });
    return captureSab;
}
