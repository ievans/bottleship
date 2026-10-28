/**
 * Winsock semantics (UDP + TCP) over the virtual-LAN relay (src/net/lan-protocol.ts).
 *
 * Pure state machine: no guest memory, no window system. The thunk layer (lan-exports.ts)
 * marshals arguments; window messages and kernel events go out through `hooks`.
 * IPs are host-order uint32 (a.b.c.d == a<<24|b<<16|c<<8|d); ports are host order.
 */
import { Op, Dir, LanMsg, decode, encode, isBroadcast, LAN_BROADCAST } from "../../net/lan-protocol";

export const FD_READ = 1, FD_WRITE = 2, FD_OOB = 4, FD_ACCEPT = 8, FD_CONNECT = 16, FD_CLOSE = 32;
export const SOL_SOCKET = 0xffff, SO_ERROR = 0x1007, SO_TYPE = 0x1008, SO_REUSEADDR = 4;

export const E = {
    WOULDBLOCK: 10035, INPROGRESS: 10036, ALREADY: 10037, DESTADDRREQ: 10039, MSGSIZE: 10040,
    INVAL: 10022, OPNOTSUPP: 10045, ADDRINUSE: 10048, ADDRNOTAVAIL: 10049, NETUNREACH: 10051,
    CONNRESET: 10054, ISCONN: 10056, NOTCONN: 10057, SHUTDOWN: 10058, TIMEDOUT: 10060,
    CONNREFUSED: 10061,
} as const;

const LOOPBACK = 0x7f000001;
const EPHEMERAL_LO = 49152, EPHEMERAL_HI = 65535;
const MAX_UDP_PAYLOAD = 65507;
const TCP_CHUNK = 32768;
const MAX_QUEUED_DGRAMS = 512;
const MAX_TCP_RX_BYTES = 4 << 20;

export interface LanLink { send(frame: Uint8Array): void }
/** Wire-level observer; null (the default) costs one check per frame. */
export interface LanTap {
    frame(outbound: boolean, frame: Uint8Array): void;
    /** A guest Winsock lifecycle call and its result; "pass" means the offline stub answered. */
    call(name: string, detail: string, result: string): void;
}

/** Real events at the relay boundary: each counter moves only when that thing happened. */
export interface LanCounters {
    /** Frames handed to the relay link. */
    sent: number;
    /** Well-formed frames received from the relay. */
    received: number;
    /** Received frames that failed to decode. */
    malformed: number;
    /** Frames that had no link to leave on. */
    droppedTx: number;
    /** Datagrams/segments delivered to our own sockets without touching the relay. */
    looped: number;
}

export interface SockInfo {
    id: number;
    type: "udp" | "tcp";
    state: "idle" | "listening" | "connecting" | "connected" | "dead";
    child: boolean;
    local: { ip: number; port: number };
    remote: { ip: number; port: number } | null;
    rxBytes: number;
    rxDgrams: number;
    acceptQueue: number;
    reset: boolean;
    peerFin: boolean;
    sentFin: boolean;
}
export interface LanHooks {
    postMessage(hwnd: number, msg: number, wParam: number, lParam: number): void;
    setEvent(handle: number): void;
}

interface Dgram { ip: number; port: number; data: Uint8Array }

interface Sock {
    id: number;
    kind: "udp" | "tcp";
    boundIp: number;
    boundPort: number;
    opts: Map<number, number>;
    // udp
    dgrams: Dgram[];
    peerIp: number;
    peerPort: number;
    // tcp
    state: "idle" | "listening" | "connecting" | "connected" | "dead";
    child: boolean;
    backlog: number;
    pending: Sock[];
    role: Dir;
    cid: number;
    remoteIp: number;
    remotePort: number;
    rx: Uint8Array[];
    rxBytes: number;
    peerFin: boolean;
    sentFin: boolean;
    reset: boolean;
    connectFailed: boolean;
    soError: number;
    timer: ReturnType<typeof setTimeout> | null;
    // notification
    async: { hwnd: number; msg: number; mask: number } | null;
    evt: { handle: number; mask: number; fired: number; errs: number[] } | null;
    readArmed: boolean;
    waiters: Set<() => void>;
}

export interface Names { local: { ip: number; port: number }; remote: { ip: number; port: number } | null }

export class LanStack {
    /** Our virtual-LAN address once the relay has welcomed us. */
    ip: number | null = null;
    hooks: LanHooks | null = null;
    connectTimeoutMs = 10000;

