/**
 * Virtual-LAN relay: peers in one room share 192.168.77.0/24. Frames are routed by
 * destination IP; the relay rewrites the IP field to the sender's address and keeps no flow
 * state. Transport-agnostic — `serveLan` adapts it to Bun WebSockets.
 */
import { LAN_SUBNET, LAN_MAX_FRAME, ROOM_NAME, Op, decode, encode, isBroadcast } from "../src/net/lan-protocol";

export const MAX_PEERS_PER_ROOM = 32;
export const MAX_ROOMS = 256;
/** Concurrent connections one client address may hold (override: LAN_MAX_CONN_PER_IP). */
export const MAX_CONN_PER_KEY = 16;
/** Token bucket per peer, in bytes delivered (a broadcast is charged once per recipient). */
export const RATE_BYTES_PER_SEC = 2 << 20;
export const RATE_BURST_BYTES = 4 << 20;
const FIRST_HOST = 2;
const LAST_HOST = 254;

export interface LanPeer {
    readonly ip: number;
    /** Feed one client frame; malformed or oversize frames are dropped. */
    receive(frame: Uint8Array): void;
    leave(): void;
}

type Sink = (frame: Uint8Array) => void;

export interface JoinOptions {
    /** Client address; connections sharing a key count against MAX_CONN_PER_KEY. */
    key?: string;
    /** Called when the relay disconnects the peer (rate limit); the transport must close. */
    kick?: () => void;
}

export interface LanRelayOptions {
    maxConnPerKey?: number;
    rateBytesPerSec?: number;
    burstBytes?: number;
    now?: () => number;
}

export class LanRelay {
    private rooms = new Map<string, Map<number, Sink>>();
    private perKey = new Map<string, number>();
    private readonly maxConnPerKey: number;
    private readonly now: () => number;
    private readonly rate: number;
    private readonly burst: number;

    constructor(opts: LanRelayOptions = {}) {
        this.maxConnPerKey = opts.maxConnPerKey ?? MAX_CONN_PER_KEY;
        this.now = opts.now ?? (() => performance.now());
        this.rate = opts.rateBytesPerSec ?? RATE_BYTES_PER_SEC;
        this.burst = opts.burstBytes ?? RATE_BURST_BYTES;
    }

    /** Returns null when the room name is invalid or the room/server/client is full. */
    join(room: string, sink: Sink, opts: JoinOptions = {}): LanPeer | null {
        if (!ROOM_NAME.test(room)) return null;
        const key = opts.key;
        if (key !== undefined && (this.perKey.get(key) ?? 0) >= this.maxConnPerKey) return null;
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
        if (key !== undefined) this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
        sink(encode({ op: Op.Welcome, ip }));

        const members = peers;
        let tokens = this.burst;
        let last = this.now();
        let left = false;
        const peer: LanPeer = {
            ip,
            receive: (frame) => {
                if (left || frame.length > LAN_MAX_FRAME) return;
                const msg = decode(frame);
                // Only client→relay ops are routable; a client must not forge Welcome/PeerLeave.
                if (!msg || msg.op === Op.Welcome || msg.op === Op.PeerLeave) return;
                const bcast = isBroadcast(msg.ip);
                if (bcast && msg.op !== Op.Udp) return;
                const fanout = bcast ? Math.max(1, members.size - 1) : 1;
                const t = this.now();
                tokens = Math.min(this.burst, tokens + ((t - last) / 1000) * this.rate);
                last = t;
                tokens -= frame.length * fanout;
                // Dropping would corrupt a TCP stream silently, so over-limit means disconnect.
                if (tokens < 0) { opts.kick?.(); peer.leave(); return; }
                const out = encode({ ...msg, ip } as typeof msg);
                if (bcast) {
                    for (const [peerIp, send] of members) if (peerIp !== ip) send(out);
                    return;
                }
                members.get(msg.ip)?.(out);
            },
            leave: () => {
                if (left) return;
                left = true;
                if (key !== undefined) {
                    const n = (this.perKey.get(key) ?? 1) - 1;
                    if (n <= 0) this.perKey.delete(key); else this.perKey.set(key, n);
                }
                if (members.get(ip) !== sink) return;
                members.delete(ip);
                const gone = encode({ op: Op.PeerLeave, ip });
                for (const send of members.values()) send(gone);
                if (members.size === 0 && this.rooms.get(room) === members) this.rooms.delete(room);
            },
        };
        return peer;
    }

    roomCount(): number {
        return this.rooms.size;
    }
}

/** Same-origin check; a missing Origin (non-browser client) is allowed, a malformed one is not. */
export function originAllowed(origin: string | null, host: string | null): boolean {
    if (!origin) return true;
    try {
        return host !== null && new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
        return false;
    }
}

/** Cap key for a client address: an IPv6 host controls its whole /64, so that is the unit. */
export function addressKey(addr: string): string {
    const a = addr.trim().toLowerCase().replace(/%.*$/, "");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return mapped[1];
    if (!a.includes(":")) return a;
    const halves = a.split("::");
    if (halves.length > 2) return a;
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return a;
    return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

export interface LanServeOptions {
    relay?: LanRelay;
    /**
     * Believe the proxy's client-address headers for the per-address cap (only when every request
     * reaches this server through a proxy you control). Without it all clients behind a tunnel
     * share the tunnel's address and its cap.
     */
    trustProxy?: boolean;
}

/** Bun WebSocket handler pair for `Bun.serve`; route `/lan/<room>` to `upgrade`. */
export function serveLan(opts: LanServeOptions = {}) {
    const trustProxy = opts.trustProxy ?? process.env.LAN_TRUST_PROXY === "1";
    const relay = opts.relay ?? new LanRelay({ maxConnPerKey: Number(process.env.LAN_MAX_CONN_PER_IP) || undefined });
    type Data = { room: string; key: string; peer: LanPeer | null };
    type Server = { upgrade(req: Request, o: { data: Data }): boolean; requestIP?(req: Request): { address: string } | null };
    return {
        upgrade(req: Request, server: Server): Response | undefined {
            const m = /^\/lan\/([^/]+)$/.exec(new URL(req.url).pathname);
            if (!m) return new Response("Not Found", { status: 404 });
            if (!ROOM_NAME.test(m[1])) return new Response("Bad room", { status: 400 });
            // A browser page on another origin must not be able to join a room.
            if (!originAllowed(req.headers.get("Origin"), req.headers.get("Host"))) return new Response("Forbidden", { status: 403 });
            // Cloudflare overwrites CF-Connecting-IP, whereas it appends to a client-supplied
            // X-Forwarded-For, so only the former is unforgeable there.
            const fwd = trustProxy
                ? req.headers.get("CF-Connecting-IP")?.trim() || req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
                : undefined;
            const key = addressKey(fwd || server.requestIP?.(req)?.address || "unknown");
            if (server.upgrade(req, { data: { room: m[1], key, peer: null } })) return undefined;
            return new Response("Upgrade failed", { status: 400 });
        },
        websocket: {
            maxPayloadLength: LAN_MAX_FRAME,
            // A reader that falls behind loses frames; for TCP that is silent corruption, so drop it.
            backpressureLimit: 1 << 20,
            closeOnBackpressureLimit: true,
            // Bun pings at half this; a tunnel/CDN drops a WebSocket that stays silent for ~100 s.
            idleTimeout: 60,
            open(ws: { data: Data; send(b: Uint8Array): number; close(code?: number): void }) {
                const peer = relay.join(ws.data.room, (f) => { if (ws.send(f) === 0) ws.close(1013); },
                    { key: ws.data.key, kick: () => ws.close(1008) });
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
