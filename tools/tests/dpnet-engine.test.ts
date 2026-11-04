import { afterEach, expect, test } from "bun:test";
import { Dp8Engine, type EngineEvent, type EventResult, type Transport } from "../../src/worker/modules/dpnet/dpnet-engine";
import { Hr, SESSION_MIGRATE_HOST, SendFlag, DestroyReason } from "../../src/worker/modules/dpnet/dpnet-constants";
import { ZERO_GUID, type AppDesc } from "../../src/worker/modules/dpnet/dpnet-wire";

const GAME = "11111111-2222-3333-4444-555555555555";

class Net {
    clock = 1000;
    ticks: Array<() => void> = [];
    nodes: MemTransport[] = [];
    dropIf: ((from: MemTransport, to: MemTransport, n: number) => boolean) | null = null;
    sent = 0;

    advance(ms: number): void {
        for (let left = ms; left > 0; left -= 50) {
            this.clock += Math.min(50, left);
            for (const t of [...this.ticks]) t();
        }
    }
}

class MemTransport implements Transport {
    port = 0;
    onReceive: ((ip: number, port: number, data: Uint8Array) => void) | null = null;
    constructor(private net: Net, readonly ip: number) { net.nodes.push(this); }

    bind(port: number): number {
        if (port && this.net.nodes.some(n => n !== this && n.ip === this.ip && n.port === port)) return 0;
        this.port = port || 20000 + this.net.nodes.indexOf(this) * 100 + Math.floor(Math.random() * 50);
        return this.port;
    }
    private deliver(to: MemTransport, data: Uint8Array): void {
        if (this.net.dropIf?.(this, to, this.net.sent++)) return;
        const copy = data.slice();
        queueMicrotask(() => to.onReceive?.(this.ip, this.port, copy));
    }
    send(ip: number, port: number, data: Uint8Array): void {
        for (const n of this.net.nodes) if (n.ip === ip && n.port === port) this.deliver(n, data);
    }
    broadcast(port: number, data: Uint8Array): void {
        for (const n of this.net.nodes) if (n.port === port && n !== this) this.deliver(n, data);
    }
    close(): void { this.port = 0; }
}

interface Peer {
    engine: Dp8Engine;
    events: EngineEvent[];
    ip: number;
    answer: (ev: EngineEvent) => EventResult;
}

const engines: Dp8Engine[] = [];
afterEach(() => { for (const e of engines.splice(0)) e.dispose(); });

