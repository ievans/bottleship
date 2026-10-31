/**
 * Datagram format between DirectPlay 8 engines. Little-endian; every datagram starts "D8" and a
 * type byte. Handshakes (enumerate, connect) are single datagrams the initiator retries; session
 * traffic rides reliable segments (seq/ack per endpoint pair) or unreliable data datagrams.
 */

import { bytesToGuid, guidToBytes } from "./dpnet-address";

export const MAGIC0 = 0x44;
export const MAGIC1 = 0x38;

export const enum Dg {
    EnumQuery = 1,
    EnumResponse = 2,
    Connect = 3,
    ConnectReply = 4,
    Segment = 5,
    Unreliable = 6,
}

/** Messages carried inside reliable segments. */
export const enum Msg {
    Data = 1,
    PeerAdd = 2,
    PeerInfo = 3,
    Leave = 4,
    PeerGone = 5,
    Terminate = 6,
    AppDesc = 7,
    Ping = 8,
    GroupCreate = 9,
    GroupDestroy = 10,
    GroupAdd = 11,
    GroupRemove = 12,
    GroupInfo = 13,
}

export class Writer {
    private buf = new Uint8Array(128);
    private dv = new DataView(this.buf.buffer);
    private n = 0;

    private reserve(extra: number): void {
        if (this.n + extra <= this.buf.length) return;
        const next = new Uint8Array(Math.max(this.buf.length * 2, this.n + extra));
        next.set(this.buf.subarray(0, this.n));
        this.buf = next;
        this.dv = new DataView(next.buffer);
    }

    u8(v: number): this { this.reserve(1); this.buf[this.n++] = v & 0xff; return this; }
    u32(v: number): this { this.reserve(4); this.dv.setUint32(this.n, v >>> 0, true); this.n += 4; return this; }
    raw(b: Uint8Array): this { this.reserve(b.length); this.buf.set(b, this.n); this.n += b.length; return this; }
    bytes(b: Uint8Array | null): this { this.u32(b ? b.length : 0); if (b) this.raw(b); return this; }
    guid(g: string): this { return this.raw(guidToBytes(g)); }
    str(s: string): this {
        const b = new TextEncoder().encode(s);
        return this.bytes(b);
    }
    done(): Uint8Array { return this.buf.slice(0, this.n); }
}

export class Reader {
    private dv: DataView;
    private n = 0;

    constructor(private readonly buf: Uint8Array) {
        this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    }

    get left(): number { return this.buf.length - this.n; }

    private need(k: number): void { if (this.n + k > this.buf.length) throw new RangeError("short datagram"); }
    u8(): number { this.need(1); return this.buf[this.n++]!; }
    u32(): number { this.need(4); const v = this.dv.getUint32(this.n, true); this.n += 4; return v; }
    raw(k: number): Uint8Array { this.need(k); const v = this.buf.subarray(this.n, this.n + k); this.n += k; return v; }
    bytes(): Uint8Array {
        const k = this.u32();
        if (k > this.left) throw new RangeError("short datagram");
        return this.raw(k).slice();
    }
    guid(): string { return bytesToGuid(this.raw(16)); }
    str(): string { return new TextDecoder().decode(this.bytes()); }
}

export interface AppDesc {
    flags: number;
    instance: string;
    application: string;
    maxPlayers: number;
    currentPlayers: number;
    sessionName: string;
    password: string;
    reserved: Uint8Array;
    appReserved: Uint8Array;
}

export const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

export function writeAppDesc(w: Writer, d: AppDesc): void {
    w.u32(d.flags).guid(d.instance).guid(d.application).u32(d.maxPlayers).u32(d.currentPlayers)
        .str(d.sessionName).str(d.password).bytes(d.reserved).bytes(d.appReserved);
}

export function readAppDesc(r: Reader): AppDesc {
    return {
        flags: r.u32(), instance: r.guid(), application: r.guid(), maxPlayers: r.u32(), currentPlayers: r.u32(),
        sessionName: r.str(), password: r.str(), reserved: r.bytes(), appReserved: r.bytes(),
    };
}

export interface PlayerRecord {
    id: number;
    ip: number;
    port: number;
    flags: number;
    name: string;
    data: Uint8Array;
}

export function writePlayer(w: Writer, p: PlayerRecord): void {
    w.u32(p.id).u32(p.ip).u32(p.port).u32(p.flags).str(p.name).bytes(p.data);
}

export function readPlayer(r: Reader): PlayerRecord {
    return { id: r.u32(), ip: r.u32(), port: r.u32(), flags: r.u32(), name: r.str(), data: r.bytes() };
}

export interface GroupRecord { id: number; flags: number; name: string; data: Uint8Array; members: number[] }

export function writeGroup(w: Writer, g: GroupRecord): void {
    w.u32(g.id).u32(g.flags).str(g.name).bytes(g.data).u32(g.members.length);
    for (const m of g.members) w.u32(m);
}

export function readGroup(r: Reader): GroupRecord {
    const g: GroupRecord = { id: r.u32(), flags: r.u32(), name: r.str(), data: r.bytes(), members: [] };
    const n = r.u32();
    if (n > 4096) throw new RangeError("group too large");
    for (let i = 0; i < n; i++) g.members.push(r.u32());
    return g;
}

export function header(type: Dg): Writer {
    return new Writer().u8(MAGIC0).u8(MAGIC1).u8(type);
}

/** The datagram type, or 0 for a datagram that is not ours. */
export function datagramType(b: Uint8Array): number {
    return b.length >= 3 && b[0] === MAGIC0 && b[1] === MAGIC1 ? b[2]! : 0;
}
