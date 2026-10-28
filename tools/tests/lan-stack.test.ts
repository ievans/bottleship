import { describe, expect, test } from "bun:test";
import { LanRelay } from "../../deploy/lan-relay";
import { LanStack, E, FD_READ, FD_ACCEPT, FD_CONNECT, FD_CLOSE } from "../../src/worker/net/lan-stack";
import { Op, decode, encode, ipToString, LAN_BROADCAST } from "../../src/net/lan-protocol";

const flush = () => new Promise<void>(r => setTimeout(r, 0));
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function peer(relay: LanRelay, room = "r") {
    const stack = new LanStack();
    const p = relay.join(room, f => stack.onFrame(f))!;
    stack.attachLink({ send: f => p.receive(f) });
    let n = 0;
    const sock = (type: number) => { const id = ++n; stack.create(id, type); return id; };
    return { stack, p, sock, alloc: () => ++n };
}

describe("LanRelay", () => {
    test("assigns distinct addresses in 192.168.77.0/24 and welcomes each peer", () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        expect(ipToString(a.stack.ip!)).toBe("192.168.77.2");
        expect(ipToString(b.stack.ip!)).toBe("192.168.77.3");
    });
    test("rooms are isolated and names validated", () => {
        const relay = new LanRelay();
        expect(relay.join("../x", () => {})).toBeNull();
        const a = peer(relay, "one"), b = peer(relay, "two");
        expect(a.stack.ip).toBe(b.stack.ip);
    });
    test("clients cannot forge relay-only frames or spoof source", () => {
        const relay = new LanRelay();
        const got: Uint8Array[] = [];
        const victim = relay.join("r", f => got.push(f))!;
        const evil = relay.join("r", () => {})!;
        got.length = 0;
        evil.receive(encode({ op: Op.PeerLeave, ip: victim.ip }));
        evil.receive(encode({ op: Op.Welcome, ip: victim.ip }));
        expect(got.length).toBe(0);
        evil.receive(encode({ op: Op.Udp, ip: victim.ip, srcPort: 1, dstPort: 2, data: bytes("x") }));
        const m = decode(got[0])!;
        expect(m.ip).toBe(evil.ip);
    });
    test("malformed and oversize frames are dropped; broadcast is UDP-only", () => {
        const relay = new LanRelay();
        const got: Uint8Array[] = [];
        relay.join("r", f => got.push(f));
        const evil = relay.join("r", () => {})!;
        got.length = 0;
        evil.receive(new Uint8Array([1, 2]));
        evil.receive(new Uint8Array(70000));
        evil.receive(encode({ op: Op.Syn, ip: LAN_BROADCAST, cid: 1, srcPort: 1, dstPort: 1 }));
        expect(got.length).toBe(0);
    });
    test("leaving notifies the room and frees the address", () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const ipB = b.stack.ip!;
        b.p.leave();
        const c = peer(relay);
        expect(c.stack.ip).toBe(ipB);
        void a;
    });
});