    tap: LanTap | null = null;
    readonly counters: LanCounters = { sent: 0, received: 0, malformed: 0, droppedTx: 0, looped: 0 };
    /** Relay peers heard from and not yet announced gone. */
    readonly peers = new Set<number>();

    private link: LanLink | null = null;
    private socks = new Map<number, Sock>();
    private conns = new Map<string, Sock>();
    private nextEphemeral = EPHEMERAL_LO + Math.floor(Math.random() * 1000);

    attachLink(link: LanLink | null): void {
        this.link = link;
        if (!link) this.peers.clear();
        if (!link && this.ip !== null) { this.ip = null; this.networkLost(); }
    }

    get linked(): boolean { return this.ip !== null; }

    /** Feed one relay→client frame. */
    onFrame(frame: Uint8Array): void {
        const msg = decode(frame);
        if (!msg) { this.counters.malformed++; return; }
        this.counters.received++;
        this.tap?.frame(false, frame);
        if (msg.op === Op.Welcome) {
            const changed = this.ip !== null && this.ip !== msg.ip;
            this.ip = msg.ip;
            if (changed) this.networkLost();
            return;
        }
        if (msg.op === Op.PeerLeave) { this.peers.delete(msg.ip); this.peerGone(msg.ip); return; }
        if (msg.ip !== this.ip) this.peers.add(msg.ip);
        this.receive(msg.ip, msg);
    }

    // ---- lifecycle -------------------------------------------------------------------

    create(id: number, type: number): void {
        this.socks.set(id, {
            id, kind: type === 1 ? "tcp" : "udp", boundIp: 0, boundPort: 0, opts: new Map(),
            dgrams: [], peerIp: 0, peerPort: 0,
            state: "idle", child: false, backlog: 0, pending: [], role: 0, cid: 0,
            remoteIp: 0, remotePort: 0, rx: [], rxBytes: 0, peerFin: false, sentFin: false,
            reset: false, connectFailed: false, soError: 0, timer: null,
            async: null, evt: null, readArmed: true, waiters: new Set(),
        });
    }

    has(id: number): boolean { return this.socks.has(id); }

    close(id: number): void {
        const s = this.socks.get(id);
        if (!s) return;
        this.socks.delete(id);
        if (s.timer) clearTimeout(s.timer);
        if (s.kind === "tcp") {
            if (s.state === "connected" && !s.sentFin && !s.reset) this.emit(s.remoteIp, { op: Op.Fin, cid: s.cid, dir: s.role });
            else if (s.state === "connecting") this.emit(s.remoteIp, { op: Op.Rst, cid: s.cid, dir: s.role });
            this.dropConn(s);
            for (const c of s.pending) {
                this.emit(c.remoteIp, { op: Op.Rst, cid: c.cid, dir: c.role });
                this.dropConn(c);
            }
            s.pending = [];
        }
        s.state = "dead";
        s.async = null;
        s.evt = null;
        this.wake(s);
    }

    reset(): void {
        for (const id of [...this.socks.keys()]) this.close(id);
        this.conns.clear();
    }

    // ---- addressing ------------------------------------------------------------------

    bind(id: number, ip: number, port: number): number {
        const s = this.socks.get(id);
        if (!s) return E.INVAL;
        if (s.boundPort !== 0) return E.INVAL;
        if (ip !== 0 && !this.isSelf(ip) && !isBroadcast(ip)) return E.ADDRNOTAVAIL;
        if (port === 0) {
            const p = this.allocPort(s.kind);
            if (p === 0) return E.ADDRINUSE;
            port = p;
        } else if (this.portConflict(s, ip, port)) {
            return E.ADDRINUSE;
        }
        s.boundIp = ip;
        s.boundPort = port;
        return 0;
    }

    names(id: number): Names | null {
        const s = this.socks.get(id);
        if (!s) return null;
        let ip = s.boundIp;
        if (ip === 0 && s.kind === "tcp" && s.state === "connected") ip = s.child ? this.selfIp() : this.localFor(s.remoteIp);
        const remote = s.kind === "tcp"
            ? (s.state === "connected" ? { ip: s.remoteIp, port: s.remotePort } : null)
            : (s.peerPort ? { ip: s.peerIp, port: s.peerPort } : null);
        return { local: { ip, port: s.boundPort }, remote };
    }

    // ---- UDP -------------------------------------------------------------------------

