/**
 * Winsock thunks backed by the virtual LAN. They override the offline stub exports for
 * sockets the LanStack owns and defer to the stub for everything else, so a process with no
 * LAN configured behaves exactly as before.
 */
import { Mem } from "../core/memory/mem-accessor";
import { Marshaler } from "../core/memory/marshaler";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { WsaSocketTable } from "../modules/wsa-stub-shared";
import { ipToString } from "../../net/lan-protocol";
import { E, LanStack, SOL_SOCKET, SO_ERROR } from "./lan-stack";

const SOCKET_ERROR = -1;
const INVALID_SOCKET = -1;
const AF_INET = 2;
const SOCKADDR_IN = 16;
const WSAEFAULT = 10014, WSAENOTSOCK = 10038, WSAEINTR = 10004, WSAETIMEDOUT = 10060;
const SO_RCVTIMEO = 0x1006;
const MSG_PEEK = 2;
const FIONREAD = 0x4004667f;
const PENDING = Symbol("pending");
type Pending = typeof PENDING;

export interface LanExportDeps {
    stack: LanStack;
    table: WsaSocketTable;
    process: Process;
    setError(code: number): void;
    /** Binds the calling thread now; the returned setter targets it after an await. */
    captureError(): (code: number) => void;
    isActive(): boolean;
    clearEvent(handle: number): void;
}

/** Sentinel an override returns to defer to the offline stub export. */
export const PASS = Symbol("lan-pass");
type Pass = typeof PASS;
type Impl = (ctx: Parameters<ThunkImplementation>[0], mem: Uint8Array, args: number[]) => number | Promise<number> | Pass; // async overrides never defer: they already own the socket

function readSockaddr(ptr: number, len: number): { ip: number; port: number } | null {
    if (!ptr || len < 8) return null;
    const b = Mem.readBytes(ptr, 8);
    if (!b || (b[0] | (b[1] << 8)) !== AF_INET) return null;
    return { port: (b[2] << 8) | b[3], ip: ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0 };
}

function writeSockaddr(ptr: number, ip: number, port: number): boolean {
    const b = new Uint8Array(SOCKADDR_IN);
    b[0] = AF_INET;
    b[2] = port >>> 8; b[3] = port & 255;
    b[4] = ip >>> 24; b[5] = (ip >>> 16) & 255; b[6] = (ip >>> 8) & 255; b[7] = ip & 255;
    return Mem.writeBytes(ptr, b) === SOCKADDR_IN;
}

/** Writes a name and the in/out length, per the getsockname/recvfrom contract. */
function writeName(ptr: number, lenPtr: number, ip: number, port: number): boolean {
    if (!ptr) return true;
    if (!lenPtr) return false;
    const avail = Mem.readInt32(lenPtr);
    if (avail === null || avail < SOCKADDR_IN) return false;
    return writeSockaddr(ptr, ip, port) && Mem.writeUint32(lenPtr, SOCKADDR_IN);
}

/** Validates an optional name out-buffer up front so a failed call never consumes data. */
function nameBufferOk(ptr: number, lenPtr: number): boolean {
    if (!ptr) return true;
    if (!lenPtr) return false;
    const avail = Mem.readInt32(lenPtr);
    return avail !== null && avail >= SOCKADDR_IN;
}

