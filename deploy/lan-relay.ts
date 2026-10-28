/**
 * Virtual-LAN relay: peers in one room share 192.168.77.0/24. Frames are routed by
 * destination IP; the relay rewrites the IP field to the sender's address and keeps no flow
 * state. Transport-agnostic — `serveLan` adapts it to Bun WebSockets.
 */
import { LAN_SUBNET, LAN_MAX_FRAME, ROOM_NAME, Op, decode, encode, isBroadcast } from "../src/net/lan-protocol";

export const MAX_PEERS_PER_ROOM = 32;
export const MAX_ROOMS = 256;
const FIRST_HOST = 2;
const LAST_HOST = 254;

export interface LanPeer {
    readonly ip: number;
    /** Feed one client frame; malformed or oversize frames are dropped. */
    receive(frame: Uint8Array): void;
    leave(): void;
}

type Sink = (frame: Uint8Array) => void;

export class LanRelay {
    private rooms = new Map<string, Map<number, Sink>>();

    /** Returns null when the room name is invalid or the room/server is full. */
    join(room: string, sink: Sink): LanPeer | null {
        if (!ROOM_NAME.test(room)) return null;
        let peers = this.rooms.get(room);
        if (!peers) {
            if (this.rooms.size >= MAX_ROOMS) return null;
            peers = new Map();
            this.rooms.set(room, peers);
        }
        if (peers.size >= MAX_PEERS_PER_ROOM) return null;
        let host = FIRST_HOST;
        while (host <= LAST_HOST && peers.has((LAN_SUBNET | host) >>> 0)) host++;
        const ip = (LAN_SUBNET | host) >>> 0;
        peers.set(ip, sink);
        sink(encode({ op: Op.Welcome, ip }));

        const members = peers;
        return {
            ip,
            receive: (frame) => {
                if (frame.length > LAN_MAX_FRAME) return;
                const msg = decode(frame);
                // Only client→relay ops are routable; a client must not forge Welcome/PeerLeave.
                if (!msg || msg.op === Op.Welcome || msg.op === Op.PeerLeave) return;
                const out = encode({ ...msg, ip } as typeof msg);
                if (isBroadcast(msg.ip)) {
                    if (msg.op !== Op.Udp) return;
                    for (const [peerIp, send] of members) if (peerIp !== ip) send(out);
                    return;
                }
                members.get(msg.ip)?.(out);
            },
            leave: () => {
                if (members.get(ip) !== sink) return;
                members.delete(ip);
                const gone = encode({ op: Op.PeerLeave, ip });
                for (const send of members.values()) send(gone);
                if (members.size === 0 && this.rooms.get(room) === members) this.rooms.delete(room);
            },
        };
    }

    roomCount(): number {
        return this.rooms.size;
    }
}

/** Bun WebSocket handler pair for `Bun.serve`; route `/lan/<room>` to `upgrade`. */
export function serveLan(relay = new LanRelay()) {
    type Data = { room: string; peer: LanPeer | null };
    return {
        upgrade(req: Request, server: { upgrade(req: Request, o: { data: Data }): boolean }): Response | undefined {
            const m = /^\/lan\/([^/]+)$/.exec(new URL(req.url).pathname);
            if (!m) return new Response("Not Found", { status: 404 });
            if (!ROOM_NAME.test(m[1])) return new Response("Bad room", { status: 400 });
            // A browser page on another origin must not be able to join a room.
            const origin = req.headers.get("Origin");
            if (origin && new URL(origin).host !== req.headers.get("Host")) return new Response("Forbidden", { status: 403 });
            if (server.upgrade(req, { data: { room: m[1], peer: null } })) return undefined;
            return new Response("Upgrade failed", { status: 400 });
        },
        websocket: {
            maxPayloadLength: LAN_MAX_FRAME,
            open(ws: { data: Data; send(b: Uint8Array): void; close(code?: number): void }) {
                const peer = relay.join(ws.data.room, (f) => ws.send(f));
                if (!peer) { ws.close(1013); return; }
                ws.data.peer = peer;
            },
            message(ws: { data: Data }, msg: string | Buffer) {
                if (typeof msg === "string") return;
                ws.data.peer?.receive(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
            },
            close(ws: { data: Data }) {
                ws.data.peer?.leave();
            },
        },
    };
}
