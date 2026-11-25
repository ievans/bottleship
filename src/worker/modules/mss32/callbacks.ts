import { Logger, LogCategory } from "../../core/logger";
import { ThunkResult } from "../../core/thunking/thunk-dispatcher";
import { MSSContext } from "./context";
import { MSSSample } from "./types";
import { getMemory, makeView } from "./helpers";
import { runGuestCallChain, type GuestCall, type GuestCallChain } from "./app-file-io";
import { refillChainRunning } from "./stream-engine";

/**
 * Invoke EOS_callback (0x4C): one arg, HSAMPLE (mss.h: `AIL_sample_callback` is
 * `void(__stdcall*)(HSAMPLE)`). A callback that wants its own context reads it back via
 * AIL_sample_user_data(sample, index) — it is never passed as a second argument here. The
 * guest's EOS handler is what clears the native engine's per-object voice-exclusivity
 * bookkeeping (MilesAudioManager::setSampleCompleted -> notifyOfAudioCompletion); pushing an
 * extra DWORD this __stdcall callback never pops corrupts its caller's stack on return, which
 * is why a unit's selection voice would play once and then never again for the rest of a match.
 *
 * Always QUEUES rather than invoking cm.invokeCallback() inline. This function runs from
 * updateEmulatorState(), which is itself called mid-iteration from deep inside _AIL_serve@0's
 * handler (ctx.insideAilServe is true there) as well as from the independent timer-driven
 * heartbeatTick (insideAilServe false). A thunk handler can only hand a callback off to the
 * CPU by returning {suspendedForCallback:true} as ITS OWN result — that's what lets the
 * dispatcher actually arm the jump. _AIL_serve@0's handler does this correctly, but only for
 * callbacks drained by its OWN processPendingEOSCallbacks() call, whose return value becomes
 * the thunk's result. A cm.invokeCallback() called here, nested inside updateEmulatorState's
 * sample loop, has no way to propagate that signal back up — the handler keeps running after
 * we return and its own eventual `return 0` discards whatever invokeCallback just armed, so the
 * guest's EOS handler never actually runs. Queuing unconditionally means every EOS callback is
 * delivered exactly once, through the one call site that resumes correctly.
 */
export function invokeEOSCallback(ctx: MSSContext, sample: MSSSample): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    const eos = view.getUint32(sample.handle + 0x4C, true);
    // 0 = no callback, 0xFFFFFFFF = sentinel "none" (real MSS32 init value)
    if (!eos || eos === 0xFFFFFFFF) return;

    ctx.pendingEOSCallbacks.push({ callback: eos, handle: sample.handle });
    Logger.verbose(LogCategory.SYSTEM,
        `MSS32: Queued EOS_callback for sample 0x${sample.handle.toString(16)} (queue size: ${ctx.pendingEOSCallbacks.length})`);
}

/** One guest call chain for audio callbacks at a time, same discipline as stream refills
 *  (stream-engine.ts's refillChainInFlight) — only one thunk can be parked per export call. */
// @refuse(an audio-callback chain is already parked on some export's thunk)
let audioCallbackChainInFlight = false;

export function audioCallbackChainRunning(): boolean {
    return audioCallbackChainInFlight;
}

/**
 * Deliver exactly one queued EOS/stream/timer callback as REAL guest execution, via the
 * same runGuestCallChain machinery serveIncrementalStreams uses for the app's file
 * callbacks: it parks the CALLING export's own thunk (saveSuspendedThunkContext) and
 * resumes it with `answer` — that export's own real return value — once the callback
 * returns. This is the only safe way to inject a callback from code that is not itself
 * `_AIL_serve@0`'s handler.
 *
 * `_AIL_serve@0` can get away with returning {suspendedForCallback:true} as its OWN thunk
 * result because its real answer is always a fixed 0 — nothing is lost by parking it. Any
 * other export (_AIL_set_3D_position@16, say) has a real answer the guest is waiting on;
 * returning that same shape AS ITS result would park the thunk and never deliver it. Worse,
 * calling cm.invokeCallback() directly from a non-thunk context (e.g. the heartbeat timer)
 * is not safe at all — confirmed by crashing the guest (EIP corrupted to ~0, "Scheduler
 * fatal guard") the first time this was tried that way. Nothing in the dispatcher's normal
 * instruction stepping expects a mid-flight CPU-state jump that didn't originate from a
 * thunk's own suspended-for-callback return.
 *
 * Why this exists at all: _AIL_serve@0 is the only place that previously drained these
 * queues, but this title never calls it while actually in a mission (confirmed live — zero
 * hits over a multi-second in-game window; it does fire during the frontend/menu). Every
 * mss32 export this gets wired into (installStreamServicePoints in index.ts) fires
 * constantly during real gameplay instead, so every entry is where this work lands —
 * same reasoning as the stream service points already use.
 */