export function createLanExports(d: LanExportDeps): Record<string, Impl> {
    const { stack, table } = d;
    // Last error is per-thread: code that runs after an await must not write the then-current thread's.
    let errorTarget: ((code: number) => void) | null = null;
    const setError = (code: number): void => (errorTarget ?? d.setError)(code);
    const asCaller = <T>(cap: (code: number) => void, f: () => T): T => {
        errorTarget = cap;
        try { return f(); } finally { errorTarget = null; }
    };
    const own = (s: number): boolean => d.isActive() && stack.has(s);

    /** Retries `op` until it yields a result; blocking sockets park the thread on the stack. */
    const blocking = (s: number, op: () => number | Pending, failed: number, timeoutOpt = 0): number | Promise<number> => {
        const first = op();
        if (first !== PENDING) return first;
        if (table.isNonBlocking(s)) { setError(E.WOULDBLOCK); return failed; }
        const limit = timeoutOpt ? stack.getOpt(s, SOL_SOCKET, timeoutOpt) : 0;
        const deadline = limit > 0 ? performance.now() + limit : Infinity;
        const cap = d.captureError();
        return (async () => {
            for (;;) {
                await stack.waitChange([s], deadline === Infinity ? -1 : Math.max(0, deadline - performance.now()));
                if (!stack.has(s)) { cap(WSAEINTR); return failed; }
                const r = asCaller(cap, op);
                if (r !== PENDING) return r;
                if (performance.now() >= deadline) { cap(WSAETIMEDOUT); return failed; }
            }
        })();
    };

    const fail = (err: number, ret = SOCKET_ERROR): number => { setError(err); return ret; };

    const recvInto = (s: number, len: number, flags: number, deliver: (data: Uint8Array) => boolean,
        name: ((ip: number, port: number) => boolean) | null): number | Pending => {
        const r = stack.recv(s, len, true);
        if (r.err === E.WOULDBLOCK) return PENDING;
        if (r.err && r.err !== E.MSGSIZE) return fail(r.err);
        if (!deliver(r.data)) return fail(WSAEFAULT);
        if (name && !name(r.ip, r.port)) return fail(WSAEFAULT);
        if ((flags & MSG_PEEK) === 0) stack.recv(s, len, false);
        setError(r.err);
        return r.err === E.MSGSIZE ? SOCKET_ERROR : r.data.length;
    };

    const sendFrom = (s: number, data: Uint8Array, to: { ip: number; port: number } | null): number => {
        const n = to ? stack.sendTo(s, to.ip, to.port, data) : stack.send(s, data);
        if (n < 0) return fail(-n);
        setError(0);
        return n;
    };

    const gather = (bufs: number, count: number): Uint8Array | null => {
        const parts: Uint8Array[] = [];
        let total = 0;
        for (let i = 0; i < count; i++) {
            const len = Mem.readUint32(bufs + i * 8);
            const ptr = Mem.readUint32(bufs + i * 8 + 4);
            if (len === null || ptr === null) return null;
            if (len === 0) continue;
            const b = Mem.readBytes(ptr, len);
            if (!b) return null;
            parts.push(b.slice());
            total += len;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.length; }
        return out;
    };

    const scatter = (bufs: number, count: number, data: Uint8Array): boolean => {
        let off = 0;
        for (let i = 0; i < count && off < data.length; i++) {
            const len = Mem.readUint32(bufs + i * 8);
            const ptr = Mem.readUint32(bufs + i * 8 + 4);
            if (len === null || ptr === null) return false;
            const n = Math.min(len, data.length - off);
            if (n && Mem.writeBytes(ptr, data.subarray(off, off + n)) !== n) return false;
            off += n;
        }
        return true;
    };

    // ---- hostname / DNS ---------------------------------------------------------------

    let hostentAddr = 0;
    const nameOf = (ip: number): string => `BOTTLESHIP-${ip & 255}`;
    const hostName = (): string => nameOf(stack.ip ?? 0);

    const sameSubnet = (a: number, b: number): boolean => ((a ^ b) & 0xffffff00) === 0;

    const peerIpOfName = (name: string): number | null => {
        const m = /^BOTTLESHIP-(\d{1,3})$/i.exec(name);
        if (!m || stack.ip === null) return null;
        const n = Number(m[1]);
        return n >= 1 && n <= 254 ? ((stack.ip & 0xffffff00) | n) >>> 0 : null;
    };

    const lanHostent = (ip: number): number => {
        if (!hostentAddr) hostentAddr = d.process.memory.alloc(96, "THUNK_DATA", "rw") >>> 0;
        if (!hostentAddr) return 0;
        const base = hostentAddr;
        const name = new TextEncoder().encode(`${nameOf(ip)}\0`);
        const nameAt = base + 40, aliasAt = base + 16, addrAt = base + 20, listAt = base + 24;
        const ok = Mem.writeBytes(nameAt, name) === name.length
            && Mem.writeUint32(aliasAt, 0)
            && Mem.writeBytes(addrAt, new Uint8Array([ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255])) === 4
            && Mem.writeUint32(listAt, addrAt) && Mem.writeUint32(listAt + 4, 0)
            && Mem.writeUint32(base, nameAt) && Mem.writeUint32(base + 4, aliasAt)
            && Mem.writeBytes(base + 8, new Uint8Array([AF_INET, 0, 4, 0])) === 4
            && Mem.writeUint32(base + 12, listAt);
        return ok ? base : 0;
    };

    const out: Record<string, Impl> = {
        gethostname: (_c, _m, a) => {
            const ptr = a[0] >>> 0, len = a[1] | 0;
            if (stack.ip === null || !ptr || len <= 0) return PASS;
            const b = new TextEncoder().encode(`${hostName()}\0`);
            if (b.length > len) return fail(WSAEFAULT);
            if (Mem.writeBytes(ptr, b) !== b.length) return fail(WSAEFAULT);
            setError(0);
            return 0;
        },
        gethostbyname: (_c, mem, a) => {
            if (!a[0]) return PASS;
            const name = Marshaler.readString(mem, a[0] >>> 0).trim();
            if (stack.ip === null) return PASS;
            const ip = name === "" || name.toLowerCase() === hostName().toLowerCase() ? stack.ip : peerIpOfName(name);
            if (ip === null) return PASS;
            const p = lanHostent(ip);
            if (!p) return PASS;
            setError(0);
            return p;
        },
        gethostbyaddr: (_c, _m, a) => {
            const ptr = a[0] >>> 0, len = a[1] | 0, type = a[2] | 0;
            if (stack.ip === null || !ptr || len !== 4 || type !== AF_INET) return PASS;
            const b = Mem.readBytes(ptr, 4);
            if (!b) return PASS;
            const ip = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
            if (!sameSubnet(ip, stack.ip)) return PASS;
            const p = lanHostent(ip);
            if (!p) return PASS;
            setError(0);
            return p;
        },

        // ---- socket lifecycle ----
        closesocket: (_c, _m, a) => { stack.close(a[0] >>> 0); return PASS; },
        bind: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const to = readSockaddr(a[1] >>> 0, a[2] | 0);
            if (!to) return fail(WSAEFAULT);
            const e = stack.bind(s, to.ip, to.port);
            return e ? fail(e) : (setError(0), 0);
        },
        listen: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const e = stack.listen(s, a[1] | 0);
            return e ? fail(e) : (setError(0), 0);
        },
        connect: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const to = readSockaddr(a[1] >>> 0, a[2] | 0);
            if (!to) return fail(WSAEFAULT);
            const e = stack.connect(s, to.ip, to.port);
            if (e === 0) { setError(0); return 0; }
            if (e !== E.WOULDBLOCK) return fail(e);
            if (table.isNonBlocking(s)) return fail(E.WOULDBLOCK);
            const cap = d.captureError();
            return (async () => {
                for (;;) {
                    await stack.waitChange([s], -1);
                    if (!stack.has(s)) { cap(WSAEINTR); return SOCKET_ERROR; }
                    const st = stack.ready(s);
                    if (st.x) { cap(stack.getOpt(s, SOL_SOCKET, SO_ERROR) || E.CONNREFUSED); return SOCKET_ERROR; }
                    if (st.w) { cap(0); return 0; }
                }
            })();
        },
        accept: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            if (!nameBufferOk(a[1] >>> 0, a[2] >>> 0)) return fail(WSAEFAULT, INVALID_SOCKET);
            return blocking(s, () => {
                const r = stack.accept(s, () => table.socket(1));
                if (r.err === E.WOULDBLOCK) return PENDING;
                if (r.err) return fail(r.err, INVALID_SOCKET);
                if (table.isNonBlocking(s)) table.setNonBlocking(r.id, true);
                setError(0);
                return writeName(a[1] >>> 0, a[2] >>> 0, r.ip, r.port) ? r.id : fail(WSAEFAULT, INVALID_SOCKET);
            }, INVALID_SOCKET);
        },
        shutdown: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const e = stack.shutdown(s, a[1] | 0);
            return e ? fail(e) : (setError(0), 0);
        },

        // ---- data ----
        send: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const b = Mem.readBytes(a[1] >>> 0, a[2] >>> 0);
            if (!b) return fail(WSAEFAULT);
            return sendFrom(s, b.slice(), null);
        },
        sendto: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const b = Mem.readBytes(a[1] >>> 0, a[2] >>> 0);
            if (!b) return fail(WSAEFAULT);
            const to = a[4] ? readSockaddr(a[4] >>> 0, a[5] | 0) : null;
            if (a[4] && !to) return fail(WSAEFAULT);
            return sendFrom(s, b.slice(), to);
        },
        recv: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const buf = a[1] >>> 0, len = a[2] >>> 0;
            return blocking(s, () => recvInto(s, len, a[3] | 0,
                data => data.length === 0 || Mem.writeBytes(buf, data) === data.length, null), SOCKET_ERROR, SO_RCVTIMEO);
        },
        recvfrom: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const buf = a[1] >>> 0, len = a[2] >>> 0, from = a[4] >>> 0, fromLen = a[5] >>> 0;
            if (!nameBufferOk(from, fromLen)) return fail(WSAEFAULT);
            return blocking(s, () => recvInto(s, len, a[3] | 0,
                data => data.length === 0 || Mem.writeBytes(buf, data) === data.length,
                (ip, port) => writeName(from, fromLen, ip, port)), SOCKET_ERROR, SO_RCVTIMEO);
        },

        // ---- names / options ----
        getsockname: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const n = stack.names(s)!;
            return writeName(a[1] >>> 0, a[2] >>> 0, n.local.ip, n.local.port) ? (setError(0), 0) : fail(WSAEFAULT);
        },
        getpeername: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const n = stack.names(s)!;
            if (!n.remote) return fail(10057);
            return writeName(a[1] >>> 0, a[2] >>> 0, n.remote.ip, n.remote.port) ? (setError(0), 0) : fail(WSAEFAULT);
        },
        setsockopt: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const len = a[4] | 0;
            const b = a[3] && len > 0 ? Mem.readBytes(a[3] >>> 0, Math.min(len, 4)) : null;
            let v = 0;
            if (b) for (let i = b.length - 1; i >= 0; i--) v = (v << 8) | b[i];
            stack.setOpt(s, a[1] | 0, a[2] | 0, v);
            setError(0);
            return 0;
        },
        getsockopt: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const valPtr = a[3] >>> 0, lenPtr = a[4] >>> 0;
            const avail = lenPtr ? Mem.readInt32(lenPtr) : null;
            if (!valPtr || avail === null || avail < 1) return fail(WSAEFAULT);
            const v = stack.getOpt(s, a[1] | 0, a[2] | 0);
            const n = Math.min(4, avail);
            const bytes = new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]).subarray(0, n);
            if (Mem.writeBytes(valPtr, bytes) !== n || !Mem.writeUint32(lenPtr, n)) return fail(WSAEFAULT);
            setError(0);
            return 0;
        },
        ioctlsocket: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if ((a[1] >>> 0) !== FIONREAD || !own(s)) return PASS;
            if (!a[2] || !Mem.writeUint32(a[2] >>> 0, stack.pendingBytes(s))) return fail(WSAEFAULT);
            setError(0);
            return 0;
        },
        WSAIoctl: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if ((a[1] >>> 0) !== FIONREAD || !own(s)) return PASS;
            const outBuf = a[4] >>> 0, outLen = a[5] >>> 0, ret = a[6] >>> 0;
            if (!outBuf || outLen < 4 || !Mem.writeUint32(outBuf, stack.pendingBytes(s))) return fail(WSAEFAULT);
            if (ret && !Mem.writeUint32(ret, 4)) return fail(WSAEFAULT);
            setError(0);
            return 0;
        },

        // ---- readiness ----
        select: (_c, _m, a) => {
            if (!d.isActive()) return PASS;
            const sets = [a[1] >>> 0, a[2] >>> 0, a[3] >>> 0].map(readFdSet);
            if (sets.some(x => x === null)) return PASS;
            const [rd, wr, ex] = sets as number[][];
            const all = [...rd, ...wr, ...ex];
            if (!all.some(own)) return PASS;
            if (all.some(s => !table.isValid(s))) return fail(WSAENOTSOCK);

            const poll = () => {
                const stackReady = (s: number, k: "r" | "w" | "x") => (own(s) ? stack.ready(s)[k] : k === "w" && table.isConnected(s));
                return [rd.filter(s => stackReady(s, "r")), wr.filter(s => stackReady(s, "w")), ex.filter(s => stackReady(s, "x"))];
            };
            const finish = (r: number[][]): number => {
                writeFdSet(a[1] >>> 0, r[0]); writeFdSet(a[2] >>> 0, r[1]); writeFdSet(a[3] >>> 0, r[2]);
                setError(0);
                return r[0].length + r[1].length + r[2].length;
            };
            const first = poll();
            const total = first[0].length + first[1].length + first[2].length;
            let timeoutMs = -1;
            if (a[4]) {
                const sec = Mem.readUint32(a[4] >>> 0), usec = Mem.readUint32((a[4] >>> 0) + 4);
                if (sec === null || usec === null) return fail(WSAEFAULT);
                timeoutMs = sec * 1000 + Math.ceil(usec / 1000);
            }
            if (total > 0 || timeoutMs === 0) return finish(first);
            const watch = all.filter(own);
            const cap = d.captureError();
            return (async () => {
                const deadline = timeoutMs < 0 ? Infinity : performance.now() + timeoutMs;
                for (;;) {
                    if (!watch.every(w => stack.has(w))) { cap(WSAENOTSOCK); return SOCKET_ERROR; }
                    const left = deadline === Infinity ? -1 : Math.max(0, deadline - performance.now());
                    await stack.waitChange(watch, left);
                    if (!watch.every(w => stack.has(w))) { cap(WSAENOTSOCK); return SOCKET_ERROR; }
                    const r = poll();
                    if (r[0].length + r[1].length + r[2].length > 0 || performance.now() >= deadline) return asCaller(cap, () => finish(r));
                }
            })();
        },
        WSAAsyncSelect: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            stack.selectAsync(s, a[1] >>> 0, a[2] >>> 0, a[3] >>> 0);
            table.setNonBlocking(s, true);
            setError(0);
            return 0;
        },
        WSAEventSelect: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            stack.selectEvent(s, a[1] >>> 0, a[2] >>> 0);
            table.setNonBlocking(s, true);
            setError(0);
            return 0;
        },
        WSAEnumNetworkEvents: (_c, _m, a) => {
            const s = a[0] >>> 0;
            if (!own(s)) return PASS;
            const ev = stack.enumEvents(s)!;
            if (a[1]) d.clearEvent(a[1] >>> 0);
            const b = new Uint8Array(44);
            const v = new DataView(b.buffer);
            v.setUint32(0, ev.mask, true);
            ev.errs.forEach((e, i) => v.setInt32(4 + i * 4, e, true));
            if (!a[2] || Mem.writeBytes(a[2] >>> 0, b) !== 44) return fail(WSAEFAULT);
            setError(0);
            return 0;
        },

        // ---- Winsock 2 scatter/gather (non-overlapped) ----
        WSASend: (_c, _m, a) => wsaSend(a, 5, false),
        WSASendTo: (_c, _m, a) => wsaSend(a, 7, true),
        WSARecv: (_c, _m, a) => wsaRecv(a, 5, false),
        WSARecvFrom: (_c, _m, a) => wsaRecv(a, 7, true),
    };

    const wsaSend = (a: number[], ovl: number, hasTo: boolean): number | Pass => {
        const s = a[0] >>> 0;
        if (!own(s) || a[ovl] || a[ovl + 1]) return PASS;
        const data = gather(a[1] >>> 0, a[2] >>> 0);
        if (!data) return fail(WSAEFAULT);
        const to = hasTo && a[5] ? readSockaddr(a[5] >>> 0, a[6] | 0) : null;
        if (hasTo && a[5] && !to) return fail(WSAEFAULT);
        const n = sendFrom(s, data, to);
        if (n < 0) return n;
        if (a[3]) Mem.writeUint32(a[3] >>> 0, n);
        return 0;
    };

    const wsaRecv = (a: number[], ovl: number, hasFrom: boolean): number | Promise<number> | Pass => {
        const s = a[0] >>> 0;
        if (!own(s) || a[ovl] || a[ovl + 1]) return PASS;
        const bufs = a[1] >>> 0, count = a[2] >>> 0;
        let cap = 0;
        for (let i = 0; i < count; i++) cap += Mem.readUint32(bufs + i * 8) ?? 0;
        const flagsPtr = a[4] >>> 0;
        const flags = flagsPtr ? (Mem.readUint32(flagsPtr) ?? 0) : 0;
        const from = hasFrom ? a[5] >>> 0 : 0, fromLen = hasFrom ? a[6] >>> 0 : 0;
        if (!nameBufferOk(from, fromLen)) return fail(WSAEFAULT);
        return blocking(s, () => {
            let got = 0;
            const r = recvInto(s, cap, flags, data => { got = data.length; return scatter(bufs, count, data); },
                hasFrom ? (ip, port) => writeName(from, fromLen, ip, port) : null);
            if (r === PENDING || r === SOCKET_ERROR) return r;
            if (a[3]) Mem.writeUint32(a[3] >>> 0, got);
            if (flagsPtr) Mem.writeUint32(flagsPtr, 0);
            return 0;
        }, SOCKET_ERROR, SO_RCVTIMEO);
    };

    traceCalls(out, stack);
    return out;
}

