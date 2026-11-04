#!/usr/bin/env bun
/**
 * Synthetic DirectPlay 8 peer on the virtual LAN: a Dp8Engine over a LanPeer's stack, so a game
 * running in a browser tab can host to / join a session without a second emulator.
 *
 *   bun tools/dp8-peer.ts host <name> --room R [--app GUID] [--port 6073] [--ms N] [--send HEX]
 *   bun tools/dp8-peer.ts join --room R [--app GUID] [--ms N] [--send HEX] [--connect-data HEX] [--enum-reply HEX] [--linger MS]
 *
 * Both are exported as functions. The result lists the engine events seen (receive payloads in hex).
 * `join` enumerates by broadcast, connects to the first host found and exits 1 if there is none.
 */
import { LanPeer, DEFAULT_RELAY, type PeerOptions } from "./lan-peer";
import { Dp8Engine, type EngineEvent } from "../src/worker/modules/dpnet/dpnet-engine";
import { LanTransport } from "../src/worker/modules/dpnet/dpnet-transport";
import { Hr, SendFlag } from "../src/worker/modules/dpnet/dpnet-constants";
import { ZERO_GUID, type AppDesc } from "../src/worker/modules/dpnet/dpnet-wire";

export interface Dp8PeerOptions extends PeerOptions {
    app?: string;
    sendHex?: string;
    connectHex?: string;
    enumReplyHex?: string;
    port?: number;
    /** Stop this many ms after the first remote player (host) / first received payload (join) is seen (default: run for `ms`). */
    linger?: number;
}
export interface Dp8PeerResult {
    self: string;
    ok: boolean;
    reason: string;
    session: AppDesc | null;
    players: number;
    events: string[];
    received: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function desc(app: string, name: string, over: Partial<AppDesc> = {}): AppDesc {
    return { flags: 0, instance: ZERO_GUID, application: app, maxPlayers: 0, currentPlayers: 0, sessionName: name,
        password: "", reserved: new Uint8Array(0), appReserved: new Uint8Array(0), ...over };
}

type Found = Extract<EngineEvent, { t: "enumResponse" }>;

async function open(o: Dp8PeerOptions): Promise<{ peer: LanPeer; engine: Dp8Engine; events: string[]; received: string[]; found: Found[] }> {
    const peer = await LanPeer.join({ relay: DEFAULT_RELAY, ...o });
    const events: string[] = [];
    const received: string[] = [];
    const found: Found[] = [];
    const engine = new Dp8Engine({
        transport: new LanTransport(peer.stack),
        now: () => performance.now(),
        every: (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
        guid: () => crypto.randomUUID(),
        rand32: () => crypto.getRandomValues(new Uint32Array(1))[0]!,
    }, async (ev) => {
        events.push(ev.t);
        if (ev.t === "receive") received.push(hex(ev.data));
        if (ev.t === "enumResponse") found.push(ev);
        if (ev.t === "enumQuery" && o.enumReplyHex) return { ret: 0, reply: new Uint8Array(Buffer.from(o.enumReplyHex, "hex")) };
        return { ret: 0 };
    });
    return { peer, engine, events, received, found };
}

function summary(peer: LanPeer, engine: Dp8Engine, events: string[], received: string[], ok: boolean, reason: string): Dp8PeerResult {
    return { self: peer.self, ok, reason, session: engine.getApplicationDesc(), players: engine.players.size, events, received };
}

export async function dp8Host(name: string, o: Dp8PeerOptions): Promise<Dp8PeerResult> {
    const { peer, engine, events, received } = await open(o);
    try {
        const hr = await engine.host(desc(o.app ?? ZERO_GUID, name), o.port ?? 6073, o.port !== undefined);
        if (hr !== Hr.OK) return summary(peer, engine, events, received, false, `Host failed: 0x${(hr >>> 0).toString(16)}`);
        peer.log(`hosting "${name}" at ${peer.self}`);
        const end = Date.now() + (o.ms ?? 10000);
        let sent = false;
        let stopAt = end;
        while (Date.now() < stopAt) {
            if (engine.players.size > 1 && stopAt === end && o.linger !== undefined) stopAt = Math.min(end, Date.now() + o.linger);
            if (!sent && o.sendHex && engine.players.size > 1) {
                engine.send(0, Buffer.from(o.sendHex, "hex"), SendFlag.GUARANTEED | SendFlag.NOLOOPBACK, 0, 0, false);
                sent = true;
            }
            await sleep(100);
        }
        return summary(peer, engine, events, received, engine.players.size > 1, engine.players.size > 1 ? "" : "no peer joined");
    } finally { engine.dispose(); }
}

export async function dp8Join(o: Dp8PeerOptions): Promise<Dp8PeerResult> {
    const { peer, engine, events, received, found } = await open(o);
    try {
        const end = Date.now() + (o.ms ?? 10000);
        while (found.length === 0 && Date.now() < end) {
            await engine.enumHosts(o.app ?? ZERO_GUID, null, new Uint8Array(0), 2, 400, 800, 0, false).result;
        }
        const hit = found[0];
        if (!hit) return summary(peer, engine, events, received, false, "no host answered the enumeration");
        peer.log(`found "${hit.desc.sessionName}" app=${hit.desc.application} at ${hit.ip}:${hit.port} reply=${hex(hit.data)}`);
        const hr = await engine.connect(hit.desc, hit.ip, hit.port, o.connectHex ? new Uint8Array(Buffer.from(o.connectHex, "hex")) : new Uint8Array(0), 0, true).result;
        if (hr !== Hr.OK) return summary(peer, engine, events, received, false, `Connect failed: 0x${(hr >>> 0).toString(16)}`);
        let sent = false;
        let stopAt = end;
        while (Date.now() < stopAt) {
            if (received.length > 0 && stopAt === end && o.linger !== undefined) stopAt = Math.min(end, Date.now() + o.linger);
            if (!sent && o.sendHex) {
                engine.send(0, Buffer.from(o.sendHex, "hex"), SendFlag.GUARANTEED | SendFlag.NOLOOPBACK, 0, 0, false);
                sent = true;
            }
            await sleep(100);
        }
        const r = summary(peer, engine, events, received, true, "");
        r.session = hit.desc;
        return r;
    } finally { engine.dispose(); }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
    const room = flag("room");
    const cmd = args[0];
    if (!room || (cmd !== "host" && cmd !== "join")) {
        console.error("usage: dp8-peer.ts host <name>|join --room R [--relay URL] [--app GUID] [--port N] [--ms N] [--send HEX] [--connect-data HEX] [--enum-reply HEX] [--linger MS]");
        process.exit(2);
    }
    const o: Dp8PeerOptions = {
        room, relay: flag("relay"), app: flag("app"), sendHex: flag("send"), connectHex: flag("connect-data"), enumReplyHex: flag("enum-reply"),
        port: flag("port") ? Number(flag("port")) : undefined, linger: flag("linger") ? Number(flag("linger")) : undefined, ms: flag("ms") ? Number(flag("ms")) : undefined,
    };
    const r = cmd === "host" ? await dp8Host(args[1] && !args[1].startsWith("--") ? args[1] : "Synthetic", o) : await dp8Join(o);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
}
