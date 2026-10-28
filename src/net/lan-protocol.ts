/**
 * Virtual-LAN wire protocol shared by the browser worker and the relay server.
 *
 * The relay is stateless per flow: a client names the destination IP, the relay stamps the
 * source IP on delivery. All multi-byte fields are big-endian; IPs are host-order uint32.
 */

export const LAN_SUBNET = 0xc0a84d00; // 192.168.77.0/24
export const LAN_BROADCAST = 0xc0a84dff; // 192.168.77.255
export const LIMITED_BROADCAST = 0xffffffff;
export const LAN_MAX_FRAME = 65536;

export const Op = {
    Udp: 1,
    Syn: 2,
    SynAck: 3,
    Rst: 4,
    Data: 5,
    Fin: 6,
    Welcome: 0x80,
    PeerLeave: 0x81,
} as const;
export type Op = (typeof Op)[keyof typeof Op];

/** Which end of a TCP flow sent the frame: the connector (0) or the listener (1). */
export type Dir = 0 | 1;

export type LanMsg =
    | { op: typeof Op.Udp; ip: number; srcPort: number; dstPort: number; data: Uint8Array }
    | { op: typeof Op.Syn; ip: number; cid: number; srcPort: number; dstPort: number }
    | { op: typeof Op.SynAck; ip: number; cid: number }
    | { op: typeof Op.Rst; ip: number; cid: number; dir: Dir }
    | { op: typeof Op.Data; ip: number; cid: number; dir: Dir; data: Uint8Array }
    | { op: typeof Op.Fin; ip: number; cid: number; dir: Dir }
    | { op: typeof Op.Welcome; ip: number }
    | { op: typeof Op.PeerLeave; ip: number };

/** `ip` is the destination when client→relay and the source when relay→client. */
export function encode(m: LanMsg): Uint8Array {
    switch (m.op) {
        case Op.Udp: {
            const out = new Uint8Array(9 + m.data.length);
            const v = new DataView(out.buffer);
            out[0] = m.op;
            v.setUint32(1, m.ip);
            v.setUint16(5, m.srcPort);
            v.setUint16(7, m.dstPort);
            out.set(m.data, 9);
            return out;
        }
        case Op.Syn: {
            const out = new Uint8Array(13);
            const v = new DataView(out.buffer);
            out[0] = m.op;
            v.setUint32(1, m.ip);
            v.setUint32(5, m.cid);
            v.setUint16(9, m.srcPort);
            v.setUint16(11, m.dstPort);
            return out;
        }
        case Op.SynAck: {
            const out = new Uint8Array(9);
            const v = new DataView(out.buffer);
            out[0] = m.op;
            v.setUint32(1, m.ip);
            v.setUint32(5, m.cid);
            return out;
        }
        case Op.Rst:
        case Op.Fin: {
            const out = new Uint8Array(10);
            const v = new DataView(out.buffer);
            out[0] = m.op;
            v.setUint32(1, m.ip);
            v.setUint32(5, m.cid);
            out[9] = m.dir;
            return out;
        }
        case Op.Data: {
            const out = new Uint8Array(10 + m.data.length);
            const v = new DataView(out.buffer);
            out[0] = m.op;
            v.setUint32(1, m.ip);
            v.setUint32(5, m.cid);
            out[9] = m.dir;
            out.set(m.data, 10);
            return out;
        }
        case Op.Welcome:
        case Op.PeerLeave: {
            const out = new Uint8Array(5);
            new DataView(out.buffer).setUint32(1, m.ip);
            out[0] = m.op;
            return out;
        }
    }
}

/** Returns null for anything malformed: the relay is reachable by untrusted peers. */
export function decode(b: Uint8Array): LanMsg | null {
    if (b.length < 5 || b.length > LAN_MAX_FRAME) return null;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const op = b[0] as Op;
    const ip = v.getUint32(1);
    switch (op) {
        case Op.Udp:
            if (b.length < 9) return null;
            return { op, ip, srcPort: v.getUint16(5), dstPort: v.getUint16(7), data: b.subarray(9) };
        case Op.Syn:
            if (b.length !== 13) return null;
            return { op, ip, cid: v.getUint32(5), srcPort: v.getUint16(9), dstPort: v.getUint16(11) };
        case Op.SynAck:
            if (b.length !== 9) return null;
            return { op, ip, cid: v.getUint32(5) };
        case Op.Rst:
        case Op.Fin:
            if (b.length !== 10 || b[9] > 1) return null;
            return { op, ip, cid: v.getUint32(5), dir: b[9] as Dir };
        case Op.Data:
            if (b.length < 10 || b[9] > 1) return null;
            return { op, ip, cid: v.getUint32(5), dir: b[9] as Dir, data: b.subarray(10) };
        case Op.Welcome:
        case Op.PeerLeave:
            if (b.length !== 5) return null;
            return { op, ip };
        default:
            return null;
    }
}

export function ipToString(ip: number): string {
    return `${ip >>> 24}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`;
}

export function isBroadcast(ip: number): boolean {
    return ip === LAN_BROADCAST || ip === LIMITED_BROADCAST;
}

export const ROOM_NAME = /^[A-Za-z0-9_-]{1,32}$/;
