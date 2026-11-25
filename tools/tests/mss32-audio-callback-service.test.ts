/**
 * invokeEOSCallback() only ever QUEUES a finished sample's EOS callback; nothing calls
 * cm.invokeCallback() directly outside of an actual thunk dispatch (that corrupted the
 * guest — see callbacks.ts). serviceAudioCallbacks() is the one place that actually
 * delivers a queued EOS/stream/timer callback, by driving it through runGuestCallChain
 * the same way serveIncrementalStreams() drives app file callbacks: it parks the CALLING
 * export's own thunk and resumes it with that export's own answer once the callback
 * returns.
 *
 * Only one guest call chain can be parked on a thunk at a time, so serviceAudioCallbacks
 * must decline (return null, letting serveIncrementalStreams get the export's one service
 * slot instead) whenever an audio-callback chain it already started is still in flight.
 */
import { describe, expect, test } from "bun:test";
import { serviceAudioCallbacks, audioCallbackChainRunning, invokeEOSCallback } from "../../src/worker/modules/mss32/callbacks";
import type { MSSContext } from "../../src/worker/modules/mss32/context";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createSampleExports } from "../../src/worker/modules/mss32/sample";
import { mss32Module } from "../../src/worker/api/mss32.api";

const SAMPLE = 0x900;
const EOS_CALLBACK = 0x410f90;

function context(memory: Uint8Array, callbackManager: unknown): MSSContext {
    return {
        process: { dispatcher: { callbackManager }, getCurrentMemory: () => memory },
        samples: new Map(),
        pendingEOSCallbacks: [],
        pendingStreamCallbacks: [],
        pendingTimerCallbacks: [],
    } as unknown as MSSContext;
}

/** A callback manager that parks the chain and never resolves it — the chain stays
 *  "in flight" until the test completes it, so the exclusivity guard can be observed. */
function stuckCallbackManager() {
    let nextCallbackId = 1;
    return {
        saveSuspendedThunkContext: () => 777,
        invokeCallback: () => ({ callbackId: nextCallbackId++ }),
        getPendingCallback: () => ({}),
    };
}

describe("serviceAudioCallbacks (mss32)", () => {
    test("a positional sample registers and clears its end callback through the Miles API", () => {
        const name = "_AIL_register_3D_EOS_callback@8";
        expect(mss32Module.functions.find(fn => fn.name === name)?.params).toHaveLength(2);
        const memory = new Uint8Array(0x2000);
        Mem.bind(() => memory);
        const ctx = context(memory, stuckCallbackManager());
        const sample = { id: 1, handle: SAMPLE, is3D: true } as never;
        ctx.samples.set(SAMPLE, sample);
        const register = createSampleExports(ctx)[name]!;

        expect(register({} as never, memory, [SAMPLE, EOS_CALLBACK])).toBe(0);
        invokeEOSCallback(ctx, sample);
        expect(ctx.pendingEOSCallbacks.splice(0)).toEqual([{ callback: EOS_CALLBACK, handle: SAMPLE }]);

        expect(register({} as never, memory, [SAMPLE, 0])).toBe(EOS_CALLBACK);
        invokeEOSCallback(ctx, sample);
        expect(ctx.pendingEOSCallbacks).toHaveLength(0);
    });

    test("declines when nothing is queued", () => {
        const memory = new Uint8Array(0x2000);
        Mem.bind(() => memory);
        const ctx = context(memory, stuckCallbackManager());
        expect(serviceAudioCallbacks(ctx, {}, 0, "mss32:test", 0)).toBeNull();
    });

    test("parks the thunk for a queued EOS callback, then declines again while that chain is in flight", () => {
        const memory = new Uint8Array(0x2000);
        Mem.bind(() => memory);
        const ctx = context(memory, stuckCallbackManager());

        // Mirror invokeEOSCallback's own queue entry shape rather than pushing one by
        // hand, so this breaks if that shape ever changes.
        const sample = { id: 1, handle: SAMPLE } as never;
        const view = new DataView(memory.buffer);
        view.setUint32(SAMPLE + 0x4C, EOS_CALLBACK, true);
        invokeEOSCallback(ctx, sample);
        expect(ctx.pendingEOSCallbacks).toHaveLength(1);

        expect(audioCallbackChainRunning()).toBe(false);
        const first = serviceAudioCallbacks(ctx, {}, 0, "mss32:test", 42);
        expect(first).not.toBeNull();
        expect(typeof first).toBe("object");
        // The callback was dequeued immediately (delivery is pending, not dropped).
        expect(ctx.pendingEOSCallbacks).toHaveLength(0);
        // serviceAudioCallbacks's own chain is now parked waiting on that callback to
        // return — this is the state a same-tick serveIncrementalStreams call must see
        // and yield to, since only one thunk can be parked per export call.
        expect(audioCallbackChainRunning()).toBe(true);

        // A second queued callback must not start a second chain while the first is
        // still unresolved — that would be two parked thunks for one export call.
        view.setUint32(SAMPLE + 0x4C, EOS_CALLBACK, true);
        invokeEOSCallback(ctx, sample);
        expect(ctx.pendingEOSCallbacks).toHaveLength(1);
        expect(serviceAudioCallbacks(ctx, {}, 0, "mss32:test", 0)).toBeNull();
        // Declining must not have consumed the still-queued callback either.
        expect(ctx.pendingEOSCallbacks).toHaveLength(1);
    });
});
