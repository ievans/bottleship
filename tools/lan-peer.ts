#!/usr/bin/env bun
/**
 * Synthetic virtual-LAN peer: joins a relay room (deploy/lan-relay.ts) with the real
 * LanStack and wire protocol, so a game running in a browser tab can be tested against a
 * second "host" that costs a few MB instead of a whole emulator.
 *
 * CLI:
 *   bun tools/lan-peer.ts listen-udp  <port> --room R [--ms N] [--reply-hex H]
 *   bun tools/lan-peer.ts send-udp    <ip|broadcast> <port> <hex|text> --room R [--ms N]
 *   bun tools/lan-peer.ts sniff       --room R [--ms N]
 *   bun tools/lan-peer.ts listen-tcp  <port> --room R [--ms N] [--reply-hex H[,H…]] [--announce-hex H]
 *   bun tools/lan-peer.ts connect-tcp <ip> <port> [hex] --room R [--ms N]
 *   bun tools/lan-peer.ts replay      <file.jsonl> --room R [--to ip|broadcast] [--fast]
 *
 * Common flags: --room <name> (required), --relay <url> (default ws://127.0.0.1:5175),
 *   --ms <n>, --expect-from <ip>, --expect-min-bytes <n> (exit 1 with a stated reason).
 * Every subcommand is also exported as a function taking the same options.
 */
import { Op, decode, ipToString, ROOM_NAME, LIMITED_BROADCAST } from "../src/net/lan-protocol";
import { LanStack, E, SOL_SOCKET, SO_ERROR } from "../src/worker/net/lan-stack";

export const DEFAULT_RELAY = "ws://127.0.0.1:5175";
export const DEFAULT_MS = 10000;
const POLL_MS = 50;
const SOCK_TCP = 1, SOCK_UDP = 2;
const MAX_DGRAM = 65535;

export interface Transport {
    send(frame: Uint8Array): void;
    close(): void;
}
/** Lets a test drive the library over an in-process LanRelay instead of a WebSocket. */
export type Connect = (onFrame: (frame: Uint8Array) => void) => Promise<Transport>;

export interface PeerOptions {
    room: string;
    relay?: string;
    connect?: Connect;
    ms?: number;
    expectFrom?: string;
    expectMinBytes?: number;
    /** Human-readable progress; defaults to stdout, pass () => {} to silence. */
    log?: (line: string) => void;
}

/** One observed datagram, TCP segment or relay frame. Also the `replay` file format. */
export interface Capture {
    t: number;
    op: string;
    ip: string;
    srcPort?: number;
    dstPort?: number;
    cid?: number;
    dir?: number;
    len: number;
    hex: string;
}

export interface PeerResult {
    ip: string | null;
    packets: number;
    bytes: number;
    from: string[];
    events: Capture[];
    ok: boolean;
    reason?: string;
}

// ---- parsing ---------------------------------------------------------------------------

export function parseIp(s: string): number | null {
    if (s === "broadcast") return LIMITED_BROADCAST;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    let ip = 0;
    for (let i = 1; i <= 4; i++) {
        const o = Number(m[i]);
        if (o > 255) return null;
        ip = ((ip << 8) | o) >>> 0;
    }
    return ip;
}