describe("LanStack UDP", () => {
    test("unicast between peers reports the sender's address", async () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const sa = a.sock(2), sb = b.sock(2);
        expect(b.stack.bind(sb, 0, 4000)).toBe(0);
        expect(a.stack.sendTo(sa, b.stack.ip!, 4000, bytes("hello"))).toBe(5);
        const r = b.stack.recv(sb, 100, false);
        expect(r.err).toBe(0);
        expect(text(r.data)).toBe("hello");
        expect(r.ip).toBe(a.stack.ip!);
        expect(r.port).toBe(a.stack.names(sa)!.local.port);
        expect(b.stack.recv(sb, 100, false).err).toBe(E.WOULDBLOCK);
    });
    test("broadcast reaches every peer and loops back to the sender", async () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay), c = peer(relay);
        const socks = [a, b, c].map(p => { const s = p.sock(2); p.stack.bind(s, 0, 5000); return s; });
        a.stack.sendTo(socks[0], 0xffffffff, 5000, bytes("who"));
        await flush();
        for (const [i, p] of [a, b, c].entries()) expect(text(p.stack.recv(socks[i], 10, false).data)).toBe("who");
    });
    test("datagram truncation reports MSGSIZE and drops the rest; peek keeps it", () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const sa = a.sock(2), sb = b.sock(2);
        b.stack.bind(sb, 0, 4001);
        a.stack.sendTo(sa, b.stack.ip!, 4001, bytes("abcdef"));
        expect(b.stack.pendingBytes(sb)).toBe(6);
        expect(text(b.stack.recv(sb, 3, true).data)).toBe("abc");
        const r = b.stack.recv(sb, 3, false);
        expect(r.err).toBe(E.MSGSIZE);
        expect(b.stack.recv(sb, 3, false).err).toBe(E.WOULDBLOCK);
    });
    test("loopback and own-address sends stay local", async () => {
        const relay = new LanRelay();
        const a = peer(relay);
        const s1 = a.sock(2), s2 = a.sock(2);
        a.stack.bind(s2, 0, 6000);
        a.stack.sendTo(s1, 0x7f000001, 6000, bytes("self"));
        await flush();
        expect(text(a.stack.recv(s2, 10, false).data)).toBe("self");
    });
    test("bind conflicts need SO_REUSEADDR on both; ephemeral ports are distinct", () => {
        const a = peer(new LanRelay());
        const s1 = a.sock(2), s2 = a.sock(2), s3 = a.sock(2);
        expect(a.stack.bind(s1, 0, 7000)).toBe(0);
        expect(a.stack.bind(s2, 0, 7000)).toBe(E.ADDRINUSE);
        a.stack.setOpt(s1, 0xffff, 4, 1);
        a.stack.setOpt(s3, 0xffff, 4, 1);
        expect(a.stack.bind(s3, 0, 7000)).toBe(0);
        const e1 = a.sock(2), e2 = a.sock(2);
        a.stack.bind(e1, 0, 0); a.stack.bind(e2, 0, 0);
        expect(a.stack.names(e1)!.local.port).not.toBe(a.stack.names(e2)!.local.port);
    });
    test("connected UDP filters other senders; unreachable unicast errors", () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay), c = peer(relay);
        const sa = a.sock(2), sb = b.sock(2), sc = c.sock(2);
        a.stack.bind(sa, 0, 8000);
        a.stack.connect(sa, b.stack.ip!, 9000);
        b.stack.bind(sb, 0, 9000);
        c.stack.sendTo(sc, a.stack.ip!, 8000, bytes("no"));
        expect(a.stack.recv(sa, 9, false).err).toBe(E.WOULDBLOCK);
        const lone = new LanStack();
        const sl = (lone.create(1, 2), 1);
        expect(lone.sendTo(sl, 0xc0a84d09, 1, bytes("x"))).toBe(-E.NETUNREACH);
    });
    test("async select posts FD_READ once until recv re-arms it", () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const posts: number[][] = [];
        b.stack.hooks = { postMessage: (h, m, w, l) => posts.push([h, m, w, l]), setEvent() {} };
        const sa = a.sock(2), sb = b.sock(2);
        b.stack.bind(sb, 0, 4100);
        b.stack.selectAsync(sb, 0x10, 0x500, FD_READ);
        a.stack.sendTo(sa, b.stack.ip!, 4100, bytes("1"));
        a.stack.sendTo(sa, b.stack.ip!, 4100, bytes("2"));
        expect(posts).toEqual([[0x10, 0x500, sb, FD_READ]]);
        b.stack.recv(sb, 9, false);
        expect(posts.length).toBe(2);
    });
});

