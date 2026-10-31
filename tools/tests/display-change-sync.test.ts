/**
 * WM_DISPLAYCHANGE is SENT from inside the mode-set call. An app that clears a
 * "display changed" flag right after its re-init must find the flag already set by the time
 * SetDisplayMode returns; a posted message lands after the clear and re-arms the re-init
 * forever.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { windows } from "../../src/worker/modules/user32/shared-state";
import { sendDisplayChange } from "../../src/worker/modules/user32/message";
import { createDirectDrawExports } from "../../src/worker/modules/ddraw/directdraw";
import { DD_OK } from "../../src/worker/modules/ddraw/constants";

const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const WS_CHILD = 0x40000000;
const WM_DISPLAYCHANGE = 0x7e;
const WNDPROC = 0x401000;
const STACK = 0x1000;

const system = () => System.getInstance();

function drain(hwnds: number[]): Array<{ hwnd: number; wParam: number; lParam: number }> {
    const wm = system().windowManager;
    const out: Array<{ hwnd: number; wParam: number; lParam: number }> = [];
    for (let i = 0; i < 500; i++) {
        const m = wm.getMessage();
        if (!m) break;
        if (m.message === WM_DISPLAYCHANGE && hwnds.includes(m.hwnd)) {
            out.push({ hwnd: m.hwnd, wParam: m.wParam >>> 0, lParam: m.lParam >>> 0 });
        }
    }
    return out;
}

interface CallbackCall { wndProc: number; args: number[]; frameId: number }

function fakeProcess(calls: CallbackCall[]): () => void {
    const sys = system() as any;
    const prev = sys.process;
    sys.process = {
        dispatcher: {
            callbackManager: {
                getStubPoolRange: () => ({ base: 0x21000000, end: 0x21100000 }),
                getActiveSuspendedFrameId: () => 0,
                saveSuspendedThunkContext: () => 7,
                invokeCallback: (wndProc: number, args: number[], _x: number, _r: unknown, _y: boolean, _t: string, frameId: number) => {
                    calls.push({ wndProc, args, frameId });
                    return { callbackId: 9 };
                },
            },
        },
    };
    return () => { sys.process = prev; };
}

const ctx = { esp: STACK } as any;
const mem = new Uint8Array(0x2000);
new DataView(mem.buffer).setUint32(STACK, 0x4010ff, true);

const created: number[] = [];
afterEach(() => {
    for (const h of created.splice(0)) {
        system().windowManager.destroyWindow(h);
        windows.delete(h);
    }
    drain([]);
});

function topLevel(guestProc: boolean): number {
    const hwnd = system().windowManager.createWindow("T", "w", WS_POPUP | WS_VISIBLE, 0, 0, 0, 64, 64, 0, 0, 0, 0);
    created.push(hwnd);
    if (guestProc) windows.set(hwnd, { hwnd, wndProc: WNDPROC } as any);
    return hwnd;
}

describe("sendDisplayChange", () => {
    test("sends to the first guest-WndProc window with bpp/MAKELPARAM and posts the rest", () => {
        const a = topLevel(true);
        const b = topLevel(true);
        const child = system().windowManager.createWindow("T", "c", WS_CHILD | WS_VISIBLE, 0, 0, 0, 8, 8, a, 0, 0, 0);
        created.push(child);
        drain([a, b, child]);
        const calls: CallbackCall[] = [];
        const restore = fakeProcess(calls);
        try {
            const r = sendDisplayChange(ctx, mem, 640, 480, 8, 24, () => DD_OK);
            expect(r).toMatchObject({ suspendedForCallback: true, stackCleanup: 24, skipStackCheck: true });
            expect(calls).toHaveLength(1);
            const sent = calls[0]!.args[0]!;
            expect([a, b]).toContain(sent);
            expect(calls[0]!.wndProc).toBe(WNDPROC);
            expect(calls[0]!.args.slice(1)).toEqual([WM_DISPLAYCHANGE, 8, (480 << 16) | 640]);
            const posted = drain([a, b, child]);
            expect(posted.map((m) => m.hwnd)).toEqual([sent === a ? b : a]);
            expect(posted[0]!.wParam).toBe(8);
            expect(posted[0]!.lParam).toBe(((480 << 16) | 640) >>> 0);
        } finally {
            restore();
        }
    });

    test("with no guest WndProc everything is posted and nothing is suspended", () => {
        const a = topLevel(false);
        drain([a]);
        const calls: CallbackCall[] = [];
        const restore = fakeProcess(calls);
        try {
            expect(sendDisplayChange(ctx, mem, 800, 600, 16, 24, () => DD_OK)).toBeNull();
            expect(calls).toHaveLength(0);
            expect(drain([a])).toHaveLength(1);
        } finally {
            restore();
        }
    });
});

describe("IDirectDraw_SetDisplayMode", () => {
    test("returns DD_OK directly when the mode did not change", () => {
        const sys = system() as any;
        const display = { width: 640, height: 480, bpp: 8, refresh: 60 };
        const context = { display, desktopMode: { ...display }, cooperative: {} } as any;
        const prevResize = sys.requestHostResize;
        sys.requestHostResize = () => {};
        try {
            const exports = createDirectDrawExports(context);
            expect(exports["IDirectDraw_SetDisplayMode"]!(ctx, mem, [0, 640, 480, 8])).toBe(DD_OK);
        } finally {
            sys.requestHostResize = prevResize;
        }
    });
});
