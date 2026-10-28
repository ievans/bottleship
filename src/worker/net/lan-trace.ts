/** Bounded ring of relay frames for the harness; attached to LanStack.tap only while enabled. */
import { Op, decode, ipToString } from "../../net/lan-protocol";
import type { LanStack, LanTap } from "./lan-stack";

export const LAN_TRACE_CAPACITY = 512;
const HEX_BYTES = 64;

export interface LanTraceEntry {
    seq: number;
    tMs: number;
    dir: "tx" | "rx";
    proto: "udp" | "tcp" | "ctl";
    /** udp, syn, synack, data, fin, rst, welcome, peerleave */
    kind: string;
    src: string;
    dst: string;
    /** TCP flow id (hex), when the frame has one. */
    cid?: string;
    /** Bytes of payload (UDP datagram / TCP segment); 0 for control frames. */
    len: number;
    /** First 64 payload bytes. */
    hex: string;
}

const KIND: Record<number, [LanTraceEntry["proto"], string]> = {
    [Op.Udp]: ["udp", "udp"], [Op.Syn]: ["tcp", "syn"], [Op.SynAck]: ["tcp", "synack"],
    [Op.Rst]: ["tcp", "rst"], [Op.Data]: ["tcp", "data"], [Op.Fin]: ["tcp", "fin"],
    [Op.Welcome]: ["ctl", "welcome"], [Op.PeerLeave]: ["ctl", "peerleave"],
};

function hex(b: Uint8Array): string {
    let s = "";
    const n = Math.min(b.length, HEX_BYTES);
    for (let i = 0; i < n; i++) s += (b[i]! < 16 ? "0" : "") + b[i]!.toString(16);
    return s;
}

export class LanTrace implements LanTap {
    private ring: LanTraceEntry[] = [];
    private seq = 0;
    private base = 0;

    constructor(private readonly stack: LanStack) {}

    get nextSeq(): number { return this.seq; }
    get size(): number { return this.ring.length; }
    get overwritten(): number { return this.seq - this.base - this.ring.length; }

    frame(outbound: boolean, frame: Uint8Array): void {
        const m = decode(frame);
        if (!m) return;
        const [proto, kind] = KIND[m.op]!;
        const self = this.stack.ip === null ? "?" : ipToString(this.stack.ip);
        const peer = ipToString(m.ip);
        let sp = 0, dp = 0, cid: string | undefined, payload: Uint8Array | null = null;
        switch (m.op) {
            case Op.Udp: sp = m.srcPort; dp = m.dstPort; payload = m.data; break;
            case Op.Syn:
                // Syn carries both ports in the sender's order.
                sp = m.srcPort; dp = m.dstPort; cid = m.cid.toString(16); break;
            case Op.Data: case Op.Fin: case Op.Rst: {
                cid = m.cid.toString(16);
                const f = this.stack.flowPorts(m.dir, m.cid, outbound);
                if (f) { sp = outbound ? f.local : f.remote; dp = outbound ? f.remote : f.local; }
                if (m.op === Op.Data) payload = m.data;
                break;
            }
            case Op.SynAck: cid = m.cid.toString(16); break;
        }
        // For Udp/Syn the ports are the originator's own: the sender's on tx, the peer's on rx.
        const src = outbound ? `${self}${sp ? ":" + sp : ""}` : `${peer}${sp ? ":" + sp : ""}`;
        const dst = outbound ? `${peer}${dp ? ":" + dp : ""}` : `${self}${dp ? ":" + dp : ""}`;
        const e: LanTraceEntry = {
            seq: this.seq++, tMs: Math.round(performance.now() * 100) / 100,
            dir: outbound ? "tx" : "rx", proto, kind, src, dst, len: payload?.length ?? 0, hex: payload ? hex(payload) : "",
        };
        if (cid) e.cid = cid;
        if (this.ring.length >= LAN_TRACE_CAPACITY) this.ring.shift();
        this.ring.push(e);
    }

    read(since: number, limit: number): LanTraceEntry[] {
        const out = this.ring.filter((e) => e.seq >= since);
        return limit > 0 && out.length > limit ? out.slice(out.length - limit) : out;
    }

    clear(): void { this.ring.length = 0; this.base = this.seq; }
}
