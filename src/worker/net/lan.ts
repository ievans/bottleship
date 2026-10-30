/** Process-wide virtual-LAN client: one stack shared by wsock32 and ws2_32. */
import { System } from "../core/system";
import { LanStack } from "./lan-stack";

export const lanStack = new LanStack();

let wanted: string | null = null;
let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 500;

lanStack.hooks = {
    postMessage: (hwnd, msg, wParam, lParam) => System.getInstance().windowManager.postMessage(hwnd, msg, wParam, lParam),
    setEvent: (handle) => { System.getInstance().scheduler.setEvent(handle); },
};

export function lanActive(): boolean {
    return wanted !== null;
}

export interface LanStatus { wanted: string | null; socketOpen: boolean; retryMs: number }

export function lanStatus(): LanStatus {
    return { wanted, socketOpen: socket?.readyState === WebSocket.OPEN, retryMs };
}

export function lanClearEvent(handle: number): void {
    System.getInstance().scheduler.resetEvent(handle);
}

function open(): void {
    if (wanted === null) return;
    const ws = new WebSocket(wanted);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
        retryMs = 500;
        lanStack.attachLink({ send: (f) => { if (ws.readyState === WebSocket.OPEN) ws.send(f as Uint8Array<ArrayBuffer>); } });
    };
    ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) lanStack.onFrame(new Uint8Array(e.data));
    };
    ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        lanStack.attachLink(null);
        if (wanted === null) return;
        retryTimer = setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 5000);
    };
}

/** `url` is the relay endpoint (ws[s]://host/lan/<room>); null leaves the LAN. */
export function configureLan(url: string | null): void {
    if (url === wanted) return;
    wanted = url;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const old = socket;
    socket = null;
    old?.close();
    lanStack.attachLink(null);
    if (url === null) lanStack.dissolve();
    else open();
}
