import { describe, expect, test } from "bun:test";
import { LanRelay, MAX_CONN_PER_KEY, RATE_BURST_BYTES, originAllowed, serveLan } from "../../deploy/lan-relay";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { LanStack, E, FD_READ, FD_CLOSE } from "../../src/worker/net/lan-stack";
import { createLanExports, PASS } from "../../src/worker/net/lan-exports";
import { WsaSocketTable } from "../../src/worker/modules/wsa-stub-shared";
import { Op, decode, encode } from "../../src/net/lan-protocol";

const flush = () => new Promise<void>(r => setTimeout(r, 0));
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function peer(relay: LanRelay) {
    const stack = new LanStack();
    const sent: Uint8Array[] = [];
    const p = relay.join("r", f => stack.onFrame(f))!;
    stack.attachLink({ send: f => { sent.push(f); p.receive(f); } });
    let n = 0;
    return { stack, p, sent, sock: (type: number) => { const id = ++n; stack.create(id, type); return id; }, alloc: () => ++n };
}

// The relay's own rate limit is out of scope for TCP tests that move megabytes in a few ms.
async function pair(relay = new LanRelay({ burstBytes: 1 << 30 })) {
    const a = peer(relay), b = peer(relay);
    const ls = b.sock(1);
    b.stack.bind(ls, 0, 2300); b.stack.listen(ls, 4);
    const cs = a.sock(1);
    a.stack.connect(cs, b.stack.ip!, 2300);
    await flush();
    const acc = b.stack.accept(ls, b.alloc);
    const syn = decode(a.sent.find(f => f[0] === Op.Syn)!)!;
    return { relay, a, b, cs, ls, ss: acc.id, cid: (syn as { cid: number }).cid };
}

describe("forged frames from a third peer", () => {
    test("Data, Fin, Rst and SynAck for someone else's flow are ignored", async () => {
        const { relay, a, b, cs, ss, cid } = await pair();
        const e = relay.join("r", () => {})!;
        e.receive(encode({ op: Op.Data, ip: a.stack.ip!, cid, dir: 1, data: bytes("INJECT") }));
        e.receive(encode({ op: Op.Fin, ip: a.stack.ip!, cid, dir: 1 }));
        e.receive(encode({ op: Op.Rst, ip: a.stack.ip!, cid, dir: 1 }));
        e.receive(encode({ op: Op.Data, ip: b.stack.ip!, cid, dir: 0, data: bytes("INJECT") }));
        e.receive(encode({ op: Op.Rst, ip: b.stack.ip!, cid, dir: 0 }));
        expect(a.stack.recv(cs, 9, false).err).toBe(E.WOULDBLOCK);
        expect(b.stack.recv(ss, 9, false).err).toBe(E.WOULDBLOCK);
        expect(a.stack.send(cs, bytes("ok"))).toBe(2);
    });
    test("a forged SynAck cannot complete a connect to a host that never answered", () => {
        const relay = new LanRelay();
        const a = peer(relay);
        const e = relay.join("r", () => {})!;
        const cs = a.sock(1);
        a.stack.connect(cs, 0xc0a84d63, 80);
        const syn = decode(a.sent.find(f => f[0] === Op.Syn)!) as { cid: number };
        e.receive(encode({ op: Op.SynAck, ip: a.stack.ip!, cid: syn.cid }));
        expect(a.stack.ready(cs).w).toBe(false);
    });
    test("connection ids are not sequential", () => {
        const relay = new LanRelay();
        const a = peer(relay);
        const cids = [1, 2, 3].map(() => { const s = a.sock(1); a.stack.connect(s, 0xc0a84d63, 80); return (decode(a.sent.at(-1)!) as { cid: number }).cid; });
        expect(cids[1] - cids[0]).not.toBe(1);
    });
});

