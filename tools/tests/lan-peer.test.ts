import { describe, expect, test } from "bun:test";
import { LanRelay } from "../../deploy/lan-relay";
import {
    Capture, Connect, LanPeer, connectTcp, listenTcp, listenUdp, parseCaptureFile, parseHex, parseIp,
    parsePayload, relayUrl, replay, sendUdp, sniff,
} from "../lan-peer";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const silent = () => {};

/** Same shape as the WebSocket transport, over an in-process relay. */
function wire(relay: LanRelay, room: string): Connect {
    return async onFrame => {
        const p = relay.join(room, onFrame)!;
        return { send: f => p.receive(f), close: () => p.leave() };
    };
}

function room(relay: LanRelay, name: string) {
    return { room: name, connect: wire(relay, name), log: silent };
}

describe("lan-peer argument parsing", () => {
    test("addresses, payloads and relay urls", () => {
        expect(parseIp("192.168.77.3")).toBe(0xc0a84d03);
        expect(parseIp("broadcast")).toBe(0xffffffff);
        expect(parseIp("192.168.77.256")).toBeNull();
        expect(parseIp("nope")).toBeNull();
        expect([...parseHex("de:ad be ef")!]).toEqual([0xde, 0xad, 0xbe, 0xef]);
        expect(parseHex("abc")).toBeNull();
        expect(parsePayload("hex:4142")).toEqual({ data: new Uint8Array([65, 66]), how: "hex" });
        expect(parsePayload("beef").how).toBe("hex");
        expect(parsePayload("hello").how).toBe("text");
        expect(parsePayload("text:beef").how).toBe("text");
        expect(relayUrl("ws://127.0.0.1:5175/", "r1")).toBe("ws://127.0.0.1:5175/lan/r1");
        expect(relayUrl("wss://h/lan/other", "r1")).toBe("wss://h/lan/other");
    });
    test("capture files tolerate blank lines and comments", () => {
        const lines = parseCaptureFile('# note\n\n{"t":5,"op":"udp","ip":"192.168.77.2","srcPort":1,"dstPort":2,"len":1,"hex":"41"}\n');
        expect(lines).toEqual([{ t: 5, op: "udp", ip: "192.168.77.2", srcPort: 1, dstPort: 2, len: 1, hex: "41" }]);
    });
});

describe("lan-peer over a relay", () => {
    test("joins with a 192.168.77.x address and sees a UDP broadcast", async () => {
        const relay = new LanRelay();
        const listening = listenUdp({ ...room(relay, "udp1"), port: 7777, ms: 300, expectMinBytes: 5 });
        await sleep(20);
        const sent = await sendUdp({ ...room(relay, "udp1"), dest: "broadcast", port: 7777, payload: "text:hello" });
        const got = await listening;
        expect(got.ip).toBe("192.168.77.2");
        expect(sent.ip).toBe("192.168.77.3");
        expect(got.ok).toBe(true);
        expect(got.events.map(e => [e.ip, e.dstPort, e.hex])).toEqual([["192.168.77.3", 7777, "68656c6c6f"]]);
        expect(got.from).toEqual(["192.168.77.3"]);
    });

    test("unicast reaches the bound port and a reply goes back to the sender", async () => {
        const relay = new LanRelay();
        const listening = listenUdp({ ...room(relay, "udp2"), port: 7000, ms: 300, replyHex: "4f4b" });
        await sleep(20);
        const sent = await sendUdp({ ...room(relay, "udp2"), dest: "192.168.77.2", port: 7000, payload: "hex:0102", ms: 150 });
        await listening;
        expect(sent.events.map(e => [e.ip, e.hex])).toEqual([["192.168.77.2", "4f4b"]]);
    });

    test("unmet expectations fail with a stated reason", async () => {
        const relay = new LanRelay();
        const quiet = await listenUdp({ ...room(relay, "udp3"), port: 7001, ms: 30, expectFrom: "192.168.77.9" });
        expect(quiet.ok).toBe(false);
        expect(quiet.reason).toContain("192.168.77.9");
        const short = await listenUdp({ ...room(relay, "udp3"), port: 7002, ms: 30, expectMinBytes: 4 });
        expect(short.reason).toContain("got 0");
    });

    test("TCP connect, inbound bytes and an echoed reply", async () => {
        const relay = new LanRelay();
        const listening = listenTcp({ ...room(relay, "tcp1"), port: 2300, ms: 400, replyHex: "6f6b" });
        await sleep(20);
        const client = await connectTcp({ ...room(relay, "tcp1"), ip: "192.168.77.2", port: 2300, payload: "text:ping", ms: 150 });
        const server = await listening;
        expect(server.events.map(e => [e.op, e.ip, e.hex])).toEqual([
            ["accept", "192.168.77.3", ""],
            ["data", "192.168.77.3", "70696e67"],
        ]);
        expect(server.bytes).toBe(4);
        expect(client.events.map(e => [e.ip, e.hex])).toEqual([["192.168.77.2", "6f6b"]]);
    });

    test("a reply list answers the Nth segment of a connection with the Nth reply", async () => {
        const relay = new LanRelay();
        const listening = listenTcp({ ...room(relay, "seq"), port: 2301, ms: 900, replyHex: "aa,,bbcc" });
        await sleep(20);
        const peer = await LanPeer.join(room(relay, "seq"));
        const cs = peer.socket(1);
        peer.stack.connect(cs, parseIp("192.168.77.2")!, 2301);
        expect(await peer.awaitConnect(cs, 300)).toBe(0);
        const got: string[] = [];
        for (const b of [1, 2, 3, 4]) {
            peer.stack.send(cs, new Uint8Array([b]));
            await sleep(150);
            const r = peer.stack.recv(cs, 16, false);
            got.push(r.err === 0 ? Buffer.from(r.data).toString("hex") : "");
        }
        peer.leave();
        await listening;
        expect(got).toEqual(["aa", "", "bbcc", ""]);
    });

    test("sniff logs delivered frames as JSON lines without binding a socket", async () => {
        const relay = new LanRelay();
        const lines: string[] = [];
        const sniffing = sniff({ ...room(relay, "sniff1"), onLine: l => lines.push(l), ms: 300 });
        await sleep(20);
        await sendUdp({ ...room(relay, "sniff1"), dest: "broadcast", port: 1234, payload: "hex:aabb" });
        const got = await sniffing;
        expect(got.events.filter(e => e.op === "udp").map(e => [e.ip, e.dstPort, e.hex])).toEqual([["192.168.77.3", 1234, "aabb"]]);
        expect(got.events.map(e => e.op)).toContain("peerLeave");
        expect(JSON.parse(lines[0]).hex).toBe("aabb");
    });

    test("replay re-emits a captured datagram from the recorded source port", async () => {
        const relay = new LanRelay();
        const capture: Capture[] = [{ t: 0, op: "udp", ip: "192.168.77.9", srcPort: 1234, dstPort: 7100, len: 2, hex: "4142" }];
        const listening = listenUdp({ ...room(relay, "rp1"), port: 7100, ms: 300 });
        await sleep(20);
        await replay({ ...room(relay, "rp1"), lines: capture, fast: true });
        const got = await listening;
        expect(got.events.map(e => [e.ip, e.srcPort, e.hex])).toEqual([["192.168.77.3", 1234, "4142"]]);
    });
});