export function parseHex(s: string): Uint8Array | null {
    const h = s.replace(/[\s:-]/g, "");
    if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) return null;
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** `hex:`/`text:` are explicit; a bare even-length hex string is read as hex. */
export function parsePayload(s: string): { data: Uint8Array; how: "hex" | "text" } {
    const enc = (t: string) => new TextEncoder().encode(t);
    if (s.startsWith("hex:")) {
        const d = parseHex(s.slice(4));
        if (!d) throw new Error(`not hex: ${s.slice(4)}`);
        return { data: d, how: "hex" };
    }
    if (s.startsWith("text:")) return { data: enc(s.slice(5)), how: "text" };
    if (s.length >= 2 && /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return { data: parseHex(s)!, how: "hex" };
    return { data: enc(s), how: "text" };
}

export function relayUrl(relay: string, room: string): string {
    const base = relay.replace(/\/+$/, "");
    return /\/lan\/[^/]+$/.test(base) ? base : `${base}/lan/${room}`;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toAscii = (b: Uint8Array) => Array.from(b, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("");

const OP_NAME: Record<number, string> = {
    [Op.Udp]: "udp", [Op.Syn]: "syn", [Op.SynAck]: "synack", [Op.Rst]: "rst",
    [Op.Data]: "data", [Op.Fin]: "fin", [Op.Welcome]: "welcome", [Op.PeerLeave]: "peerLeave",
};

// ---- transport -------------------------------------------------------------------------

/** Bun's WebSocket takes request headers; the DOM lib type does not know about them. */
const BunWebSocket = WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket;

export function wsConnect(url: string): Connect {
    return (onFrame) =>
        new Promise<Transport>((resolve, reject) => {
            const u = new URL(url);
            // The relay refuses an Origin whose host differs from Host.
            const origin = `${u.protocol === "wss:" ? "https" : "http"}://${u.host}`;
            const ws = new BunWebSocket(url, { headers: { Origin: origin } });
            ws.binaryType = "arraybuffer";
            let open = false;
            ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) onFrame(new Uint8Array(e.data)); };
            ws.onopen = () => {
                open = true;
                resolve({ send: (f) => ws.send(f as Uint8Array<ArrayBuffer>), close: () => ws.close() });
            };
            ws.onclose = (e) => { if (!open) reject(new Error(`relay ${url} closed the connection (code ${e.code})`)); };
            ws.onerror = () => { if (!open) reject(new Error(`cannot reach relay at ${url}`)); };
        });
}

// ---- peer ------------------------------------------------------------------------------

let stopped = false;

export class LanPeer {
    readonly stack = new LanStack();
    readonly events: Capture[] = [];
    /** Our virtual-LAN address, kept across `leave()` (which detaches the stack). */
    self = "";
    packets = 0;
    bytes = 0;
    readonly from = new Set<string>();
    /** Set by `sniff` to see every frame the relay delivers, decoded but unfiltered. */
    tap: ((c: Capture) => void) | null = null;

    private transport: Transport | null = null;
    private t0 = Date.now();
    private nextId = 0;

    private constructor(private readonly opts: PeerOptions) {}

    static async join(opts: PeerOptions): Promise<LanPeer> {
        if (!ROOM_NAME.test(opts.room)) throw new Error(`bad room name ${JSON.stringify(opts.room)} (expected ${ROOM_NAME.source})`);
        const p = new LanPeer(opts);
        const connect = opts.connect ?? wsConnect(relayUrl(opts.relay ?? DEFAULT_RELAY, opts.room));
        p.transport = await connect((f) => { p.observe(f); p.stack.onFrame(f); });
        p.stack.attachLink({ send: (f) => p.transport?.send(f) });
        p.t0 = Date.now();
        const end = Date.now() + 5000;
        while (p.stack.ip === null && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
        if (p.stack.ip === null) throw new Error("relay never sent a Welcome frame");
        p.self = ipToString(p.stack.ip);
        p.log(`joined room ${opts.room} as ${p.self}`);
        return p;
    }

    log(line: string): void {
        (this.opts.log ?? ((l: string) => console.log(l)))(line);
    }

    socket(type: number): number {
        const id = ++this.nextId;
        this.stack.create(id, type);
        return id;
    }

    alloc = (): number => ++this.nextId;

    record(c: Omit<Capture, "t">): Capture {
        const full = { t: Date.now() - this.t0, ...c };
        this.events.push(full);
        this.packets++;
        this.bytes += c.len;
        this.from.add(c.ip);
        return full;
    }

    /** Runs `step` now, then on every socket state change until `ms` elapses or `until` holds. */
    async pump(ids: () => number[], ms: number, step: () => void, until?: () => boolean): Promise<void> {
        const end = Date.now() + ms;
        for (;;) {
            step();
            const left = end - Date.now();
            if (left <= 0 || stopped || until?.()) return;
            await this.stack.waitChange(ids().filter((id) => this.stack.has(id)), Math.min(left, POLL_MS));
        }
    }

    async awaitConnect(id: number, ms: number): Promise<number> {
        const end = Date.now() + ms;
        for (;;) {
            if (this.stack.ready(id).w) return 0;
            if (this.stack.ready(id).x) return this.stack.getOpt(id, SOL_SOCKET, SO_ERROR) || E.CONNREFUSED;
            const left = end - Date.now();
            if (left <= 0) return E.TIMEDOUT;
            await this.stack.waitChange([id], Math.min(left, POLL_MS));
        }
    }

    leave(): void {
        this.stack.reset();
        this.stack.attachLink(null);
        this.transport?.close();
        this.transport = null;
    }

    result(): PeerResult {
        const r: PeerResult = {
            ip: this.self || null,
            packets: this.packets, bytes: this.bytes, from: [...this.from], events: this.events, ok: true,
        };
        const want = this.opts.expectFrom;
        if (want && !this.from.has(want)) {
            r.ok = false;
            r.reason = `expected traffic from ${want}, saw ${r.from.join(", ") || "nothing"}`;
        } else if (this.opts.expectMinBytes !== undefined && this.bytes < this.opts.expectMinBytes) {
            r.ok = false;
            r.reason = `expected at least ${this.opts.expectMinBytes} payload bytes, got ${this.bytes}`;
        }
        return r;
    }

    private observe(frame: Uint8Array): void {
        if (!this.tap) return;
        const m = decode(frame);
        if (!m) return;
        const data = m.op === Op.Udp || m.op === Op.Data ? m.data : new Uint8Array(0);
        const c: Capture = {
            t: Date.now() - this.t0,
            op: OP_NAME[m.op] ?? `op${m.op}`,
            ip: ipToString(m.ip),
            len: data.length,
            hex: toHex(data),
        };
        if (m.op === Op.Udp || m.op === Op.Syn) { c.srcPort = m.srcPort; c.dstPort = m.dstPort; }
        if ("cid" in m) c.cid = m.cid;
        if ("dir" in m) c.dir = m.dir;
        this.tap(c);
    }
}

function dump(prefix: string, data: Uint8Array): string {
    return `${prefix}\n  ${toHex(data)}\n  |${toAscii(data)}|`;
}

function mustHex(s: string): Uint8Array {
    const d = parseHex(s);
    if (!d) throw new Error(`--reply-hex: not hex: ${s}`);
    return d;
}

// ---- subcommands -----------------------------------------------------------------------

export interface UdpListenOptions extends PeerOptions { port: number; replyHex?: string }

export async function listenUdp(o: UdpListenOptions): Promise<PeerResult> {
    const peer = await LanPeer.join(o);
    try {
        const reply = o.replyHex ? mustHex(o.replyHex) : null;
        const s = peer.socket(SOCK_UDP);
        const err = peer.stack.bind(s, 0, o.port);
        if (err) throw new Error(`bind UDP ${o.port}: Winsock error ${err}`);
        peer.log(`listening on UDP ${ipToString(peer.stack.ip!)}:${o.port}`);
        await peer.pump(() => [s], o.ms ?? DEFAULT_MS, () => {
            for (;;) {
                const r = peer.stack.recv(s, MAX_DGRAM, false);
                if (r.err === E.WOULDBLOCK) return;
                if (r.err !== 0 && r.err !== E.MSGSIZE) { peer.log(`recv error ${r.err}`); return; }
                peer.record({ op: "udp", ip: ipToString(r.ip), srcPort: r.port, dstPort: o.port, len: r.data.length, hex: toHex(r.data) });
                peer.log(dump(`udp ${ipToString(r.ip)}:${r.port} -> :${o.port}  ${r.data.length} bytes`, r.data));
                if (reply) {
                    const n = peer.stack.sendTo(s, r.ip, r.port, reply);
                    peer.log(n < 0 ? `  reply failed: Winsock error ${-n}` : `  replied ${n} bytes`);
                }
            }
        });
        return peer.result();
    } finally {
        peer.leave();
    }
}

export interface UdpSendOptions extends PeerOptions { dest: string; port: number; payload: string }

export async function sendUdp(o: UdpSendOptions): Promise<PeerResult> {
    const dst = parseIp(o.dest);
    if (dst === null) throw new Error(`bad destination ${o.dest} (dotted quad or "broadcast")`);
    const { data, how } = parsePayload(o.payload);
    const peer = await LanPeer.join(o);
    try {
        const s = peer.socket(SOCK_UDP);
        const berr = peer.stack.bind(s, 0, 0);
        if (berr) throw new Error(`bind ephemeral: Winsock error ${berr}`);
        const src = peer.stack.names(s)!.local.port;
        const n = peer.stack.sendTo(s, dst, o.port, data);
        if (n < 0) throw new Error(`sendto ${o.dest}:${o.port}: Winsock error ${-n}`);
        peer.log(dump(`sent ${n} bytes (${how}) :${src} -> ${o.dest}:${o.port}`, data));
        await peer.pump(() => [s], o.ms ?? 0, () => {
            for (;;) {
                const r = peer.stack.recv(s, MAX_DGRAM, false);
                if (r.err === E.WOULDBLOCK) return;
                if (r.err !== 0 && r.err !== E.MSGSIZE) return;
                peer.record({ op: "udp", ip: ipToString(r.ip), srcPort: r.port, dstPort: src, len: r.data.length, hex: toHex(r.data) });
                peer.log(dump(`reply ${ipToString(r.ip)}:${r.port}  ${r.data.length} bytes`, r.data));
            }
        });
        return peer.result();
    } finally {
        peer.leave();
    }
}

export interface SniffOptions extends PeerOptions {
    /** JSON lines go here; the CLI keeps them on stdout and progress on stderr. */
    onLine?: (json: string) => void;
}

/** Logs every frame the relay delivers to us as JSON lines — no socket needs to be bound. */
export async function sniff(o: SniffOptions): Promise<PeerResult> {
    const peer = await LanPeer.join(o);
    try {
        const line = o.onLine ?? ((s: string) => console.log(s));
        peer.tap = (c) => {
            peer.record(c);
            line(JSON.stringify(c));
        };
        await peer.pump(() => [], o.ms ?? DEFAULT_MS, () => {});
        return peer.result();
    } finally {
        peer.leave();
    }
}

export interface TcpListenOptions extends PeerOptions {
    port: number;
    /** Comma-separated: the Nth inbound segment on a connection gets the Nth reply (empty = none). A single value answers every segment. */
    replyHex?: string;
    /** Also answer every UDP datagram on `announcePort` with this payload, so one peer is both the discovered host and its TCP endpoint. */
    announceHex?: string;
    announcePort?: number;
}

export async function listenTcp(o: TcpListenOptions): Promise<PeerResult> {
    const peer = await LanPeer.join(o);
    try {
        const replies = o.replyHex ? o.replyHex.split(",").map(h => (h.trim() ? mustHex(h) : null)) : [];
        const sent = new Map<number, number>();
        const ls = peer.socket(SOCK_TCP);
        const berr = peer.stack.bind(ls, 0, o.port);
        if (berr) throw new Error(`bind TCP ${o.port}: Winsock error ${berr}`);
        const lerr = peer.stack.listen(ls, 8);
        if (lerr) throw new Error(`listen TCP ${o.port}: Winsock error ${lerr}`);
        peer.log(`listening on TCP ${ipToString(peer.stack.ip!)}:${o.port}`);
        const announce = o.announceHex ? mustHex(o.announceHex) : null;
        let us = -1;
        if (announce) {
            us = peer.socket(SOCK_UDP);
            const uerr = peer.stack.bind(us, 0, o.announcePort ?? 8585);
            if (uerr) throw new Error(`bind UDP ${o.announcePort ?? 8585}: Winsock error ${uerr}`);
        }
        const live: number[] = [];
        await peer.pump(() => (us >= 0 ? [ls, us, ...live] : [ls, ...live]), o.ms ?? DEFAULT_MS, () => {
            while (announce) {
                const r = peer.stack.recv(us, MAX_DGRAM, false);
                if (r.err === E.WOULDBLOCK) break;
                if (r.err !== 0 && r.err !== E.MSGSIZE) break;
                peer.record({ op: "udp", ip: ipToString(r.ip), srcPort: r.port, dstPort: o.announcePort ?? 8585, len: r.data.length, hex: toHex(r.data) });
                peer.log(dump(`udp ${ipToString(r.ip)}:${r.port}  ${r.data.length} bytes`, r.data));
                peer.stack.sendTo(us, r.ip, r.port, announce);
            }
            for (;;) {
                const a = peer.stack.accept(ls, peer.alloc);
                if (a.err) break;
                live.push(a.id);
                peer.record({ op: "accept", ip: ipToString(a.ip), srcPort: a.port, dstPort: o.port, len: 0, hex: "" });
                peer.log(`accepted #${a.id} from ${ipToString(a.ip)}:${a.port}`);
            }
            for (const id of [...live]) {
                for (;;) {
                    const r = peer.stack.recv(id, 1 << 20, false);
                    if (r.err === E.WOULDBLOCK) break;
                    if (r.err !== 0) {
                        peer.log(`#${id} error ${r.err}`);
                        peer.stack.close(id);
                        live.splice(live.indexOf(id), 1);
                        break;
                    }
                    if (r.data.length === 0) {
                        peer.log(`#${id} closed by peer`);
                        peer.stack.close(id);
                        live.splice(live.indexOf(id), 1);
                        break;
                    }
                    peer.record({ op: "data", ip: ipToString(r.ip), srcPort: r.port, dstPort: o.port, len: r.data.length, hex: toHex(r.data) });
                    peer.log(dump(`#${id} ${ipToString(r.ip)}:${r.port}  ${r.data.length} bytes`, r.data));
                    const nth = sent.get(id) ?? 0;
                    sent.set(id, nth + 1);
                    const reply = replies.length === 1 ? replies[0] : (replies[nth] ?? null);
                    if (reply) {
                        const n = peer.stack.send(id, reply);
                        peer.log(n < 0 ? `  reply failed: Winsock error ${-n}` : `  replied ${n} bytes`);
                    }
                }
            }
        });
        return peer.result();
    } finally {
        peer.leave();
    }
}

export interface TcpConnectOptions extends PeerOptions { ip: string; port: number; payload?: string }

export async function connectTcp(o: TcpConnectOptions): Promise<PeerResult> {
    const dst = parseIp(o.ip);
    if (dst === null) throw new Error(`bad address ${o.ip}`);
    const peer = await LanPeer.join(o);
    try {
        const cs = peer.socket(SOCK_TCP);
        const c = peer.stack.connect(cs, dst, o.port);
        if (c !== 0 && c !== E.WOULDBLOCK) throw new Error(`connect ${o.ip}:${o.port}: Winsock error ${c}`);
        const cerr = await peer.awaitConnect(cs, o.ms ?? DEFAULT_MS);
        if (cerr) throw new Error(`connect ${o.ip}:${o.port}: Winsock error ${cerr}`);
        peer.log(`connected to ${o.ip}:${o.port} from :${peer.stack.names(cs)!.local.port}`);
        if (o.payload !== undefined) {
            const { data, how } = parsePayload(o.payload);
            const n = peer.stack.send(cs, data);
            if (n < 0) throw new Error(`send: Winsock error ${-n}`);
            peer.log(dump(`sent ${n} bytes (${how})`, data));
        }
        let done = false;
        await peer.pump(() => [cs], o.ms ?? DEFAULT_MS, () => {
            for (;;) {
                const r = peer.stack.recv(cs, 1 << 20, false);
                if (r.err === E.WOULDBLOCK) return;
                if (r.err !== 0) { peer.log(`recv error ${r.err}`); done = true; return; }
                if (r.data.length === 0) { peer.log("closed by peer"); done = true; return; }
                peer.record({ op: "data", ip: ipToString(r.ip), srcPort: r.port, dstPort: o.port, len: r.data.length, hex: toHex(r.data) });
                peer.log(dump(`${ipToString(r.ip)}:${r.port}  ${r.data.length} bytes`, r.data));
            }
        }, () => done);
        return peer.result();
    } finally {
        peer.leave();
    }
}

export interface ReplayOptions extends PeerOptions { lines: Capture[]; to?: string; fast?: boolean }

/**
 * Re-emits captured UDP datagrams, so traffic a real guest broadcast can be replayed as if
 * from a second host. A capture carries only the sender's address, so the destination
 * defaults to broadcast.
 */
export async function replay(o: ReplayOptions): Promise<PeerResult> {
    const dst = parseIp(o.to ?? "broadcast");
    if (dst === null) throw new Error(`bad --to ${o.to}`);
    const dgrams = o.lines.filter((l) => l.op === "udp" && l.dstPort);
    const peer = await LanPeer.join(o);
    try {
        const ports = new Map<number, number>();
        let last = 0;
        for (const l of dgrams) {
            if (!o.fast && l.t > last) await new Promise((r) => setTimeout(r, Math.min(l.t - last, 2000)));
            last = l.t;
            const data = parseHex(l.hex);
            if (!data) { peer.log(`skipped a line with non-hex payload`); continue; }
            let s = ports.get(l.srcPort ?? 0);
            if (s === undefined) {
                s = peer.socket(SOCK_UDP);
                // Replaying from the captured source port is best-effort: it may be taken.
                if (l.srcPort && peer.stack.bind(s, 0, l.srcPort)) peer.stack.bind(s, 0, 0);
                ports.set(l.srcPort ?? 0, s);
            }
            const n = peer.stack.sendTo(s, dst, l.dstPort!, data);
            if (n < 0) { peer.log(`sendto :${l.dstPort} failed: Winsock error ${-n}`); continue; }
            peer.record({ op: "udp", ip: peer.self, srcPort: peer.stack.names(s)!.local.port, dstPort: l.dstPort, len: n, hex: l.hex });
            peer.log(`replayed ${n} bytes :${peer.stack.names(s)!.local.port} -> ${o.to ?? "broadcast"}:${l.dstPort}`);
        }
        peer.log(`replayed ${dgrams.length} datagram(s)`);
        return peer.result();
    } finally {
        peer.leave();
    }
}

export function parseCaptureFile(text: string): Capture[] {
    const out: Capture[] = [];
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const o = JSON.parse(line) as Partial<Capture> & { dataHex?: string };
        out.push({
            t: Number(o.t ?? 0), op: String(o.op ?? "udp"), ip: String(o.ip ?? ""),
            srcPort: o.srcPort, dstPort: o.dstPort, len: Number(o.len ?? 0), hex: String(o.hex ?? o.dataHex ?? ""),
        });
    }
    return out;
}

// ---- CLI -------------------------------------------------------------------------------

const USAGE = `bun tools/lan-peer.ts <command> --room <name> [--relay ws://127.0.0.1:5175]

  listen-udp  <port> [--ms N] [--reply-hex H]       print every datagram (hex + ASCII)
  send-udp    <ip|broadcast> <port> <hex|text>      send one datagram ([--ms N] waits for replies)
  sniff       [--ms N]                              log every frame delivered to us as JSON lines
  listen-tcp  <port> [--ms N] [--reply-hex H] [--announce-hex H]  accept connections, log inbound bytes;
                                                    --announce-hex also answers UDP 8585 queries
  connect-tcp <ip> <port> [hex]                     connect, optionally send, then log
  replay      <file.jsonl> [--to ip] [--fast]       re-emit captured UDP datagrams

  --expect-from <ip> / --expect-min-bytes <n>       exit 1 with a reason if unmet
  payloads: "hex:AABB", "text:hello", or a bare even-length hex string`;

function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Map<string, string> } {
    const pos: string[] = [];
    const flags = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) { pos.push(a); continue; }
        const [k, inline] = a.slice(2).split(/=(.*)/s);
        if (inline !== undefined) { flags.set(k, inline); continue; }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) flags.set(k, "");
        else { flags.set(k, next); i++; }
    }
    return { cmd: pos.shift() ?? "", pos, flags };
}

