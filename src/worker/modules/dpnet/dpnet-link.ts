/**
 * One reliable, ordered channel to a remote endpoint over unreliable datagrams: cumulative acks,
 * retransmit with backoff, bounded reordering, loss declared when the oldest segment stays
 * unacknowledged too long.
 */

import { Dg, header } from "./dpnet-wire";

export const RTO_INITIAL_MS = 300;
export const RTO_MAX_MS = 2000;
export const DEAD_AFTER_MS = 15000;
export const PING_AFTER_MS = 3000;
const REORDER_WINDOW = 1024;
const MAX_RESENDS_PER_TICK = 64;

export type Xmit = (datagram: Uint8Array) => void;

interface Unacked {
    seq: number;
    payload: Uint8Array;
    firstSent: number;
    sentAt: number;
    rto: number;
    retries: number;
    onAcked: (() => void) | null;
}

export class Link {
    playerId = 0;
    readonly unacked: Unacked[] = [];
    queuedBytes = 0;
    srtt = 0;
    lastSend: number;
    lastRecv: number;
    retriedPackets = 0;
    retriedBytes = 0;
    sentPackets = 0;
    sentBytes = 0;
    recvPackets = 0;
    recvBytes = 0;
    fragments: Uint8Array[] = [];
    private nextSeq = 1;
    private recvNext = 1;
    private readonly reorder = new Map<number, Uint8Array>();

    constructor(readonly ip: number, readonly port: number, now: number) {
        this.lastSend = now;
        this.lastRecv = now;
    }

    private encode(seq: number, payload: Uint8Array): Uint8Array {
        return header(Dg.Segment).u32(seq).u32(this.recvNext).raw(payload).done();
    }

    queue(payload: Uint8Array, now: number, xmit: Xmit, onAcked: (() => void) | null = null): void {
        const u: Unacked = { seq: this.nextSeq++, payload, firstSent: now, sentAt: now, rto: RTO_INITIAL_MS, retries: 0, onAcked };
        this.unacked.push(u);
        this.queuedBytes += payload.length;
        this.sentPackets++;
        this.sentBytes += payload.length;
        this.lastSend = now;
        xmit(this.encode(u.seq, payload));
    }

    sendAck(now: number, xmit: Xmit): void {
        this.lastSend = now;
        xmit(this.encode(0, new Uint8Array(0)));
    }

    /** Releases everything the peer has received (`ack` = the next sequence number it expects). */
    onAck(ack: number, now: number): void {
        while (this.unacked.length && this.unacked[0]!.seq < ack) {
            const u = this.unacked.shift()!;
            this.queuedBytes -= u.payload.length;
            if (u.retries === 0) {
                const sample = now - u.sentAt;
                this.srtt = this.srtt ? this.srtt * 0.875 + sample * 0.125 : sample;
            }
            u.onAcked?.();
        }
    }

    /** In-order payloads that became deliverable with segment `seq`. */
    receive(seq: number, payload: Uint8Array, now: number): Uint8Array[] {
        this.lastRecv = now;
        if (seq < this.recvNext) return [];
        if (seq >= this.recvNext + REORDER_WINDOW) return [];
        if (seq > this.recvNext) {
            this.reorder.set(seq, payload);
            return [];
        }
        const out = [payload];
        this.recvNext++;
        for (let next = this.reorder.get(this.recvNext); next; next = this.reorder.get(this.recvNext)) {
            this.reorder.delete(this.recvNext);
            out.push(next);
            this.recvNext++;
        }
        this.recvPackets += out.length;
        for (const p of out) this.recvBytes += p.length;
        return out;
    }

    /** False once the oldest unacknowledged segment has been outstanding past DEAD_AFTER_MS. */
    tick(now: number, xmit: Xmit): boolean {
        const head = this.unacked[0];
        if (head && now - head.firstSent > DEAD_AFTER_MS) return false;
        let resent = 0;
        for (const u of this.unacked) {
            if (now - u.sentAt < u.rto) continue;
            u.sentAt = now;
            u.rto = Math.min(u.rto * 2, RTO_MAX_MS);
            u.retries++;
            this.retriedPackets++;
            this.retriedBytes += u.payload.length;
            this.lastSend = now;
            xmit(this.encode(u.seq, u.payload));
            if (++resent >= MAX_RESENDS_PER_TICK) break;
        }
        return true;
    }

    idleFor(now: number): number {
        return now - Math.max(this.lastSend, this.lastRecv);
    }
}