function peer(net: Net, ip: number): Peer {
    const events: EngineEvent[] = [];
    const p: Peer = { engine: null as unknown as Dp8Engine, events, ip, answer: () => ({ ret: 0 }) };
    let seed = ip;
    const engine = new Dp8Engine({
        transport: new MemTransport(net, ip),
        now: () => net.clock,
        every: (_ms, fn) => { net.ticks.push(fn); return () => { net.ticks.splice(net.ticks.indexOf(fn), 1); }; },
        guid: () => `${(++seed).toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
        rand32: () => (seed = (seed * 1103515245 + 12345) >>> 0),
    }, async ev => { events.push(ev); return p.answer(ev); });
    engines.push(engine);
    p.engine = engine;
    return p;
}

const desc = (over: Partial<AppDesc> = {}): AppDesc => ({
    flags: 0, instance: ZERO_GUID, application: GAME, maxPlayers: 0, currentPlayers: 0, sessionName: "Test",
    password: "", reserved: new Uint8Array(0), appReserved: new Uint8Array(0), ...over,
});

const settle = async (net: Net, ms = 0): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
    if (ms) net.advance(ms);
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
};

const kinds = (p: Peer): string[] => p.events.map(e => e.t);
const of = <T extends EngineEvent["t"]>(p: Peer, t: T): Array<Extract<EngineEvent, { t: T }>> =>
    p.events.filter((e): e is Extract<EngineEvent, { t: T }> => e.t === t);

async function session(net: Net, n: number, hostDesc = desc()): Promise<Peer[]> {
    const peers = Array.from({ length: n }, (_, i) => peer(net, 100 + i));
    expect(await peers[0]!.engine.host(hostDesc, 6073, false)).toBe(Hr.OK);
    for (const p of peers.slice(1)) {
        const op = p.engine.connect(desc(), peers[0]!.ip, 6073, new Uint8Array([7]), 0, true);
        await settle(net);
        expect(await op.result).toBe(Hr.OK);
        await settle(net);
    }
    return peers;
}

test("host reports itself as a local host player", async () => {
    const net = new Net();
    const [a] = await session(net, 1);
    const created = of(a!, "createPlayer");
    expect(created.length).toBe(1);
    expect(created[0]!.player.local).toBe(true);
    expect(a!.engine.isHost).toBe(true);
    expect(a!.engine.localPort).toBe(6073);
});

test("enumeration finds the host, answers with its description, and completes after the retry count", async () => {
    const net = new Net();
    const [host] = await session(net, 1, desc({ sessionName: "Lobby", maxPlayers: 4 }));
    const seeker = peer(net, 200);
    const op = seeker.engine.enumHosts(GAME, null, new Uint8Array([9]), 2, 100, 100, 77, false);
    await settle(net);
    const found = of(seeker, "enumResponse");
    expect(found.length).toBe(1);
    expect(found[0]!.desc.sessionName).toBe("Lobby");
    expect(found[0]!.desc.maxPlayers).toBe(4);
    expect(found[0]!.port).toBe(6073);
    expect(of(host!, "enumQuery")[0]!.data).toEqual(new Uint8Array([9]));
    await settle(net, 400);
    expect(await op.result).toBe(Hr.OK);
    const done = of(seeker, "asyncComplete");
    expect(done.length).toBe(1);
    expect(done[0]!.ctx).toBe(77);
});

test("enumeration ignores a different application and honors a refusing query callback", async () => {
    const net = new Net();
    const [host] = await session(net, 1);
    const other = peer(net, 201);
    other.engine.enumHosts("99999999-0000-0000-0000-000000000000", null, new Uint8Array(0), 1, 100, 100, 0, false);
    await settle(net, 300);
    expect(of(other, "enumResponse").length).toBe(0);

    host!.answer = ev => ({ ret: ev.t === "enumQuery" ? Hr.E_FAIL : 0 });
    const third = peer(net, 202);
    third.engine.enumHosts(GAME, null, new Uint8Array(0), 1, 100, 100, 0, false);
    await settle(net, 300);
    expect(of(third, "enumResponse").length).toBe(0);
});

test("connect hands the joiner every existing player and tells everyone about the newcomer", async () => {
    const net = new Net();
    const [a, b, c] = await session(net, 3);
    expect([...a!.engine.players.keys()].length).toBe(3);
    expect([...b!.engine.players.keys()].sort()).toEqual([...a!.engine.players.keys()].sort());
    expect([...c!.engine.players.keys()].sort()).toEqual([...a!.engine.players.keys()].sort());
    expect(c!.engine.hostId).toBe(a!.engine.localId);

    const cEvents = of(c!, "createPlayer").map(e => e.player.id);
    expect(cEvents[0]).toBe(a!.engine.localId);
    expect(cEvents[cEvents.length - 1]).toBe(c!.engine.localId);
    expect(of(b!, "createPlayer").some(e => e.player.id === c!.engine.localId)).toBe(true);
    expect(of(a!, "indicateConnect").length).toBe(2);
    expect(of(a!, "indicateConnect")[0]!.data).toEqual(new Uint8Array([7]));
});

test("async connect posts CONNECT_COMPLETE after the player events; sync connect does not", async () => {
    const net = new Net();
    const [a] = await session(net, 1);
    const j = peer(net, 150);
    j.engine.setPeerInfo("Joiner", new Uint8Array([1, 2]));
    const op = j.engine.connect(desc(), a!.ip, 6073, new Uint8Array(0), 55, false);
    expect(op.hr).toBe(Hr.OK);
    await settle(net);
    expect(await op.result).toBe(Hr.OK);
    const k = kinds(j);
    expect(k[k.length - 1]).toBe("connectComplete");
    expect(k.indexOf("createPlayer")).toBeLessThan(k.indexOf("connectComplete"));
    const complete = of(j, "connectComplete")[0]!;
    expect(complete.ctx).toBe(55);
    expect(complete.localId).toBe(j.engine.localId);
    const seen = [...a!.engine.players.values()].find(p => !p.local)!;
    expect(seen.name).toBe("Joiner");
    expect(seen.data).toEqual(new Uint8Array([1, 2]));
});

test("connect is refused for a wrong password, a full session, a wrong application and a host veto", async () => {
    const net = new Net();
    const [a] = await session(net, 1, desc({ password: "secret", maxPlayers: 2 }));
    const wrongPw = peer(net, 160);
    let op = wrongPw.engine.connect(desc({ password: "nope" }), a!.ip, 6073, new Uint8Array(0), 0, true);
    await settle(net);
    expect(await op.result).toBe(Hr.INVALIDPASSWORD);
    expect(wrongPw.engine.session).toBe("none");

    const wrongApp = peer(net, 161);
    op = wrongApp.engine.connect(desc({ password: "secret", application: "99999999-0000-0000-0000-000000000000" }), a!.ip, 6073, new Uint8Array(0), 0, true);
    await settle(net);
    expect(await op.result).toBe(Hr.INVALIDAPPLICATION);

    a!.answer = ev => ({ ret: ev.t === "indicateConnect" ? Hr.E_FAIL : 0 });
    const vetoed = peer(net, 162);
    op = vetoed.engine.connect(desc({ password: "secret" }), a!.ip, 6073, new Uint8Array(0), 0, true);
    await settle(net);
    expect(await op.result).toBe(Hr.HOSTREJECTEDCONNECTION);

    a!.answer = () => ({ ret: 0 });
    const ok = peer(net, 163);
    op = ok.engine.connect(desc({ password: "secret" }), a!.ip, 6073, new Uint8Array(0), 0, true);
    await settle(net);
    expect(await op.result).toBe(Hr.OK);
    const full = peer(net, 164);
    op = full.engine.connect(desc({ password: "secret" }), a!.ip, 6073, new Uint8Array(0), 0, true);
    await settle(net);
    expect(await op.result).toBe(Hr.SESSIONFULL);
});

test("connect to nothing times out with NORESPONSE and can be cancelled", async () => {
    const net = new Net();
    const j = peer(net, 170);
    const op = j.engine.connect(desc(), 0x0a000001, 6073, new Uint8Array(0), 3, false);
    await settle(net, 21000);
    expect(await op.result).toBe(Hr.NORESPONSE);
    expect(of(j, "connectComplete")[0]!.hr).toBe(Hr.NORESPONSE);
    expect(j.engine.session).toBe("none");

    const op2 = j.engine.connect(desc(), 0x0a000001, 6073, new Uint8Array(0), 4, true);
    expect(j.engine.cancel(op2.handle, 0)).toBe(Hr.OK);
    expect(await op2.result).toBe(Hr.USERCANCEL);
});

test("guaranteed send is delivered once, in order, and completes", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    const bId = b!.engine.localId;
    const ops = [1, 2, 3].map(i => a!.engine.send(bId, new Uint8Array([i]), SendFlag.GUARANTEED, 0, 100 + i, false));
    expect(ops.every(o => o.hr === Hr.PENDING)).toBe(true);
    await settle(net);
    expect(of(b!, "receive").map(e => e.data[0])).toEqual([1, 2, 3]);
    expect(of(b!, "receive")[0]!.from.id).toBe(a!.engine.localId);
    expect(of(a!, "sendComplete").map(e => e.ctx)).toEqual([101, 102, 103]);
    expect(a!.engine.sendQueueInfo(bId)).toEqual({ messages: 0, bytes: 0 });
});

test("guaranteed delivery survives heavy loss and keeps order", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    let rng = 12345;
    net.dropIf = () => ((rng = (rng * 1103515245 + 12345) >>> 0) >>> 16) % 5 < 2;
    const bId = b!.engine.localId;
    for (let i = 0; i < 20; i++) a!.engine.send(bId, new Uint8Array([i]), SendFlag.GUARANTEED, 0, 0, false);
    for (let i = 0; i < 30; i++) await settle(net, 300);
    expect(of(b!, "receive").map(e => e.data[0])).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(a!.engine.connectionInfo(bId)!.retriedPackets).toBeGreaterThan(0);
});

test("a large guaranteed message is fragmented and reassembled intact", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    const big = Uint8Array.from({ length: 150_000 }, (_, i) => (i * 7) & 0xff);
    const op = a!.engine.send(b!.engine.localId, big, SendFlag.GUARANTEED, 0, 0, true);
    await settle(net);
    expect(await op.result).toBe(Hr.OK);
    const got = of(b!, "receive");
    expect(got.length).toBe(1);
    expect(got[0]!.data.length).toBe(big.length);
    expect(got[0]!.data.every((v, i) => v === big[i])).toBe(true);
});

test("non-guaranteed send arrives as one datagram; a sender cannot be spoofed from another endpoint", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    a!.engine.send(b!.engine.localId, new Uint8Array([5, 6]), 0, 0, 0, true);
    await settle(net);
    expect(of(b!, "receive")[0]!.data).toEqual(new Uint8Array([5, 6]));

    const intruder = peer(net, 230);
    intruder.engine.ensureBound();
    const t = (intruder.engine as unknown as { t: Transport }).t;
    const forged = new Uint8Array([0x44, 0x38, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    t.send(b!.ip, b!.engine.localPort, forged);
    await settle(net);
    expect(of(b!, "receive").length).toBe(1);
});

test("send to all players loops back unless NOLOOPBACK; unknown targets fail", async () => {
    const net = new Net();
    const [a, b, c] = await session(net, 3);
    a!.engine.send(0, new Uint8Array([1]), SendFlag.GUARANTEED, 0, 0, true);
    a!.engine.send(0, new Uint8Array([2]), SendFlag.GUARANTEED | SendFlag.NOLOOPBACK, 0, 0, true);
    await settle(net);
    expect(of(a!, "receive").map(e => e.data[0])).toEqual([1]);
    expect(of(a!, "receive")[0]!.from.local).toBe(true);
    expect(of(b!, "receive").map(e => e.data[0])).toEqual([1, 2]);
    expect(of(c!, "receive").map(e => e.data[0])).toEqual([1, 2]);
    expect(a!.engine.send(0xdead, new Uint8Array(1), 0, 0, 0, true).hr).toBe(Hr.INVALIDPLAYER);
    expect(peer(net, 240).engine.send(1, new Uint8Array(1), 0, 0, 0, true).hr).toBe(Hr.NOCONNECTION);
});

test("a send whose timeout elapses before the peer acks completes with TIMEDOUT", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    net.dropIf = () => true;
    const op = a!.engine.send(b!.engine.localId, new Uint8Array([1]), SendFlag.GUARANTEED, 500, 9, false);
    await settle(net, 700);
    expect(await op.result).toBe(Hr.TIMEDOUT);
    expect(of(a!, "sendComplete")[0]!.hr).toBe(Hr.TIMEDOUT);
});

test("Close tells the others the player left, then destroys local state in order", async () => {
    const net = new Net();
    const [a, b, c] = await session(net, 3);
    const bId = b!.engine.localId;
    const closing = b!.engine.close();
    await settle(net, 400);
    await closing;
    expect(of(a!, "destroyPlayer").map(e => [e.player.id, e.reason])).toEqual([[bId, DestroyReason.NORMAL]]);
    expect(of(c!, "destroyPlayer").some(e => e.player.id === bId)).toBe(true);
    const bDestroyed = of(b!, "destroyPlayer");
    expect(bDestroyed.length).toBe(3);
    expect(bDestroyed[bDestroyed.length - 1]!.player.local).toBe(true);
    expect(b!.engine.session).toBe("none");
    expect(a!.engine.players.size).toBe(2);
});

test("a silent peer is declared lost after the retransmit window", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    const bId = b!.engine.localId;
    net.dropIf = () => true;
    a!.engine.send(bId, new Uint8Array([1]), SendFlag.GUARANTEED, 0, 0, true);
    await settle(net, 16000);
    expect(of(a!, "destroyPlayer").map(e => [e.player.id, e.reason])).toEqual([[bId, DestroyReason.CONNECTIONLOST]]);
    expect(a!.engine.players.size).toBe(1);
});

test("an idle session stays alive on keepalives", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    for (let i = 0; i < 20; i++) await settle(net, 3000);
    expect(of(a!, "destroyPlayer").length).toBe(0);
    expect(of(b!, "destroyPlayer").length).toBe(0);
});

test("host loss without migration terminates the session", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    net.dropIf = (from) => from.ip === a!.ip;
    b!.engine.send(a!.engine.localId, new Uint8Array([1]), SendFlag.GUARANTEED, 0, 0, true);
    await settle(net, 16000);
    expect(of(b!, "destroyPlayer")[0]!.reason).toBe(DestroyReason.CONNECTIONLOST);
    expect(of(b!, "terminate")[0]!.hr).toBe(Hr.CONNECTIONLOST);
    expect(b!.engine.session).toBe("terminated");
});

test("host loss with MIGRATE_HOST elects the lowest remaining id and the new host accepts joiners", async () => {
    const net = new Net();
    const [a, b, c] = await session(net, 3, desc({ flags: SESSION_MIGRATE_HOST }));
    net.dropIf = (from, to) => from.ip === a!.ip || to.ip === a!.ip;
    b!.engine.send(a!.engine.localId, new Uint8Array([1]), SendFlag.GUARANTEED, 0, 0, true);
    c!.engine.send(a!.engine.localId, new Uint8Array([1]), SendFlag.GUARANTEED, 0, 0, true);
    await settle(net, 16000);
    expect(of(b!, "hostMigrate")[0]!.newHost.id).toBe(b!.engine.localId);
    expect(of(c!, "hostMigrate")[0]!.newHost.id).toBe(b!.engine.localId);
    expect(b!.engine.isHost).toBe(true);
    expect(c!.engine.isHost).toBe(false);
    expect(b!.engine.session).toBe("active");

    net.dropIf = null;
    const late = peer(net, 180);
    const op = late.engine.connect(desc(), b!.ip, b!.engine.localPort, new Uint8Array(0), 0, true);
    await settle(net);
    expect(await op.result).toBe(Hr.OK);
    expect(late.engine.players.size).toBe(3);
});

test("TerminateSession reaches every peer and DestroyPeer removes just one", async () => {
    const net = new Net();
    const [a, b, c] = await session(net, 3);
    const cId = c!.engine.localId;
    const kicked = a!.engine.destroyPeer(cId, new Uint8Array([4]));
    await settle(net);
    await settle(net, 400);
    expect(await kicked).toBe(Hr.OK);
    expect(of(c!, "terminate")[0]!.data).toEqual(new Uint8Array([4]));
    expect(of(c!, "terminate")[0]!.hr).toBe(Hr.HOSTTERMINATEDSESSION);
    expect(of(a!, "destroyPlayer")[0]!.reason).toBe(DestroyReason.HOSTDESTROYEDPLAYER);
    expect(b!.engine.players.has(cId)).toBe(false);

    expect(await b!.engine.terminateSession(new Uint8Array(0))).toBe(Hr.NOTHOST);
    const ended = a!.engine.terminateSession(new Uint8Array([8]));
    await settle(net);
    await settle(net, 400);
    expect(await ended).toBe(Hr.OK);
    expect(of(b!, "terminate").some(e => e.data[0] === 8)).toBe(true);
});

test("peer info changes propagate", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    b!.engine.setPeerInfo("Renamed", new Uint8Array([3]));
    await settle(net);
    const seen = a!.engine.players.get(b!.engine.localId)!;
    expect(seen.name).toBe("Renamed");
    expect(of(a!, "peerInfo").length).toBe(1);
});

test("groups replicate membership to every peer", async () => {
    const net = new Net();
    const [a, b, c] = await session(net, 3);
    const g = a!.engine.createGroup(0, "team", new Uint8Array([1]))!;
    await settle(net);
    expect(b!.engine.groups.has(g.id)).toBe(true);
    expect(await a!.engine.groupMember(g.id, b!.engine.localId, true)).toBe(Hr.OK);
    await settle(net);
    expect([...c!.engine.groups.get(g.id)!.members]).toEqual([b!.engine.localId]);

    a!.engine.send(g.id, new Uint8Array([9]), SendFlag.GUARANTEED, 0, 0, true);
    await settle(net);
    expect(of(b!, "receive").length).toBe(1);
    expect(of(c!, "receive").length).toBe(0);

    expect(await a!.engine.setGroupInfo(g.id, "renamed", null)).toBe(Hr.OK);
    await settle(net);
    expect(c!.engine.groups.get(g.id)!.name).toBe("renamed");
    expect(await a!.engine.destroyGroup(g.id)).toBe(Hr.OK);
    await settle(net);
    expect(b!.engine.groups.size).toBe(0);
});

test("application description changes reach the peers", async () => {
    const net = new Net();
    const [a, b] = await session(net, 2);
    expect(await a!.engine.setApplicationDesc(desc({ sessionName: "Renamed", maxPlayers: 8 }))).toBe(Hr.OK);
    await settle(net);
    expect(b!.engine.getApplicationDesc()!.sessionName).toBe("Renamed");
    expect(b!.engine.getApplicationDesc()!.currentPlayers).toBe(2);
    expect(await b!.engine.setApplicationDesc(desc())).toBe(Hr.NOTHOST);
});

test("garbage datagrams are ignored", async () => {
    const net = new Net();
    const [a] = await session(net, 1);
    const t = (a!.engine as unknown as { t: Transport }).t;
    for (const bytes of [[], [1, 2, 3], [0x44, 0x38, 3], [0x44, 0x38, 5, 1, 0, 0, 0], [0x44, 0x38, 4, 0xff, 0xff, 0xff, 0xff]]) {
        t.onReceive!(0x01020304, 99, new Uint8Array(bytes));
    }
    await settle(net);
    expect(a!.engine.session).toBe("active");
});
