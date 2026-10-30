import { describe, expect, test } from "bun:test";
import { LanRelay } from "../../deploy/lan-relay";
import { LanStack } from "../../src/worker/net/lan-stack";
import { LAN_TRACE_CAPACITY, LanTrace } from "../../src/worker/net/lan-trace";
import { Op, encode, ipToString } from "../../src/net/lan-protocol";
import { lanState, lanTrace } from "../../src/worker/harness/cmds/lan";
import { lanStack } from "../../src/worker/net/lan";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const bytes = (s: string) => new TextEncoder().encode(s);

function peer(relay: LanRelay) {
    const stack = new LanStack();
    const p = relay.join("r", (f) => stack.onFrame(f))!;
    stack.attachLink({ send: (f) => p.receive(f) });
    let n = 0;
    return { stack, sock: (type: number) => { stack.create(++n, type); return n; } };
}

describe("LanStack observability", () => {
    test("counters are zero-effect without a tap and count real frames", () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const sa = a.sock(2), sb = b.sock(2);
        b.stack.bind(sb, 0, 7000);
        const before = { ...a.stack.counters };
        expect(a.stack.tap).toBeNull();
        a.stack.sendTo(sa, b.stack.ip!, 7000, bytes("hi"));
        expect(a.stack.counters.sent).toBe(before.sent + 1);
        expect(b.stack.counters.received).toBeGreaterThanOrEqual(2); // welcome(s) + the datagram
        expect(b.stack.recv(sb, 16, false).data.length).toBe(2);
    });

    test("frames with no link are counted as dropped, not sent", () => {
        const s = new LanStack();
        s.ip = 0xc0a84d02;
        s.create(1, 2);
        s.sendTo(1, 0xc0a84dff, 9, bytes("x"));
        expect(s.counters.droppedTx).toBe(1);
        expect(s.counters.sent).toBe(0);
    });

    test("malformed relay frames are counted", () => {
        const s = new LanStack();
        s.onFrame(new Uint8Array([1, 2]));
        expect(s.counters.malformed).toBe(1);
        expect(s.counters.received).toBe(0);
    });

    test("trace records udp both ways with addresses, ports and payload hex", () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const ta = new LanTrace(a.stack);
        a.stack.tap = ta;
        const sa = a.sock(2), sb = b.sock(2);
        b.stack.bind(sb, 0, 7000);
        a.stack.bind(sa, 0, 6000);
        a.stack.sendTo(sa, b.stack.ip!, 7000, bytes("ABC"));
        b.stack.sendTo(sb, a.stack.ip!, 6000, bytes("reply"));
        const e = ta.read(0, 0);
        expect(e.map((x) => x.dir)).toEqual(["tx", "rx"]);
        expect(e[0]).toMatchObject({ proto: "udp", src: `${ipToString(a.stack.ip!)}:6000`, dst: `${ipToString(b.stack.ip!)}:7000`, len: 3, hex: "414243" });
        expect(e[1]).toMatchObject({ dir: "rx", src: `${ipToString(b.stack.ip!)}:7000`, dst: `${ipToString(a.stack.ip!)}:6000`, hex: Buffer.from("reply").toString("hex") });
    });

    test("trace follows a TCP flow: syn, synack, data, fin with resolved ports", async () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const ta = new LanTrace(a.stack);
        a.stack.tap = ta;
        const lis = b.sock(1);
        b.stack.bind(lis, 0, 2000);
        b.stack.listen(lis, 4);
        const c = a.sock(1);
        a.stack.connect(c, b.stack.ip!, 2000);
        await flush();
        a.stack.send(c, bytes("hello"));
        a.stack.shutdown(c, 1);
        const kinds = ta.read(0, 0).map((x) => `${x.dir}:${x.kind}`);
        expect(kinds).toEqual(["tx:syn", "rx:synack", "tx:data", "tx:fin"]);
        const data = ta.read(0, 0).find((x) => x.kind === "data")!;
        expect(data.dst.endsWith(":2000")).toBe(true);
        expect(data.src).toBe(`${ipToString(a.stack.ip!)}:${a.stack.names(c)!.local.port}`);
        expect(data.hex).toBe(Buffer.from("hello").toString("hex"));
        expect(data.cid).toBeDefined();
    });

    test("ring is bounded, keeps seq monotonic, and since/limit/reset work", () => {
        const s = new LanStack();
        s.ip = 0xc0a84d02;
        const t = new LanTrace(s);
        for (let i = 0; i < LAN_TRACE_CAPACITY + 10; i++) t.frame(false, encode({ op: Op.Udp, ip: 0xc0a84d03, srcPort: 1, dstPort: 2, data: bytes("x") }));
        expect(t.size).toBe(LAN_TRACE_CAPACITY);
        expect(t.overwritten).toBe(10);
        expect(t.read(0, 0)[0]!.seq).toBe(10);
        expect(t.read(LAN_TRACE_CAPACITY + 5, 0).map((e) => e.seq)).toEqual([517, 518, 519, 520, 521]);
        expect(t.read(0, 3).map((e) => e.seq)).toEqual([519, 520, 521]);
        const next = t.nextSeq;
        t.clear();
        expect(t.size).toBe(0);
        expect(t.nextSeq).toBe(next);
        expect(t.overwritten).toBe(0);
    });

    test("peers are tracked from received frames and cleared on PeerLeave", () => {
        const relay = new LanRelay();
        const a = peer(relay), b = peer(relay);
        const sa = a.sock(2), sb = b.sock(2);
        b.stack.bind(sb, 0, 7000);
        a.stack.sendTo(sa, b.stack.ip!, 7000, bytes("x"));
        b.stack.sendTo(sb, a.stack.ip!, 49999, bytes("y"));
        expect(b.stack.peers.has(a.stack.ip!)).toBe(true);
        const ipA = a.stack.ip!;
        // Relay PeerLeave to b.
        b.stack.onFrame(encode({ op: Op.PeerLeave, ip: ipA }));
        expect(b.stack.peers.has(ipA)).toBe(false);
    });
});

describe("harness lan verbs", () => {
    test("lanTrace enable/disable attaches and detaches the tap", () => {
        expect(lanStack.tap).toBeNull();
        expect(lanTrace({ enable: true }).enabled).toBe(true);
        expect(lanStack.tap).not.toBeNull();
        expect(lanTrace({ enable: false }).enabled).toBe(false);
        expect(lanStack.tap).toBeNull();
    });

    test("lanState reports a quiet, offline stack", () => {
        const st = lanState();
        expect(st.wanted).toBe(false);
        expect(st.connected).toBe(false);
        expect(st.ip).toBeNull();
        expect(st.sockets).toEqual([]);
    });

    test("lanState lists sockets with dotted endpoints", () => {
        lanStack.ip = 0xc0a84d07;
        lanStack.create(901, 2);
        lanStack.bind(901, 0, 4242);
        try {
            const st = lanState();
            expect(st.ip).toBe("192.168.77.7");
            expect(st.sockets.find((s) => s.id === 901)).toMatchObject({ type: "udp", local: { port: 4242 }, remote: null });
        } finally {
            lanStack.close(901);
            lanStack.ip = null;
        }
    });
});