describe("TCP edge cases", () => {
    test("receive overflow resets both ends instead of dropping bytes mid-stream", async () => {
        const { a, b, cs, ss } = await pair();
        const mib = new Uint8Array(1 << 20);
        let r = 0;
        for (let i = 0; i < 6 && r >= 0; i++) r = a.stack.send(cs, mib);
        await flush();
        expect(b.stack.recv(ss, 1, false).err).toBe(0);      // data queued before the cut-off is intact
        let last = b.stack.recv(ss, 1 << 30, false);
        while (last.data.length) last = b.stack.recv(ss, 1 << 30, false);
        expect(last.err).toBe(E.CONNRESET);
        expect(a.stack.send(cs, bytes("x"))).toBe(-E.CONNRESET);
    });
    test("loopback flow set up before Welcome survives it", async () => {
        const s = new LanStack();
        const sent: Uint8Array[] = [];
        s.attachLink({ send: f => sent.push(f) });
        s.create(1, 1); s.bind(1, 0, 3000); s.listen(1, 1);
        s.create(2, 1);
        s.connect(2, 0x7f000001, 3000);
        await flush();
        const acc = s.accept(1, () => 10);
        expect(acc.err).toBe(0);
        expect(acc.ip).toBe(0x7f000001);
        s.onFrame(encode({ op: Op.Welcome, ip: 0xc0a84d02 }));
        s.send(2, bytes("hi"));
        await flush();
        expect(text(s.recv(10, 9, false).data)).toBe("hi");
        expect(s.names(2)!.remote!.ip).toBe(0x7f000001);
    });
    test("losing the relay link resets remote flows and wakes blocked callers", async () => {
        const { a, cs } = await pair();
        const w = a.stack.waitChange([cs], -1);
        a.stack.attachLink(null);
        await w;
        expect(a.stack.recv(cs, 9, false).err).toBe(E.CONNRESET);
        expect(a.stack.send(cs, bytes("x"))).toBe(-E.CONNRESET);
    });
    test("an address change on reconnect resets flows that used the old address", async () => {
        const { a, cs } = await pair();
        a.stack.onFrame(encode({ op: Op.Welcome, ip: 0xc0a84d20 }));
        expect(a.stack.recv(cs, 9, false).err).toBe(E.CONNRESET);
    });
    test("accepted sockets inherit async select from the listener", async () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const posts: number[][] = [];
        b.stack.hooks = { postMessage: (_h, _m, w, l) => posts.push([w, l]), setEvent() {} };
        const ls = b.sock(1);
        b.stack.bind(ls, 0, 2301); b.stack.listen(ls, 2);
        b.stack.selectAsync(ls, 1, 2, FD_READ | FD_CLOSE | 8);
        const cs = a.sock(1);
        a.stack.connect(cs, b.stack.ip!, 2301);
        await flush();
        const child = b.stack.accept(ls, b.alloc).id;
        posts.length = 0;
        a.stack.send(cs, bytes("d"));
        expect(posts).toEqual([[child, FD_READ]]);
    });
    test("closing while connecting tells the listener; closed flows answer late data with RST", async () => {
        const relay = new LanRelay();
        const a = peer(relay);
        const cs = a.sock(1);
        a.stack.connect(cs, 0xc0a84d63, 80);
        a.stack.close(cs);
        const rst = decode(a.sent.at(-1)!) as { op: number; dir: number };
        expect(rst.op).toBe(Op.Rst);
        expect(rst.dir).toBe(0);

        const { a: a2, b, cs: cs2, ss } = await pair();
        a2.stack.close(cs2);
        expect(b.stack.send(ss, bytes("1"))).toBe(1);
        expect(b.stack.send(ss, bytes("2"))).toBe(-E.CONNRESET);
    });
    test("peeking does not consume or re-arm; a real read does", () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const posts: number[] = [];
        b.stack.hooks = { postMessage: (_h, _m, _w, l) => posts.push(l), setEvent() {} };
        const sa = a.sock(2), sb = b.sock(2);
        b.stack.bind(sb, 0, 4300);
        b.stack.selectAsync(sb, 1, 2, FD_READ);
        a.stack.sendTo(sa, b.stack.ip!, 4300, bytes("1"));
        a.stack.sendTo(sa, b.stack.ip!, 4300, bytes("2"));
        b.stack.recv(sb, 9, true);
        expect(posts.length).toBe(1);
        b.stack.recv(sb, 9, false);
        expect(posts.length).toBe(2);
    });
});

describe("thunk layer", () => {
    const guest = new Uint8Array(1 << 16);
    Mem.bind(() => guest);
    function machine(active = true, relay = new LanRelay()) {
        const m = peer(relay);
        const table = new WsaSocketTable();
        let err = 0;
        const x = createLanExports({ stack: m.stack, table, process: null as never, setError: e => { err = e; }, isActive: () => active, clearEvent() {} });
        const sock = (type: number) => { const s = table.socket(type); m.stack.create(s, type); return s; };
        return { m, table, x, sock, err: () => err, call: (n: string, ...a: number[]) => x[n](null as never, guest, a) };
    }
    const dv = new DataView(guest.buffer);

    test("select does not spin when a watched socket is closed mid-wait", async () => {
        const t = machine();
        const s = t.sock(2);
        t.m.stack.bind(s, 0, 4400);
        dv.setUint32(0x100, 1, true); dv.setUint32(0x104, s, true);
        const p = t.call("select", 0, 0x100, 0, 0, 0) as Promise<number>;   // NULL timeout
        let ticks = 0;
        const iv = setInterval(() => ticks++, 1);
        await flush();
        t.m.stack.close(s);
        expect(await p).toBe(-1);
        clearInterval(iv);
        expect(t.err()).toBe(10038);
    });
    test("SO_RCVTIMEO bounds a blocking recvfrom", async () => {
        const t = machine();
        const s = t.sock(2);
        t.m.stack.bind(s, 0, 4401);
        t.m.stack.setOpt(s, 0xffff, 0x1006, 30);
        const t0 = performance.now();
        expect(await (t.call("recvfrom", s, 0x400, 16, 0, 0, 0) as Promise<number>)).toBe(-1);
        expect(t.err()).toBe(10060);
        expect(performance.now() - t0).toBeGreaterThanOrEqual(25);
    });
    test("an unwritable destination fails with WSAEFAULT and leaves the datagram queued", () => {
        const relay = new LanRelay();
        const a = peer(relay);
        const t = machine(true, relay);
        Mem.bind(() => guest, (addr, size) => addr >= 0 && addr + size <= guest.length);
        const sa = a.sock(2);
        t.m.stack.bind(t.sock(2), 0, 4402);
        a.stack.sendTo(sa, t.m.stack.ip!, 4402, bytes("keep"));
        expect(t.call("recv", 1, 0x7ffffff0, 16, 0)).toBe(-1);
        expect(t.err()).toBe(10014);
        expect(t.m.stack.pendingBytes(1)).toBe(4);
    });
    test("with no LAN configured select defers without touching guest memory", () => {
        const t = machine(false);
        expect(t.call("select", 0, 0xfffffff0, 0, 0, 0)).toBe(PASS);
    });
});

