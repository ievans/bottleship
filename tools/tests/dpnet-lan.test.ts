import { afterEach, expect, test } from "bun:test";
import { LanRelay } from "../../deploy/lan-relay";
import { LanStack } from "../../src/worker/net/lan-stack";
import { Dp8Engine, type EngineEvent } from "../../src/worker/modules/dpnet/dpnet-engine";
import { LanTransport } from "../../src/worker/modules/dpnet/dpnet-transport";
import { Hr, SendFlag } from "../../src/worker/modules/dpnet/dpnet-constants";
import { ZERO_GUID, type AppDesc } from "../../src/worker/modules/dpnet/dpnet-wire";

const GAME = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const desc = (over: Partial<AppDesc> = {}): AppDesc => ({
    flags: 0, instance: ZERO_GUID, application: GAME, maxPlayers: 0, currentPlayers: 0, sessionName: "LAN",
    password: "", reserved: new Uint8Array(0), appReserved: new Uint8Array(0), ...over,
});

interface Node { stack: LanStack; engine: Dp8Engine; events: EngineEvent[]; leave: () => void }

const nodes: Node[] = [];
afterEach(() => { for (const n of nodes.splice(0)) { n.engine.dispose(); n.leave(); } });

async function node(relay: LanRelay, room: string): Promise<Node> {
    const stack = new LanStack();
    const peer = relay.join(room, f => stack.onFrame(f))!;
    stack.attachLink({ send: f => peer.receive(f) });
    for (let i = 0; i < 50 && stack.ip === null; i++) await sleep(5);
    expect(stack.ip).not.toBeNull();
    const events: EngineEvent[] = [];
    let seed = stack.ip!;
    const engine = new Dp8Engine({
        transport: new LanTransport(stack),
        now: () => performance.now(),
        every: (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
        guid: () => `${(++seed).toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
        rand32: () => (seed = (seed * 1103515245 + 12345) >>> 0),
    }, async ev => { events.push(ev); return { ret: 0 }; });
    const n = { stack, engine, events, leave: () => peer.leave() };
    nodes.push(n);
    return n;
}

test("two guests discover each other by broadcast, connect and exchange data over the relay", async () => {
    const relay = new LanRelay();
    const a = await node(relay, "dp8-1");
    const b = await node(relay, "dp8-1");
    expect(await a.engine.host(desc({ sessionName: "Hosted" }), 6073, false)).toBe(Hr.OK);

    const en = b.engine.enumHosts(GAME, null, new Uint8Array(0), 3, 100, 100, 0, false);
    await en.result;
    const found = b.events.filter(e => e.t === "enumResponse");
    expect(found.length).toBeGreaterThan(0);
    const hit = found[0] as Extract<EngineEvent, { t: "enumResponse" }>;
    expect(hit.desc.sessionName).toBe("Hosted");
    expect(hit.ip).toBe(a.stack.ip!);

    const c = b.engine.connect(hit.desc, hit.ip, hit.port, new Uint8Array(0), 0, true);
    expect(await c.result).toBe(Hr.OK);
    expect(b.engine.players.size).toBe(2);

    b.engine.send(a.engine.localId, new Uint8Array([1, 2, 3]), SendFlag.GUARANTEED, 0, 0, true);
    a.engine.send(0, new Uint8Array([9]), SendFlag.GUARANTEED | SendFlag.NOLOOPBACK, 0, 0, true);
    await sleep(150);
    const aGot = a.events.filter(e => e.t === "receive") as Array<Extract<EngineEvent, { t: "receive" }>>;
    const bGot = b.events.filter(e => e.t === "receive") as Array<Extract<EngineEvent, { t: "receive" }>>;
    expect([...aGot[0]!.data]).toEqual([1, 2, 3]);
    expect([...bGot[0]!.data]).toEqual([9]);
});

test("a host is not discovered across rooms, and does not answer its own broadcast", async () => {
    const relay = new LanRelay();
    const a = await node(relay, "dp8-2");
    const other = await node(relay, "dp8-3");
    await a.engine.host(desc(), 6073, false);
    await other.engine.enumHosts(GAME, null, new Uint8Array(0), 2, 80, 80, 0, false).result;
    expect(other.events.filter(e => e.t === "enumResponse").length).toBe(0);

    await a.engine.enumHosts(GAME, null, new Uint8Array(0), 2, 80, 80, 0, false).result;
    expect(a.events.filter(e => e.t === "enumQuery").length).toBe(0);
});

test("a single guest with no relay can host and be joined over loopback", async () => {
    const stack = new LanStack();
    const mk = () => {
        const events: EngineEvent[] = [];
        let seed = 7;
        const engine = new Dp8Engine({
            transport: new LanTransport(stack),
            now: () => performance.now(),
            every: (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
            guid: () => `${(++seed).toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
            rand32: () => ++seed,
        }, async ev => { events.push(ev); return { ret: 0 }; });
        return { engine, events };
    };
    const h = mk();
    const j = mk();
    expect(await h.engine.host(desc(), 6073, false)).toBe(Hr.OK);
    const op = j.engine.connect(desc(), 0x7f000001, 6073, new Uint8Array(0), 0, true);
    expect(await op.result).toBe(Hr.OK);
    expect(j.engine.players.size).toBe(2);
    h.engine.dispose();
    j.engine.dispose();
});