export function serviceAudioCallbacks(
    ctx: MSSContext,
    thunkCtx: unknown,
    stackCleanup: number,
    source: string,
    answer = 0,
): ThunkResult | null {
    if (audioCallbackChainInFlight || refillChainRunning()) return null;

    const eos = ctx.pendingEOSCallbacks.shift();
    const stream = !eos ? ctx.pendingStreamCallbacks.shift() : undefined;
    const timer = !eos && !stream ? ctx.pendingTimerCallbacks.shift() : undefined;

    let call: GuestCall | null = null;
    if (eos) {
        call = { fn: eos.callback, args: [eos.handle], label: `EOS:0x${eos.handle.toString(16)}` };
    } else if (stream) {
        call = { fn: stream.callback, args: [stream.handle], label: `StreamCB:0x${stream.handle.toString(16)}` };
    } else if (timer) {
        call = { fn: timer.callback, args: [timer.user], label: `TimerCB` };
    }
    if (!call) return null;

    audioCallbackChainInFlight = true;
    const result = runGuestCallChain(ctx, thunkCtx, stackCleanup, source, (function* (): GuestCallChain {
        try {
            yield call!;
            return answer;
        } finally {
            audioCallbackChainInFlight = false;
        }
    })());
    return typeof result === "number" ? null : result;
}

/**
 * Process pending timer callbacks that were queued from the scheduler timer wheel.
 * Called during _AIL_serve@0 when CPU state is stable.
 * Only processes ONE callback per call to avoid re-entrancy issues.
 */
export function processPendingTimerCallbacks(ctx: MSSContext): boolean {
    if (ctx.pendingTimerCallbacks.length === 0) return false;

    const cm = ctx.process?.dispatcher?.callbackManager;
    if (!cm) return false;

    const pending = ctx.pendingTimerCallbacks.shift();
    if (!pending) return false;

    try {
        cm.invokeCallback(pending.callback, [pending.user], 0);
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: Processed timer callback 0x${pending.callback.toString(16)} (${ctx.pendingTimerCallbacks.length} remaining)`);
        return true;
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: Timer callback invoke failed: ${e}`);
        return false;
    }
}

/**
 * Process one pending stream callback (AIL_register_stream_callback), queued when an
 * incrementally fed stream reached the end of its source outside a guest call chain.
 * Miles declares AILSTREAMCB as one argument, HSTREAM — do not pass a second.
 */
export function processPendingStreamCallbacks(ctx: MSSContext): boolean {
    if (ctx.pendingStreamCallbacks.length === 0) return false;

    const cm = ctx.process?.dispatcher?.callbackManager;
    if (!cm) return false;

    const pending = ctx.pendingStreamCallbacks.shift();
    if (!pending) return false;

    try {
        cm.invokeCallback(pending.callback, [pending.handle], 0);
        return true;
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: stream callback invoke failed: ${e}`);
        return false;
    }
}

/**
 * Process pending EOS callbacks that were queued from the scheduler timer wheel.
 * Called during _AIL_serve@0 when CPU state is stable.
 * Only processes ONE callback per call to avoid re-entrancy issues.
 */
export function processPendingEOSCallbacks(ctx: MSSContext): boolean {
    if (ctx.pendingEOSCallbacks.length === 0) return false;

    const cm = ctx.process?.dispatcher?.callbackManager;
    if (!cm) return false;

    const pending = ctx.pendingEOSCallbacks.shift();
    if (!pending) return false;

    try {
        cm.invokeCallback(pending.callback, [pending.handle], 0);
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: Processed EOS callback 0x${pending.callback.toString(16)} (${ctx.pendingEOSCallbacks.length} remaining)`);
        return true;
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: EOS callback invoke failed: ${e}`);
        return false;
    }
}