    /** Returns bytes sent, or a negative Winsock error. */
    sendTo(id: number, dstIp: number, dstPort: number, data: Uint8Array): number {
        const s = this.socks.get(id);
        if (!s || s.kind !== "udp") return -E.INVAL;
        if (dstPort === 0 || dstIp === 0) return -E.ADDRNOTAVAIL;
        if (data.length > MAX_UDP_PAYLOAD) return -E.MSGSIZE;
        if (s.boundPort === 0) { const e = this.bind(id, 0, 0); if (e) return -e; }
        const bcast = isBroadcast(dstIp);
        if (bcast || this.isSelf(dstIp)) {
            const src = bcast ? this.selfIp() : (dstIp >>> 24 === 127 ? LOOPBACK : this.selfIp());
            const copy = data.slice();
            this.counters.looped++;
            queueMicrotask(() => this.udpIn(src, s.boundPort, dstPort, copy));
        }
        if (bcast || !this.isSelf(dstIp)) {
            if (!this.link || this.ip === null) {
                if (bcast) this.counters.droppedTx++;
                return bcast ? data.length : -E.NETUNREACH;
            }
            this.transmit(this.link, encode({ op: Op.Udp, ip: bcast ? LAN_BROADCAST : dstIp, srcPort: s.boundPort, dstPort, data }));
        }
        return data.length;
    }

    /** UDP datagram or TCP bytes. `err` is 0 on success, E.MSGSIZE for a truncated datagram. */
    recv(id: number, maxLen: number, peek: boolean): { err: number; data: Uint8Array; ip: number; port: number } {
        const s = this.socks.get(id);
        const none = new Uint8Array(0);
        if (!s) return { err: E.INVAL, data: none, ip: 0, port: 0 };
        if (s.kind === "udp") {
            const d = s.dgrams[0];
            if (!d) return { err: E.WOULDBLOCK, data: none, ip: 0, port: 0 };
            const cut = d.data.length > maxLen;
            if (!peek) { s.dgrams.shift(); this.rearmRead(s); }
            return { err: cut ? E.MSGSIZE : 0, data: cut ? d.data.subarray(0, maxLen) : d.data, ip: d.ip, port: d.port };
        }
        if (s.state !== "connected" && !s.reset && !s.peerFin && s.rxBytes === 0) {
            return { err: s.state === "connecting" ? E.WOULDBLOCK : E.NOTCONN, data: none, ip: 0, port: 0 };
        }
        if (s.rxBytes === 0) {
            if (s.reset) return { err: E.CONNRESET, data: none, ip: 0, port: 0 };
            if (s.peerFin) return { err: 0, data: none, ip: s.remoteIp, port: s.remotePort };
            return { err: E.WOULDBLOCK, data: none, ip: 0, port: 0 };
        }
        const out = new Uint8Array(Math.min(maxLen, s.rxBytes));
        let off = 0;
        for (let i = 0; off < out.length; i++) {
            const c = s.rx[i];
            const n = Math.min(c.length, out.length - off);
            out.set(c.subarray(0, n), off);
            off += n;
        }
        if (!peek) { this.consume(s, out.length); this.rearmRead(s); }
        return { err: 0, data: out, ip: s.remoteIp, port: s.remotePort };
    }

    // ---- TCP -------------------------------------------------------------------------

    /** Returns 0, E.WOULDBLOCK (handshake started), or an error. */
    connect(id: number, ip: number, port: number): number {
        const s = this.socks.get(id);
        if (!s) return E.INVAL;
        if (s.kind === "udp") {
            if (s.boundPort === 0) { const e = this.bind(id, 0, 0); if (e) return e; }
            s.peerIp = ip; s.peerPort = port;
            return 0;
        }
        if (s.state === "connected") return E.ISCONN;
        if (s.state === "connecting") return E.ALREADY;
        if (s.state !== "idle") return E.INVAL;
        if (ip === 0 || port === 0 || isBroadcast(ip)) return E.ADDRNOTAVAIL;
        if (!this.isSelf(ip) && (!this.link || this.ip === null)) return E.NETUNREACH;
        if (s.boundPort === 0) { const e = this.bind(id, 0, 0); if (e) return e; }
        s.role = 0;
        s.cid = this.newCid(0);
        s.remoteIp = this.isSelf(ip) ? (ip >>> 24 === 127 ? LOOPBACK : ip) : ip;
        s.remotePort = port;
        s.state = "connecting";
        s.connectFailed = false;
        this.conns.set(this.key(0, s.cid), s);
        s.timer = setTimeout(() => this.failConnect(s, E.TIMEDOUT), this.connectTimeoutMs);
        this.emit(s.remoteIp, { op: Op.Syn, cid: s.cid, srcPort: s.boundPort, dstPort: port });
        return E.WOULDBLOCK;
    }