describe("relay limits", () => {
    test("one client address cannot hold more than MAX_CONN_PER_KEY connections", () => {
        const relay = new LanRelay();
        const peers = [];
        for (let i = 0; i < MAX_CONN_PER_KEY; i++) peers.push(relay.join(`room${i}`, () => {}, { key: "1.2.3.4" }));
        expect(peers.every(Boolean)).toBe(true);
        expect(relay.join("x", () => {}, { key: "1.2.3.4" })).toBeNull();
        expect(relay.join("x", () => {}, { key: "5.6.7.8" })).not.toBeNull();
        peers[0]!.leave();
        expect(relay.join("x", () => {}, { key: "1.2.3.4" })).not.toBeNull();
    });
    test("a peer that floods broadcasts is disconnected, charged per recipient", () => {
        let t = 0;
        const relay = new LanRelay({ now: () => t });
        for (let i = 0; i < 9; i++) relay.join("r", () => {});
        let kicked = 0;
        const flooder = relay.join("r", () => {}, { kick: () => kicked++ })!;
        const frame = encode({ op: Op.Udp, ip: 0xffffffff, srcPort: 1, dstPort: 1, data: new Uint8Array(60000) });
        const affordable = Math.floor(RATE_BURST_BYTES / (frame.length * 9));
        for (let i = 0; i < affordable; i++) flooder.receive(frame);
        expect(kicked).toBe(0);
        flooder.receive(frame);
        expect(kicked).toBe(1);
        t += 60000;
        expect(relay.join("r", () => {})).not.toBeNull();
    });
    test("origin handling: same-origin ok, case-insensitive, null/malformed rejected, absent allowed", () => {
        expect(originAllowed("http://Example.com:8080", "example.com:8080")).toBe(true);
        expect(originAllowed("http://evil.test", "example.com")).toBe(false);
        expect(originAllowed("null", "example.com")).toBe(false);
        expect(originAllowed("%%%", "example.com")).toBe(false);
        expect(originAllowed(null, "example.com")).toBe(true);
    });
    test("upgrade routes: bad room, bad origin, accepted", () => {
        const lan = serveLan({ relay: new LanRelay() });
        let upgraded: unknown = null;
        const server = { upgrade: (_r: Request, o: unknown) => { upgraded = o; return true; }, requestIP: () => ({ address: "9.9.9.9" }) };
        const req = (path: string, h: Record<string, string> = {}) => new Request(`http://h${path}`, { headers: { Host: "h", ...h } });
        expect(lan.upgrade(req("/lan/..%2Fx"), server)?.status).toBe(400);
        expect(lan.upgrade(req("/nope"), server)?.status).toBe(404);
        expect(lan.upgrade(req("/lan/ok", { Origin: "null" }), server)?.status).toBe(403);
        expect(lan.upgrade(req("/lan/ok", { Origin: "http://other" }), server)?.status).toBe(403);
        expect(lan.upgrade(req("/lan/ok", { Origin: "http://H" }), server)).toBeUndefined();
        expect((upgraded as { data: { key: string } }).data.key).toBe("9.9.9.9");
    });
    test("X-Forwarded-For is ignored unless the proxy is trusted", () => {
        let data: { key: string } | null = null;
        const server = { upgrade: (_r: Request, o: { data: { key: string } }) => { data = o.data; return true; }, requestIP: () => ({ address: "10.0.0.1" }) };
        const hdr = { Host: "h", "X-Forwarded-For": "8.8.8.8, 10.0.0.1" };
        serveLan({ relay: new LanRelay() }).upgrade(new Request("http://h/lan/a", { headers: hdr }), server);
        expect(data!.key).toBe("10.0.0.1");
        serveLan({ relay: new LanRelay(), trustProxy: true }).upgrade(new Request("http://h/lan/a", { headers: hdr }), server);
        expect(data!.key).toBe("8.8.8.8");
    });
});