/** Sockaddr argument index per call; the rest log the socket and result only. */
const TRACED: Record<string, number> = {
    bind: 1, connect: 1, sendto: 4, send: -1, listen: -1, closesocket: -1, shutdown: -1,
    setsockopt: -1, ioctlsocket: -1, WSAEventSelect: -1, WSAAsyncSelect: -1, WSASendTo: 5, WSAConnect: 1,
    gethostname: -1, gethostbyname: -1, getsockname: -1, getpeername: -1,
};
const HEX_PREVIEW = 48;
const hexOf = (ptr: number, len: number): string => {
    const b = ptr && len > 0 ? Mem.readBytes(ptr, Math.min(len, HEX_PREVIEW)) : null;
    return b ? ` ${len}B ${Array.from(b, x => (x < 16 ? "0" : "") + x.toString(16)).join("")}` : "";
};
const cString = (ptr: number): string => {
    const b = ptr ? Mem.readBytes(ptr, 64) : null;
    if (!b) return "";
    const end = b.indexOf(0);
    return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
};
const sockaddrText = (ptr: number): string => {
    const sa = readSockaddr(ptr, 16);
    return sa ? `${ipToString(sa.ip)}:${sa.port}` : "";
};
/** What a call produced, read back from guest memory once it returned. */
const RESULT_DETAIL: Record<string, (a: number[], r: number) => string> = {
    gethostname: a => cString(a[0] >>> 0),
    gethostbyname: (a, r) => {
        if (!r) return "";
        const list = Mem.readUint32((r >>> 0) + 12), first = list ? Mem.readUint32(list) : null, b = first ? Mem.readBytes(first, 4) : null;
        return b ? Array.from(b).join(".") : "";
    },
    getsockname: a => sockaddrText(a[1] >>> 0),
    getpeername: a => sockaddrText(a[1] >>> 0),
};
/** Polled calls are logged only when they succeeded: a non-blocking loop calls them 100k times. */
const TRACED_RECV = ["recv", "recvfrom", "WSARecv", "WSARecvFrom", "accept", "WSAAccept"];