describe("LanStack TCP", () => {
    async function connectedPair() {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const ls = b.sock(1);
        b.stack.bind(ls, 0, 2300);
        expect(b.stack.listen(ls, 4)).toBe(0);
        const cs = a.sock(1);
        expect(a.stack.connect(cs, b.stack.ip!, 2300)).toBe(E.WOULDBLOCK);
        await flush();
        const acc = b.stack.accept(ls, b.alloc);
        expect(acc.err).toBe(0);
        return { a, b, ls, cs, ss: acc.id, acc };
    }

    test("connect/accept handshake and bidirectional stream", async () => {
        const { a, b, cs, ss, acc } = await connectedPair();
        expect(acc.ip).toBe(a.stack.ip!);
        expect(a.stack.send(cs, bytes("ping"))).toBe(4);
        expect(text(b.stack.recv(ss, 100, false).data)).toBe("ping");
        b.stack.send(ss, bytes("po")); b.stack.send(ss, bytes("ng"));
        expect(text(a.stack.recv(cs, 3, false).data)).toBe("pon");
        expect(text(a.stack.recv(cs, 3, false).data)).toBe("g");
        expect(a.stack.names(cs)!.remote).toEqual({ ip: b.stack.ip!, port: 2300 });
        expect(a.stack.getOpt(cs, 0xffff, 0x1007)).toBe(0);
    });
    test("large writes are chunked and reassembled in order", async () => {
        const { a, b, cs, ss } = await connectedPair();
        const big = new Uint8Array(100000).map((_, i) => i & 255);
        a.stack.send(cs, big);
        const got = b.stack.recv(ss, 200000, false).data;
        expect(got.length).toBe(100000);
        expect(got.every((v, i) => v === (i & 255))).toBe(true);
    });
    test("refused connection reports CONNREFUSED through SO_ERROR and except readiness", async () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const cs = a.sock(1);
        a.stack.connect(cs, b.stack.ip!, 2399);
        await flush();
        expect(a.stack.ready(cs).x).toBe(true);
        expect(a.stack.getOpt(cs, 0xffff, 0x1007)).toBe(E.CONNREFUSED);
        expect(a.stack.getOpt(cs, 0xffff, 0x1007)).toBe(0);
    });
    test("graceful close yields a 0-byte recv after the queued data", async () => {
        const p = await connectedPair();
        p.a.stack.send(p.cs, bytes("bye"));
        p.a.stack.close(p.cs);
        expect(text(p.b.stack.recv(p.ss, 9, false).data)).toBe("bye");
        const eof = p.b.stack.recv(p.ss, 9, false);
        expect(eof.err).toBe(0);
        expect(eof.data.length).toBe(0);
    });
    test("peer leaving resets live connections", async () => {
        const { a, b, cs, ss } = await connectedPair();
        a.p.leave();
        expect(b.stack.recv(ss, 9, false).err).toBe(E.CONNRESET);
        void cs;
    });
    test("async select delivers ACCEPT, CONNECT and CLOSE", async () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const bp: number[][] = [], ap: number[][] = [];
        b.stack.hooks = { postMessage: (_h, _m, w, l) => bp.push([w, l]), setEvent() {} };
        a.stack.hooks = { postMessage: (_h, _m, w, l) => ap.push([w, l]), setEvent() {} };
        const ls = b.sock(1);
        b.stack.bind(ls, 0, 2301); b.stack.listen(ls, 2);
        b.stack.selectAsync(ls, 1, 2, FD_ACCEPT);
        const cs = a.sock(1);
        a.stack.selectAsync(cs, 1, 2, FD_CONNECT | FD_CLOSE);
        a.stack.connect(cs, b.stack.ip!, 2301);
        await flush();
        expect(bp).toEqual([[ls, FD_ACCEPT]]);
        expect(ap).toEqual([[cs, FD_CONNECT]]);
        const acc = b.stack.accept(ls, b.alloc);
        b.stack.close(acc.id);
        await flush();
        expect(ap[1]).toEqual([cs, FD_CLOSE]);
    });
    test("event select latches mask and per-event error until enumerated", async () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const handles: number[] = [];
        a.stack.hooks = { postMessage() {}, setEvent: h => handles.push(h) };
        const cs = a.sock(1);
        a.stack.selectEvent(cs, 77, FD_CONNECT);
        a.stack.connect(cs, b.stack.ip!, 2398);
        await flush();
        expect(handles).toEqual([77]);
        const ev = a.stack.enumEvents(cs)!;
        expect(ev.mask).toBe(FD_CONNECT);
        expect(ev.errs[4]).toBe(E.CONNREFUSED);
        expect(a.stack.enumEvents(cs)!.mask).toBe(0);
    });
    test("waitChange resolves on data and on timeout", async () => {
        const { a, b, cs, ss } = await connectedPair();
        const w = b.stack.waitChange([ss], -1);
        a.stack.send(cs, bytes("x"));
        await w;
        expect(b.stack.ready(ss).r).toBe(true);
        const t0 = Date.now();
        await a.stack.waitChange([cs], 30);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    });
    test("backlog overflow resets the extra connector; connect timeout fires without a relay", async () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const ls = b.sock(1);
        b.stack.bind(ls, 0, 2302); b.stack.listen(ls, 1);
        const c1 = a.sock(1), c2 = a.sock(1);
        a.stack.connect(c1, b.stack.ip!, 2302);
        a.stack.connect(c2, b.stack.ip!, 2302);
        await flush();
        expect(a.stack.ready(c1).x).toBe(false);
        expect(a.stack.ready(c2).x).toBe(true);

        const dead = new LanStack();
        dead.connectTimeoutMs = 20;
        dead.attachLink({ send() {} });
        dead.onFrame(encode({ op: Op.Welcome, ip: 0xc0a84d09 }));
        dead.create(1, 1);
        dead.connect(1, 0xc0a84d0a, 80);
        await new Promise(r => setTimeout(r, 50));
        expect(dead.getOpt(1, 0xffff, 0x1007)).toBe(E.TIMEDOUT);
    });
    test("loopback TCP works with no relay", async () => {
        const s = new LanStack();
        s.create(1, 1); s.bind(1, 0, 3000); s.listen(1, 1);
        s.create(2, 1);
        expect(s.connect(2, 0x7f000001, 3000)).toBe(E.WOULDBLOCK);
        await flush();
        let next = 10;
        const acc = s.accept(1, () => ++next);
        expect(acc.err).toBe(0);
        s.send(2, bytes("lo"));
        await flush();
        expect(text(s.recv(acc.id, 9, false).data)).toBe("lo");
    });
});

describe("lanRelayUrl", () => {
    const { lanRelayUrl } = require("../../src/net/lan-url");
    test("derives ws/wss from the page origin and rejects bad room names", () => {
        expect(lanRelayUrl({ protocol: "http:", host: "h:5174", search: "?lan=abc" })).toBe("ws://h:5174/lan/abc");
        expect(lanRelayUrl({ protocol: "https:", host: "h", search: "?game=x&lan=A_1-b" })).toBe("wss://h/lan/A_1-b");
        expect(lanRelayUrl({ protocol: "https:", host: "h", search: "?lan=../x" })).toBeNull();
        expect(lanRelayUrl({ protocol: "https:", host: "h", search: "" })).toBeNull();
    });
});