async function main(argv: string[]): Promise<number> {
    const { cmd, pos, flags } = parseArgs(argv);
    if (!cmd || cmd === "help" || flags.has("help") || flags.has("h")) { console.log(USAGE); return cmd ? 0 : 1; }
    const num = (k: string, d?: number): number | undefined => {
        const v = flags.get(k);
        if (v === undefined || v === "") return d;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`--${k}: not a number: ${v}`);
        return n;
    };
    const base: PeerOptions = {
        room: flags.get("room") ?? "",
        relay: flags.get("relay") || DEFAULT_RELAY,
        ms: num("ms"),
        expectFrom: flags.get("expect-from") || undefined,
        expectMinBytes: num("expect-min-bytes"),
    };
    if (!base.room) throw new Error("--room <name> is required");
    const port = (i: number): number => {
        const n = Number(pos[i]);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`expected a port, got ${pos[i] ?? "nothing"}`);
        return n;
    };
    const need = (i: number, what: string): string => {
        if (pos[i] === undefined) throw new Error(`expected ${what}`);
        return pos[i];
    };

    let res: PeerResult;
    switch (cmd) {
        case "listen-udp":
            res = await listenUdp({ ...base, port: port(0), replyHex: flags.get("reply-hex") || undefined });
            break;
        case "send-udp":
            res = await sendUdp({ ...base, dest: need(0, "an ip or broadcast"), port: port(1), payload: need(2, "a payload"), ms: num("ms", 0) });
            break;
        case "sniff":
            // stdout stays a clean .jsonl stream that `replay` can read back.
            res = await sniff({ ...base, log: (l) => console.error(l) });
            break;
        case "listen-tcp":
            res = await listenTcp({ ...base, port: port(0), replyHex: flags.get("reply-hex") || undefined, announceHex: flags.get("announce-hex") || undefined });
            break;
        case "connect-tcp":
            res = await connectTcp({ ...base, ip: need(0, "an ip"), port: port(1), payload: pos[2] });
            break;
        case "replay":
            res = await replay({
                ...base, lines: parseCaptureFile(await Bun.file(need(0, "a .jsonl file")).text()),
                to: flags.get("to") || undefined, fast: flags.has("fast"),
            });
            break;
        default:
            throw new Error(`unknown command ${cmd}\n\n${USAGE}`);
    }
    console.error(`-- ${res.packets} packet(s), ${res.bytes} payload byte(s), from [${res.from.join(", ")}]`);
    if (!res.ok) { console.error(`FAIL: ${res.reason}`); return 1; }
    return 0;
}

if (import.meta.main) {
    process.on("SIGINT", () => { stopped = true; });
    main(process.argv.slice(2))
        .then((code) => process.exit(code))
        .catch((e: Error) => { console.error(`error: ${e.message}`); process.exit(2); });
}