    listen(id: number, backlog: number): number {
        const s = this.socks.get(id);
        if (!s || s.kind !== "tcp") return E.OPNOTSUPP;
        if (s.state !== "idle" && s.state !== "listening") return E.INVAL;
        if (s.boundPort === 0) { const e = this.bind(id, 0, 0); if (e) return e; }
        s.state = "listening";
        s.backlog = Math.max(1, Math.min(backlog | 0 || 5, 200));
        return 0;
    }

    accept(id: number, allocId: () => number): { err: number; id: number; ip: number; port: number } {
        const s = this.socks.get(id);
        if (!s || s.kind !== "tcp" || s.state !== "listening") return { err: E.INVAL, id: 0, ip: 0, port: 0 };
        const c = s.pending.shift();
        if (!c) return { err: E.WOULDBLOCK, id: 0, ip: 0, port: 0 };
        c.id = allocId();
        this.socks.set(c.id, c);
        // The accepted socket inherits the listener's async/event selection.
        if (s.async) c.async = { ...s.async };
        if (s.evt) c.evt = { handle: s.evt.handle, mask: s.evt.mask, fired: 0, errs: new Array<number>(10).fill(0) };
        c.readArmed = true;
        if (c.async || c.evt) this.replay(c);
        if (s.pending.length) this.signal(s, FD_ACCEPT);
        return { err: 0, id: c.id, ip: c.remoteIp, port: c.remotePort };
    }

    /** Returns bytes sent or a negative error. */
    send(id: number, data: Uint8Array): number {
        const s = this.socks.get(id);
        if (!s) return -E.INVAL;
        if (s.kind === "udp") {
            if (!s.peerPort) return -E.DESTADDRREQ;
            return this.sendTo(id, s.peerIp, s.peerPort, data);
        }
        if (s.reset) return -E.CONNRESET;
        if (s.state !== "connected") return -E.NOTCONN;
        if (s.sentFin) return -E.SHUTDOWN;
        for (let off = 0; off < data.length; off += TCP_CHUNK) {
            this.emit(s.remoteIp, { op: Op.Data, cid: s.cid, dir: s.role, data: data.slice(off, off + TCP_CHUNK) });
        }
        return data.length;
    }

    shutdown(id: number, how: number): number {
        const s = this.socks.get(id);
        if (!s) return E.INVAL;
        if (s.kind !== "tcp" || s.state !== "connected") return E.NOTCONN;
        if ((how === 1 || how === 2) && !s.sentFin) {
            s.sentFin = true;
            this.emit(s.remoteIp, { op: Op.Fin, cid: s.cid, dir: s.role });
        }
        return 0;
    }

    // ---- options / readiness ---------------------------------------------------------

    setOpt(id: number, level: number, opt: number, value: number): boolean {
        const s = this.socks.get(id);
        if (!s) return false;
        s.opts.set(((level & 0xffff) << 16 | (opt & 0xffff)) >>> 0, value | 0);
        return true;
    }

    getOpt(id: number, level: number, opt: number): number {
        const s = this.socks.get(id);
        if (!s) return 0;
        if (level === SOL_SOCKET && opt === SO_ERROR) { const e = s.soError; s.soError = 0; return e; }
        if (level === SOL_SOCKET && opt === SO_TYPE) return s.kind === "tcp" ? 1 : 2;
        return s.opts.get(((level & 0xffff) << 16 | (opt & 0xffff)) >>> 0) ?? 0;
    }

    ready(id: number): { r: boolean; w: boolean; x: boolean } {
        const s = this.socks.get(id);
        if (!s) return { r: false, w: false, x: false };
        return { r: this.readable(s), w: this.writable(s), x: s.connectFailed };
    }

    /** Bytes FIONREAD reports: next datagram for UDP, all queued bytes for TCP. */
    pendingBytes(id: number): number {
        const s = this.socks.get(id);
        if (!s) return 0;
        return s.kind === "udp" ? (s.dgrams[0]?.data.length ?? 0) : s.rxBytes;
    }

