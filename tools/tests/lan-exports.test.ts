import { describe, expect, test } from "bun:test";
import { LanRelay } from "../../deploy/lan-relay";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { LanStack, E, FD_CONNECT, FD_READ } from "../../src/worker/net/lan-stack";
import { createLanExports, PASS } from "../../src/worker/net/lan-exports";
import { WsaSocketTable } from "../../src/worker/modules/wsa-stub-shared";

const guest = new Uint8Array(1 << 20);
Mem.bind(() => guest);
const dv = new DataView(guest.buffer);
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function machine(relay: LanRelay, base: number) {
    const stack = new LanStack();
    const p = relay.join("room", f => stack.onFrame(f))!;
    stack.attachLink({ send: f => p.receive(f) });
    const table = new WsaSocketTable();
    let err = 0;
    const active = { on: true };
    const events: number[] = [];
    const x = createLanExports({
        stack, table, process: null as never, setError: e => { err = e; }, captureError: () => e => { err = e; },
        isActive: () => active.on, clearEvent: h => events.push(h),
    });
    const call = (name: string, ...args: number[]) => x[name](null as never, guest, args);
    const sock = (type: number) => { const s = table.socket(type); stack.create(s, type); return s; };
    const A = {
        base,
        sockaddr(off: number, ip: number, port: number) {
            const o = base + off;
            guest.fill(0, o, o + 16);
            guest[o] = 2; guest[o + 2] = port >> 8; guest[o + 3] = port & 255;
            guest[o + 4] = ip >>> 24; guest[o + 5] = (ip >>> 16) & 255; guest[o + 6] = (ip >>> 8) & 255; guest[o + 7] = ip & 255;
            return o;
        },
        str(off: number, s: string) { guest.set(new TextEncoder().encode(s), base + off); return base + off; },
        read(off: number, n: number) { return new TextDecoder().decode(guest.subarray(base + off, base + off + n)); },
        u32(off: number, v?: number) { const o = base + off; if (v !== undefined) dv.setUint32(o, v, true); return dv.getUint32(o, true); },
    };
    return { stack, table, call, sock, A, err: () => err, events, x, active };
}

const ip = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