function traceCalls(out: Record<string, Impl>, stack: LanStack): void {
    const describe = (a: number[], at: number): string => {
        let d = `s=${a[0] >>> 0}`;
        if (at > 0) {
            const to = readSockaddr(a[at] >>> 0, 16);
            if (to) d += ` ${ipToString(to.ip)}:${to.port}`;
        }
        return d;
    };
    const outcome = (r: number | Promise<number> | Pass): string => (r === PASS ? "pass" : typeof r === "number" ? String(r | 0) : "async");
    for (const [name, at] of Object.entries(TRACED)) {
        const impl = out[name];
        if (!impl) continue;
        out[name] = (ctx, mem, a) => {
            const tap = stack.tap;
            if (!tap) return impl(ctx, mem, a);
            let detail = describe(a, at);
            if (name === "send" || name === "sendto") detail += hexOf(a[1] >>> 0, a[2] | 0);
            else if (name === "gethostbyname") detail += ` ${cString(a[0] >>> 0)}`;
            const r = impl(ctx, mem, a);
            let res = outcome(r);
            const more = RESULT_DETAIL[name];
            if (more && typeof r === "number") res += ` ${more(a, r)}`;
            tap.call(name, detail, res);
            return r;
        };
    }
    for (const name of TRACED_RECV) {
        const impl = out[name];
        if (!impl) continue;
        out[name] = (ctx, mem, a) => {
            const r = impl(ctx, mem, a);
            const tap = stack.tap;
            if (tap && (typeof r !== "number" || (name.endsWith("ccept") ? r !== SOCKET_ERROR : r > 0))) tap.call(name, `s=${a[0] >>> 0}`, outcome(r));
            return r;
        };
    }
}