    /** Resolves on the next state change of any listed socket, or after `timeoutMs` (<0: never). */
    waitChange(ids: number[], timeoutMs: number): Promise<void> {
        return new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const done = () => {
                if (timer) clearTimeout(timer);
                for (const id of ids) this.socks.get(id)?.waiters.delete(done);
                resolve();
            };
            for (const id of ids) {
                const s = this.socks.get(id);
                if (!s) { resolve(); return; }
                s.waiters.add(done);
            }
            if (timeoutMs >= 0) timer = setTimeout(done, timeoutMs);
        });
    }

    selectAsync(id: number, hwnd: number, msg: number, mask: number): boolean {
        const s = this.socks.get(id);
        if (!s) return false;
        s.evt = null;
        s.async = mask ? { hwnd, msg, mask } : null;
        s.readArmed = true;
        if (mask) this.replay(s);
        return true;
    }

    selectEvent(id: number, handle: number, mask: number): boolean {
        const s = this.socks.get(id);
        if (!s) return false;
        s.async = null;
        s.evt = mask ? { handle, mask, fired: 0, errs: new Array<number>(10).fill(0) } : null;
        if (mask) this.replay(s);
        return true;
    }

    enumEvents(id: number): { mask: number; errs: number[] } | null {
        const s = this.socks.get(id);
        if (!s) return null;
        if (!s.evt) return { mask: 0, errs: new Array<number>(10).fill(0) };
        const out = { mask: s.evt.fired, errs: s.evt.errs.slice() };
        s.evt.fired = 0;
        s.evt.errs.fill(0);
        return out;
    }

    // ---- observability ---------------------------------------------------------------

    sockets(): SockInfo[] {
        const out: SockInfo[] = [];
        for (const s of this.socks.values()) {
            const n = this.names(s.id)!;
            out.push({
                id: s.id, type: s.kind, state: s.state, child: s.child, local: n.local, remote: n.remote,
                rxBytes: s.rxBytes, rxDgrams: s.dgrams.length, acceptQueue: s.pending.length,
                reset: s.reset, peerFin: s.peerFin, sentFin: s.sentFin,
            });
        }
        return out;
    }

    /** Ports of the flow a `senderRole` frame with `cid` belongs to, or null if the flow is gone. */
    flowPorts(senderRole: Dir, cid: number, outbound: boolean): { local: number; remote: number } | null {
        const s = this.conns.get(this.key(outbound ? senderRole : senderRole === 0 ? 1 : 0, cid));
        return s ? { local: s.boundPort, remote: s.remotePort } : null;
    }

    // ---- internals -------------------------------------------------------------------

    private selfIp(): number { return this.ip ?? LOOPBACK; }
    private isSelf(ip: number): boolean { return ip >>> 24 === 127 || (this.ip !== null && ip === this.ip); }
    private localFor(remote: number): number { return remote >>> 24 === 127 ? LOOPBACK : this.selfIp(); }
    private key(role: Dir, cid: number): string { return `${role}:${cid}`; }

    private emit(dstIp: number, m: DistributiveOmit<LanMsg, "ip">): void {
        if (this.isSelf(dstIp)) {
            const self = this.selfIp();
            this.counters.looped++;
            queueMicrotask(() => this.receive(self, { ...m, ip: self } as LanMsg));
            return;
        }
        if (!this.link) { this.counters.droppedTx++; return; }
        this.transmit(this.link, encode({ ...m, ip: dstIp } as LanMsg));
    }

    private transmit(link: LanLink, frame: Uint8Array): void {
        this.counters.sent++;
        this.tap?.frame(true, frame);
        link.send(frame);
    }

    private allocPort(kind: Sock["kind"]): number {
        for (let i = 0; i <= EPHEMERAL_HI - EPHEMERAL_LO; i++) {
            const p = this.nextEphemeral;
            this.nextEphemeral = p >= EPHEMERAL_HI ? EPHEMERAL_LO : p + 1;
            let used = false;
            for (const o of this.socks.values()) if (!o.child && o.kind === kind && o.boundPort === p) { used = true; break; }
            if (!used) return p;
        }
        return 0;
    }

    private portConflict(s: Sock, ip: number, port: number): boolean {
        const reuse = s.opts.get(((SOL_SOCKET << 16) | SO_REUSEADDR) >>> 0) ?? 0;
        for (const o of this.socks.values()) {
            if (o === s || o.child || o.kind !== s.kind || o.boundPort !== port) continue;
            if (o.boundIp !== 0 && ip !== 0 && o.boundIp !== ip) continue;
            const oReuse = o.opts.get(((SOL_SOCKET << 16) | SO_REUSEADDR) >>> 0) ?? 0;
            if (reuse && oReuse) continue;
            return true;
        }
        return false;
    }

    private receive(srcIp: number, m: LanMsg): void {
        switch (m.op) {
            case Op.Udp: this.udpIn(srcIp, m.srcPort, m.dstPort, m.data); return;
            case Op.Syn: this.synIn(srcIp, m); return;
            case Op.SynAck: {
                const s = this.findConn(srcIp, m.cid, 1);
                if (!s || s.state !== "connecting") return;
                if (s.timer) { clearTimeout(s.timer); s.timer = null; }
                s.state = "connected";
                this.signal(s, FD_CONNECT);
                this.signal(s, FD_WRITE);
                return;
            }
            case Op.Data: {
                const s = this.findConn(srcIp, m.cid, m.dir);
                if (!s) { this.emit(srcIp, { op: Op.Rst, cid: m.cid, dir: m.dir === 0 ? 1 : 0 }); return; }
                if (s.state !== "connected") return;
                // No window is advertised, so overflow cannot be back-pressured: reset
                // rather than silently leave a hole in the stream.
                if (s.rxBytes + m.data.length > MAX_TCP_RX_BYTES) {
                    this.emit(s.remoteIp, { op: Op.Rst, cid: s.cid, dir: s.role });
                    this.abort(s);
                    return;
                }
                s.rx.push(m.data.slice());
                s.rxBytes += m.data.length;
                this.signal(s, FD_READ);
                return;
            }
            case Op.Fin: {
                const s = this.findConn(srcIp, m.cid, m.dir);
                if (!s) { this.emit(srcIp, { op: Op.Rst, cid: m.cid, dir: m.dir === 0 ? 1 : 0 }); return; }
                s.peerFin = true;
                this.signal(s, FD_READ);
                this.signal(s, FD_CLOSE);
                return;
            }
            case Op.Rst: {
                const s = this.findConn(srcIp, m.cid, m.dir);
                if (!s) return;
                if (s.state === "connecting") this.failConnect(s, E.CONNREFUSED);
                else this.abort(s);
                return;
            }
            default: return;
        }
    }

    /** The local end of the flow a frame from `srcIp` (sent by `senderRole`) belongs to. */
    private findConn(srcIp: number, cid: number, senderRole: Dir): Sock | undefined {
        const s = this.conns.get(this.key(senderRole === 0 ? 1 : 0, cid));
        // Only the peer the flow was established with may touch it.
        return s && this.sameHost(s.remoteIp, srcIp) ? s : undefined;
    }

    private sameHost(a: number, b: number): boolean {
        return a === b || (this.isLocal(a) && this.isLocal(b));
    }
    private isLocal(ip: number): boolean { return ip >>> 24 === 127 || ip === this.ip; }

    private newCid(role: Dir): number {
        for (;;) {
            const cid = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
            if (!this.conns.has(this.key(role, cid))) return cid;
        }
    }

    private udpIn(srcIp: number, srcPort: number, dstPort: number, data: Uint8Array): void {
        for (const s of this.socks.values()) {
            if (s.kind !== "udp" || s.boundPort !== dstPort) continue;
            if (s.boundIp !== 0 && s.boundIp !== this.ip && s.boundIp >>> 24 !== 127 && !isBroadcast(s.boundIp)) continue;
            if (s.peerPort && (s.peerIp !== srcIp || s.peerPort !== srcPort)) continue;
            if (s.dgrams.length >= MAX_QUEUED_DGRAMS) continue;
            s.dgrams.push({ ip: srcIp, port: srcPort, data: data.slice() });
            this.signal(s, FD_READ);
        }
    }

    private synIn(srcIp: number, m: Extract<LanMsg, { op: typeof Op.Syn }>): void {
        let l: Sock | undefined;
        for (const o of this.socks.values()) {
            if (o.kind === "tcp" && o.state === "listening" && o.boundPort === m.dstPort) { l = o; break; }
        }
        if (!l || l.pending.length >= l.backlog) {
            this.emit(srcIp, { op: Op.Rst, cid: m.cid, dir: 1 });
            return;
        }
        if (this.conns.has(this.key(1, m.cid))) {
            this.emit(srcIp, { op: Op.Rst, cid: m.cid, dir: 1 });
            return;
        }
        const c = this.blank("tcp");
        c.child = true;
        c.state = "connected";
        c.role = 1;
        c.cid = m.cid;
        c.remoteIp = this.isSelf(srcIp) ? LOOPBACK : srcIp;
        c.remotePort = m.srcPort;
        c.boundPort = m.dstPort;
        c.boundIp = l.boundIp;
        this.conns.set(this.key(1, m.cid), c);
        l.pending.push(c);
        this.emit(srcIp, { op: Op.SynAck, cid: m.cid });
        this.signal(l, FD_ACCEPT);
    }

    private blank(kind: Sock["kind"]): Sock {
        this.create(0, kind === "tcp" ? 1 : 2);
        const s = this.socks.get(0)!;
        this.socks.delete(0);
        return s;
    }

    private failConnect(s: Sock, err: number): void {
        if (s.timer) { clearTimeout(s.timer); s.timer = null; }
        if (err === E.TIMEDOUT) this.emit(s.remoteIp, { op: Op.Rst, cid: s.cid, dir: 0 });
        this.dropConn(s);
        s.state = "idle";
        s.connectFailed = true;
        s.soError = err;
        this.signal(s, FD_CONNECT, err);
    }

    private abort(s: Sock): void {
        s.reset = true;
        this.dropConn(s);
        this.signal(s, FD_READ);
        this.signal(s, FD_CLOSE, E.CONNRESET);
    }

    private peerGone(ip: number): void {
        for (const s of [...this.conns.values()]) {
            if (s.remoteIp !== ip) continue;
            if (s.state === "connecting") this.failConnect(s, E.TIMEDOUT);
            else if (s.state === "connected") this.abort(s);
        }
    }

    /** The link went away or our address changed: flows over the old address are dead. */
    private networkLost(): void {
        for (const s of [...this.conns.values()]) {
            if (this.isLocal(s.remoteIp)) continue;
            if (s.state === "connecting") this.failConnect(s, E.NETUNREACH);
            else if (s.state === "connected") this.abort(s);
        }
        for (const s of this.socks.values()) this.wake(s);
    }

    private dropConn(s: Sock): void {
        if (s.cid && this.conns.get(this.key(s.role, s.cid)) === s) this.conns.delete(this.key(s.role, s.cid));
    }

    private consume(s: Sock, n: number): void {
        s.rxBytes -= n;
        while (n > 0) {
            const c = s.rx[0];
            if (c.length <= n) { n -= c.length; s.rx.shift(); }
            else { s.rx[0] = c.subarray(n); n = 0; }
        }
    }

    private readable(s: Sock): boolean {
        if (s.kind === "udp") return s.dgrams.length > 0;
        if (s.state === "listening") return s.pending.length > 0;
        return s.rxBytes > 0 || s.peerFin || s.reset;
    }

    private writable(s: Sock): boolean {
        return s.kind === "udp" || (s.state === "connected" && !s.sentFin && !s.reset);
    }

    private rearmRead(s: Sock): void {
        s.readArmed = true;
        if (this.readable(s)) this.signal(s, FD_READ);
    }

    private replay(s: Sock): void {
        if (this.readable(s)) this.signal(s, s.state === "listening" ? FD_ACCEPT : FD_READ);
        if (this.writable(s)) this.signal(s, FD_WRITE);
        if (s.peerFin || s.reset) this.signal(s, FD_CLOSE, s.reset ? E.CONNRESET : 0);
    }

    private signal(s: Sock, ev: number, err = 0): void {
        const bit = 31 - Math.clz32(ev);
        if (s.evt && (s.evt.mask & ev)) {
            s.evt.fired |= ev;
            s.evt.errs[bit] = err;
            this.hooks?.setEvent(s.evt.handle);
        }
        if (s.async && (s.async.mask & ev) && s.id) {
            if (ev === FD_READ) {
                if (s.readArmed) { s.readArmed = false; this.post(s, ev, err); }
            } else {
                this.post(s, ev, err);
            }
        }
        this.wake(s);
    }

    private post(s: Sock, ev: number, err: number): void {
        const a = s.async!;
        this.hooks?.postMessage(a.hwnd, a.msg, s.id, ((err & 0xffff) << 16) | ev);
    }

    private wake(s: Sock): void {
        if (!s.waiters.size) return;
        for (const w of [...s.waiters]) w();
    }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
