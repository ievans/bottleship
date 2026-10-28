import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { createMessageExports } from "../../src/worker/modules/user32/message";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const memory = new Uint8Array(0x1000);
Mem.bind(() => memory);
const exports = createMessageExports();

function withStubs(threadId: number, run: (fire: () => void, posts: number[][], wakes: unknown[]) => void) {
    const system = System.getInstance();
    const wheel = system.scheduler.timerWheel;
    const origAdd = wheel.add, origPost = system.windowManager.postMessage;
    const origTid = system.scheduler.getCurrentThreadId, origWake = system.scheduler.wakeMessageWaiters;
    let cb: () => void = () => {};
    const posts: number[][] = [];
    const wakes: unknown[] = [];
    wheel.add = ((_ms: number, _rep: boolean, _kind: number, fn: () => void) => { cb = fn; return 1; }) as any;
    system.windowManager.postMessage = ((...a: number[]) => { posts.push(a); }) as any;
    system.scheduler.getCurrentThreadId = (() => threadId) as any;
    system.scheduler.wakeMessageWaiters = ((t?: number) => { wakes.push(t); }) as any;
    try { run(() => cb(), posts, wakes); } finally {
        wheel.add = origAdd; system.windowManager.postMessage = origPost;
        system.scheduler.getCurrentThreadId = origTid; system.scheduler.wakeMessageWaiters = origWake;
    }
}

test("SetTimer(NULL) posts WM_TIMER to the creating thread only", () => {
    withStubs(7, (fire, posts, wakes) => {
        const id = exports.SetTimer({} as any, memory, [0, 0, 10, 0x2000]);
        fire();
        expect(posts).toEqual([[0, 0x113, id, 0x2000, 0, 0, 7]]);
        expect(wakes).toEqual([7]);
        exports.KillTimer({} as any, memory, [0, id]);
    });
});

test("SetTimer(hwnd) leaves routing to the window's owner thread", () => {
    withStubs(7, (fire, posts, wakes) => {
        exports.SetTimer({} as any, memory, [0x10009, 3, 10, 0]);
        fire();
        expect(posts[0].slice(0, 4)).toEqual([0x10009, 0x113, 3, 0]);
        expect(posts[0][6]).toBe(0);
        expect(wakes).toEqual([undefined]);
        exports.KillTimer({} as any, memory, [0x10009, 3]);
    });
});