describe("LAN thunk exports", () => {
    test("MSG_PEEK re-enables FD_READ so the next arrival still notifies", async () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000), b = machine(relay, 0x8000);
        const sb = b.sock(2), sa = a.sock(2);
        b.call("bind", sb, b.A.sockaddr(0, 0, 2310), 16);
        const posts: number[] = [];
        b.stack.hooks = { postMessage: (_h, _m, _w, l) => { posts.push(l & 0xffff); return true; }, setEvent: () => {} };
        b.stack.selectAsync(sb, 1, 0x500, FD_READ);
        const to = a.A.sockaddr(0x40, b.stack.ip!, 2310);
        a.call("sendto", sa, a.A.str(0, "one"), 3, 0, to, 16);
        await flush();
        expect(posts).toEqual([FD_READ]);
        expect(b.call("recv", sb, b.A.base + 0x300, 8, 2)).toBe(3);   // MSG_PEEK
        expect(posts).toEqual([FD_READ, FD_READ]);                      // data remains, so it is posted again
        b.call("recv", sb, b.A.base + 0x300, 8, 0);
        a.call("sendto", sa, a.A.str(0, "two"), 3, 0, to, 16);
        await flush();
        expect(posts.length).toBe(3);
    });

    test("a socket created before the room was joined joins the LAN on first use", () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000);
        a.active.on = false;
        const s = a.table.socket(2);                  // made while offline: the stack never saw it
        expect(a.stack.has(s)).toBe(false);
        expect(a.call("bind", s, a.A.sockaddr(0, 0, 2311), 16)).toBe(PASS);
        a.active.on = true;
        expect(a.call("bind", s, a.A.sockaddr(0, 0, 2311), 16)).toBe(0);
        expect(a.stack.has(s)).toBe(true);
        expect(a.call("sendto", s, a.A.str(0x100, "x"), 1, 0, a.A.sockaddr(0x40, a.stack.ip!, 2311), 16)).toBe(1);
    });

    test("after leaving the room a socket fails with WSAENETDOWN instead of reaching the offline stub", () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000);
        const s = a.sock(2);
        a.call("bind", s, a.A.sockaddr(0, 0, 2312), 16);
        a.active.on = false;
        a.stack.dissolve();
        expect(a.call("sendto", s, a.A.str(0x100, "x"), 1, 0, a.A.sockaddr(0x40, 0xc0a84d03, 2312), 16)).toBe(-1);
        expect(a.err()).toBe(E.NETDOWN);
        expect(a.call("recv", s, a.A.base + 0x300, 8, 0)).toBe(-1);
        expect(a.err()).toBe(E.NETDOWN);
        a.call("closesocket", s);
        expect(a.stack.has(s)).toBe(false);
        expect(a.call("sendto", s, a.A.str(0x100, "x"), 1, 0, a.A.sockaddr(0x40, 0xc0a84d03, 2312), 16)).toBe(PASS);
    });

    test("send: nonblocking stream accepts a partial write; blocking parks until all of it is accepted", async () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000), b = machine(relay, 0x8000);
        const ls = b.sock(1);
        b.call("bind", ls, b.A.sockaddr(0, 0, 2313), 16);
        b.call("listen", ls, 5);
        const cs = a.sock(1);
        a.call("connect", cs, a.A.sockaddr(0, b.stack.ip!, 2313), 16);
        await flush();
        const conn = b.call("accept", ls, 0, 0) as number;
        // Frozen while the budget is measured (a scheduling pause would refill it), then fast so the parked send finishes.
        let since = -1;
        a.stack.now = () => (since < 0 ? 0 : (performance.now() - since) * 50);
        a.table.setNonBlocking(cs, true);
        const big = 800 << 10;                        // the fake guest is 1 MiB
        const first = a.call("send", cs, a.A.base + 0x2000, big, 0) as number;
        expect(first).toBe(big);
        const n = a.call("send", cs, a.A.base + 0x2000, big, 0) as number;
        expect(n).toBeLessThan(big);                  // budget spent: partial or WSAEWOULDBLOCK
        if (n < 0) expect(a.err()).toBe(E.WOULDBLOCK);
        a.table.setNonBlocking(cs, false);
        since = performance.now();
        const rest = a.call("send", cs, a.A.base + 0x2000, big, 0);
        expect(rest).toBeInstanceOf(Promise);
        expect(await rest).toBe(big);
        await flush();
        expect(b.stack.pendingBytes(conn)).toBe(first + Math.max(n, 0) + big);
    });

    test("sendto/recvfrom marshal sockaddr_in in network byte order", async () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000), b = machine(relay, 0x8000);
        const sb = b.sock(2), sa = a.sock(2);
        expect(b.call("bind", sb, b.A.sockaddr(0, 0, 2300), 16)).toBe(0);
        const msg = a.A.str(0x100, "hello");
        expect(a.call("sendto", sa, msg, 5, 0, a.A.sockaddr(0x40, b.stack.ip!, 2300), 16)).toBe(5);

        b.A.u32(0x200, 16);
        expect(b.call("recvfrom", sb, b.A.base + 0x300, 64, 0, b.A.base + 0x100, b.A.base + 0x200)).toBe(5);
        expect(b.A.read(0x300, 5)).toBe("hello");
        expect(guest[b.A.base + 0x100]).toBe(2);
        const from = b.A.base + 0x104;
        expect(ip(guest[from], guest[from + 1], guest[from + 2], guest[from + 3])).toBe(a.stack.ip!);
        expect(b.A.u32(0x200)).toBe(16);
    });

    test("recvfrom with a too-small fromlen fails without consuming the datagram", () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000), b = machine(relay, 0x8000);
        const sb = b.sock(2), sa = a.sock(2);
        b.call("bind", sb, b.A.sockaddr(0, 0, 2301), 16);
        a.call("sendto", sa, a.A.str(0, "x"), 1, 0, a.A.sockaddr(0x40, b.stack.ip!, 2301), 16);
        b.A.u32(0x200, 8);
        expect(b.call("recvfrom", sb, b.A.base + 0x300, 8, 0, b.A.base + 0x100, b.A.base + 0x200)).toBe(-1);
        expect(b.err()).toBe(10014);
        b.A.u32(0x200, 16);
        expect(b.call("recvfrom", sb, b.A.base + 0x300, 8, 0, b.A.base + 0x100, b.A.base + 0x200)).toBe(1);
    });

    test("nonblocking recv would-block; blocking recv parks until data arrives", async () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000), b = machine(relay, 0x8000);
        const sb = b.sock(2), sa = a.sock(2);
        b.call("bind", sb, b.A.sockaddr(0, 0, 2302), 16);
        b.table.setNonBlocking(sb, true);
        expect(b.call("recv", sb, b.A.base + 0x300, 8, 0)).toBe(-1);
        expect(b.err()).toBe(E.WOULDBLOCK);
        b.table.setNonBlocking(sb, false);
        const pending = b.call("recv", sb, b.A.base + 0x300, 8, 0);
        expect(pending).toBeInstanceOf(Promise);
        a.call("sendto", sa, a.A.str(0, "wake"), 4, 0, a.A.sockaddr(0x40, b.stack.ip!, 2302), 16);
        expect(await pending).toBe(4);
        expect(b.A.read(0x300, 4)).toBe("wake");
    });

    test("TCP: nonblocking connect, select-for-write, accept with peer name, stream I/O", async () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000), b = machine(relay, 0x8000);
        const ls = b.sock(1);
        b.call("bind", ls, b.A.sockaddr(0, 0, 2303), 16);
        expect(b.call("listen", ls, 5)).toBe(0);
        const cs = a.sock(1);
        a.table.setNonBlocking(cs, true);
        expect(a.call("connect", cs, a.A.sockaddr(0, b.stack.ip!, 2303), 16)).toBe(-1);
        expect(a.err()).toBe(E.WOULDBLOCK);

        await flush();
        a.A.u32(0x500, 0); a.A.u32(0x504, 0);
        a.A.u32(0x400, 1); a.A.u32(0x404, cs);
        expect(a.call("select", 0, 0, a.A.base + 0x400, 0, a.A.base + 0x500)).toBe(1);

        b.A.u32(0x200, 16);
        const conn = b.call("accept", ls, b.A.base + 0x100, b.A.base + 0x200) as number;
        expect(conn).toBeGreaterThan(0);
        const peer = b.A.base + 0x104;
        expect(ip(guest[peer], guest[peer + 1], guest[peer + 2], guest[peer + 3])).toBe(a.stack.ip!);

        expect(a.call("send", cs, a.A.str(0x600, "ping"), 4, 0)).toBe(4);
        expect(b.call("recv", conn, b.A.base + 0x700, 16, 0)).toBe(4);
        expect(b.A.read(0x700, 4)).toBe("ping");
        expect(b.call("recv", conn, b.A.base + 0x700, 16, 0) instanceof Promise).toBe(true);
        expect(a.call("getsockopt", cs, 0xffff, 0x1007, a.A.base + 0x800, (a.A.u32(0x804, 4), a.A.base + 0x804))).toBe(0);
        expect(a.A.u32(0x800)).toBe(0);
    });

    test("select blocks until readable, honouring the timeout", async () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000), b = machine(relay, 0x8000);
        const sb = b.sock(2), sa = a.sock(2);
        b.call("bind", sb, b.A.sockaddr(0, 0, 2304), 16);
        b.A.u32(0x400, 1); b.A.u32(0x404, sb);
        b.A.u32(0x500, 5); b.A.u32(0x504, 0);
        const waiting = b.call("select", 0, b.A.base + 0x400, 0, 0, b.A.base + 0x500) as Promise<number>;
        a.call("sendto", sa, a.A.str(0, "z"), 1, 0, a.A.sockaddr(0x40, b.stack.ip!, 2304), 16);
        expect(await waiting).toBe(1);
        expect(b.A.u32(0x400)).toBe(1);

        b.A.u32(0x400, 1); b.A.u32(0x404, sb);
        b.call("recv", sb, b.A.base + 0x300, 8, 0);
        b.A.u32(0x500, 0); b.A.u32(0x504, 20000);
        const t0 = performance.now();
        expect(await (b.call("select", 0, b.A.base + 0x400, 0, 0, b.A.base + 0x500) as Promise<number>)).toBe(0);
        expect(performance.now() - t0).toBeGreaterThanOrEqual(15);
        expect(b.A.u32(0x400)).toBe(0);
    });

    test("WSAEnumNetworkEvents writes the 44-byte WSANETWORKEVENTS and resets the event", async () => {
        const relay = new LanRelay();
        const a = machine(relay, 0x1000), b = machine(relay, 0x8000);
        const cs = a.sock(1);
        a.call("WSAEventSelect", cs, 0x77, FD_CONNECT);
        a.call("connect", cs, a.A.sockaddr(0, b.stack.ip!, 2399), 16);
        await flush();
        guest.fill(0xff, a.A.base + 0x900, a.A.base + 0x900 + 44);
        expect(a.call("WSAEnumNetworkEvents", cs, 0x77, a.A.base + 0x900)).toBe(0);
        expect(a.A.u32(0x900)).toBe(FD_CONNECT);
        expect(dv.getInt32(a.A.base + 0x900 + 4 + 4 * 4, true)).toBe(E.CONNREFUSED);
        expect(a.events).toEqual([0x77]);
    });

    test("sockets the stack does not own defer to the stub", () => {
        const a = machine(new LanRelay(), 0x1000);
        expect(a.call("recv", 999, 0, 0, 0)).toBe(PASS);
        expect(a.call("bind", 999, 0, 0)).toBe(PASS);
    });
});