function readFdSet(ptr: number): number[] | null {
    if (!ptr) return [];
    const count = Mem.readUint32(ptr);
    if (count === null || count > 1024) return null;
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
        const v = Mem.readUint32(ptr + 4 + i * 4);
        if (v === null) return null;
        out.push(v >>> 0);
    }
    return out;
}

function writeFdSet(ptr: number, socks: number[]): void {
    if (!ptr) return;
    Mem.writeUint32(ptr, socks.length);
    socks.forEach((s, i) => Mem.writeUint32(ptr + 4 + i * 4, s));
}

/**
 * Layers `lan` over `base`: an override returns PASS to defer to the stub export with the
 * same arguments. Only names present in both tables are wrapped.
 */
export function overlayLan(base: Record<string, ThunkImplementation>, lan: Record<string, Impl>): void {
    for (const name of Object.keys(lan)) {
        const stub = base[name];
        if (!stub) continue;
        base[name] = (ctx, mem, args) => {
            const r = lan[name](ctx, mem, args);
            if (r === PASS) return stub(ctx, mem, args);
            return r;
        };
    }
}

/** socket()/WSASocketA: register what the stub table just created with the LAN stack. */
export function wrapSocketCreate(base: Record<string, ThunkImplementation>, d: Pick<LanExportDeps, "stack" | "table" | "isActive">): void {
    for (const name of ["socket", "WSASocketA", "ord_23"]) {
        const stub = base[name];
        if (!stub) continue;
        base[name] = (ctx, mem, args) => {
            const r = stub(ctx, mem, args);
            if (typeof r === "number" && r !== INVALID_SOCKET && d.isActive()) d.stack.create(r >>> 0, d.table.typeOf(r >>> 0));
            if (d.isActive()) d.stack.tap?.call(name, `af=${args[0] | 0} type=${args[1] | 0}`, String(r));
            return r;
        };
    }
}
