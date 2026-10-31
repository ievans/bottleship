/**
 * DirectPlay 8 peer session engine: host discovery, the connect handshake, a full mesh of
 * reliable links, guaranteed/unguaranteed delivery, groups, host loss and migration. Pure
 * logic over an injected transport, clock and event sink so it runs identically under test
 * and inside the emulator; the COM layer turns events into DPN_MSGID_* callbacks.
 */

import { DPN_DEFAULT_PORT } from "./dpnet-address";
import { CancelFlag, DestroyReason, Hr, INFINITE, SESSION_MIGRATE_HOST, SendFlag } from "./dpnet-constants";
import { Link, PING_AFTER_MS, type Xmit } from "./dpnet-link";
import {
    AppDesc, Dg, Msg, Reader, Writer, ZERO_GUID, datagramType, header, readAppDesc, readGroup, readPlayer,
    writeAppDesc, writeGroup, writePlayer,
} from "./dpnet-wire";

export interface Transport {
    readonly ip: number;
    /** 0 until bound. */
    readonly port: number;
    /** Binds (rebinding if already bound); returns the port actually bound, 0 on failure. */
    bind(port: number): number;
    send(ip: number, port: number, data: Uint8Array): void;
    broadcast(port: number, data: Uint8Array): void;
    close(): void;
    onReceive: ((ip: number, port: number, data: Uint8Array) => void) | null;
}

export interface Env {
    transport: Transport;
    now(): number;
    every(ms: number, fn: () => void): () => void;
    guid(): string;
    rand32(): number;
}

export interface Player {
    id: number;
    ip: number;
    port: number;
    local: boolean;
    name: string;
    data: Uint8Array;
    ctx: number;
    link: Link | null;
}

export interface Group {
    id: number;
    owner: number;
    flags: number;
    name: string;
    data: Uint8Array;
    ctx: number;
    members: Set<number>;
}

export type EngineEvent =
    | { t: "createPlayer"; player: Player }
    | { t: "destroyPlayer"; player: Player; reason: number }
    | { t: "createGroup"; group: Group }
    | { t: "destroyGroup"; group: Group; reason: number }
    | { t: "addToGroup"; group: Group; player: Player }
    | { t: "removeFromGroup"; group: Group; player: Player }
    | { t: "groupInfo"; group: Group }
    | { t: "peerInfo"; player: Player }
    | { t: "appDesc" }
    | { t: "connectComplete"; handle: number; ctx: number; hr: number; replyData: Uint8Array; localId: number }
    | { t: "asyncComplete"; handle: number; ctx: number; hr: number }
    | { t: "sendComplete"; handle: number; ctx: number; hr: number; sendTime: number; rtt: number; retries: number }
    | { t: "receive"; from: Player; data: Uint8Array }
    | { t: "indicateConnect"; ip: number; port: number; data: Uint8Array }
    | { t: "enumQuery"; ip: number; port: number; data: Uint8Array }
    | { t: "enumResponse"; ip: number; port: number; desc: AppDesc; data: Uint8Array; rtt: number }
    | { t: "hostMigrate"; newHost: Player }
    | { t: "terminate"; hr: number; data: Uint8Array };

export interface EventResult {
    ret: number;
    reply?: Uint8Array;
}

export type EventSink = (ev: EngineEvent) => Promise<EventResult>;

export interface OpHandle {
    hr: number;
    handle: number;
    result: Promise<number>;
}

type Session = "none" | "connecting" | "active" | "terminated";

interface ConnectAttempt {
    connId: number;
    ip: number;
    port: number;
    desc: AppDesc;
    data: Uint8Array;
    handle: number;
    ctx: number;
    sync: boolean;
    started: number;
    lastSent: number;
    resolve: (hr: number) => void;
}

interface EnumOp {
    kind: "enum";
    handle: number;
    ctx: number;
    nonce: number;
    app: string;
    target: { ip: number; port: number } | null;
    data: Uint8Array;
    count: number;
    interval: number;
    timeout: number;
    sent: number;
    lastSent: number;
    sync: boolean;
    resolve: (hr: number) => void;
}

interface SendOp {
    kind: "send";
    handle: number;
    ctx: number;
    flags: number;
    started: number;
    deadline: number;
    remaining: number;
    link: Link | null;
    sync: boolean;
    resolve: (hr: number) => void;
}

interface ConnectOp { kind: "connect"; attempt: ConnectAttempt }

type Op = EnumOp | SendOp | ConnectOp;

const TICK_MS = 100;
const CONNECT_RETRY_MS = 500;
const CONNECT_TIMEOUT_MS = 20000;
const CHUNK = 32000;
const MAX_UNRELIABLE = 60000;
const MAX_MESSAGE = 1 << 24;
const FIRST_ID = 0x100;
const REPLY_CACHE_MS = 30000;
const CLOSE_FLUSH_MS = 300;
const DEFAULT_ENUM_COUNT = 5;
const DEFAULT_ENUM_INTERVAL = 1500;
const EMPTY = new Uint8Array(0);

const keyOf = (ip: number, port: number): string => `${ip >>> 0}:${port}`;

export class Dp8Engine {
    session: Session = "none";
    localId = 0;
    hostId = 0;
    readonly players = new Map<number, Player>();
    readonly groups = new Map<number, Group>();

    private readonly t: Transport;
    private readonly links = new Map<string, Link>();
    private readonly ops = new Map<number, Op>();
    private readonly replyCache = new Map<string, { bytes: Uint8Array; at: number }>();
    private readonly pendingConnects = new Set<string>();
    private readonly flushWaiters: Array<{ deadline: number; done: () => void }> = [];
    private desc: AppDesc | null = null;
    private attempt: ConnectAttempt | null = null;
    private nextId = FIRST_ID;
    private nextGroup = 1;
    private nextHandle = 1;
    private info: { name: string; data: Uint8Array } = { name: "", data: EMPTY };
    private stopTimer: (() => void) | null;
    private closing = false;

    constructor(private readonly env: Env, private readonly sink: EventSink) {
        this.t = env.transport;
        this.t.onReceive = (ip, port, data) => this.onDatagram(ip, port, data);
        this.stopTimer = env.every(TICK_MS, () => this.tick());
    }

    dispose(): void {
        this.stopTimer?.();
        this.stopTimer = null;
        this.t.onReceive = null;
        this.t.close();
        this.resetSession();
    }

    get isHost(): boolean {
        return this.session === "active" && this.hostId === this.localId;
    }

    get localPort(): number { return this.t.port; }
    get localIp(): number { return this.t.ip; }

    ensureBound(): boolean {
        return this.t.port !== 0 || this.t.bind(0) !== 0;
    }

    private emit(ev: EngineEvent): Promise<EventResult> {
        return this.sink(ev).catch(() => ({ ret: Hr.E_FAIL }));
    }

    // ---- session description -------------------------------------------------------------

    getApplicationDesc(): AppDesc | null {
        return this.desc ? { ...this.desc, currentPlayers: this.players.size } : null;
    }

    async setApplicationDesc(desc: AppDesc): Promise<number> {
        if (!this.isHost || !this.desc) return Hr.NOTHOST;
        this.desc = { ...this.desc, flags: desc.flags, maxPlayers: desc.maxPlayers, sessionName: desc.sessionName, password: desc.password, reserved: desc.reserved, appReserved: desc.appReserved };
        const msg = this.appDescMessage();
        for (const p of this.remotePlayers()) this.queue(p.link!, msg);
        await this.emit({ t: "appDesc" });
        return Hr.OK;
    }

    private appDescMessage(): Uint8Array {
        const w = new Writer().u8(Msg.AppDesc);
        writeAppDesc(w, this.getApplicationDesc()!);
        return w.done();
    }

    setPeerInfo(name: string | null, data: Uint8Array | null): void {
        if (name !== null) this.info.name = name;
        if (data !== null) this.info.data = data;
        const me = this.players.get(this.localId);
        if (!me) return;
        me.name = this.info.name;
        me.data = this.info.data;
        const msg = new Writer().u8(Msg.PeerInfo).u32(me.id).str(me.name).bytes(me.data).done();
        for (const p of this.remotePlayers()) this.queue(p.link!, msg);
    }

    // ---- hosting ---------------------------------------------------------------------------

    async host(desc: AppDesc, port: number, portIsExplicit: boolean): Promise<number> {
        if (this.session !== "none") return Hr.ALREADYCONNECTED;
        if (!this.bindPort(port, !portIsExplicit)) return Hr.INVALIDDEVICEADDRESS;
        this.desc = { ...desc, instance: this.env.guid(), currentPlayers: 0 };
        this.localId = this.nextId++;
        this.hostId = this.localId;
        const me = this.addPlayer({ id: this.localId, ip: this.t.ip, port: this.t.port, local: true, name: this.info.name, data: this.info.data });
        this.session = "active";
        await this.emit({ t: "createPlayer", player: me });
        return Hr.OK;
    }

    private bindPort(port: number, fallbackToEphemeral: boolean): boolean {
        if (this.t.port !== 0 && this.t.port === port) return true;
        if (this.t.bind(port) !== 0) return true;
        return fallbackToEphemeral && this.t.bind(0) !== 0;
    }

    // ---- connecting ------------------------------------------------------------------------

    connect(desc: AppDesc, ip: number, port: number, data: Uint8Array, ctx: number, sync: boolean): OpHandle {
        if (this.session !== "none") return this.refused(Hr.ALREADYCONNECTED);
        if (!this.ensureBound()) return this.refused(Hr.E_FAIL);
        const handle = this.nextHandle++;
        const now = this.env.now();
        let resolve!: (hr: number) => void;
        const result = new Promise<number>(r => { resolve = r; });
        const a: ConnectAttempt = { connId: this.env.rand32() || 1, ip, port, desc, data, handle, ctx, sync, started: now, lastSent: now, resolve };
        this.attempt = a;
        this.session = "connecting";
        this.ops.set(handle, { kind: "connect", attempt: a });
        this.sendConnect(a);
        return { hr: Hr.OK, handle, result };
    }

    private refused(hr: number): OpHandle {
        return { hr, handle: 0, result: Promise.resolve(hr) };
    }

    private sendConnect(a: ConnectAttempt): void {
        const w = header(Dg.Connect).u32(a.connId).guid(a.desc.application).guid(a.desc.instance).str(a.desc.password)
            .bytes(a.data).str(this.info.name).bytes(this.info.data);
        this.t.send(a.ip, a.port, w.done());
        a.lastSent = this.env.now();
    }

    private failConnect(a: ConnectAttempt, hr: number, replyData: Uint8Array = EMPTY): void {
        if (this.attempt !== a) return;
        this.attempt = null;
        this.ops.delete(a.handle);
        this.session = "none";
        const done = a.sync ? Promise.resolve() : this.emit({ t: "connectComplete", handle: a.handle, ctx: a.ctx, hr, replyData, localId: 0 });
        void done.then(() => a.resolve(hr));
    }

    private onConnectReply(ip: number, port: number, r: Reader): void {
        const a = this.attempt;
        if (!a) return;
        if (r.u32() !== a.connId) return;
        const hr = r.u32();
        const replyData = r.bytes();
        if (hr !== 0) {
            this.failConnect(a, hr, replyData);
            return;
        }
        const localId = r.u32();
        const hostId = r.u32();
        const desc = readAppDesc(r);
        const records = [];
        for (let n = r.u32(); n > 0; n--) records.push(readPlayer(r));
        const groups = [];
        for (let n = r.u32(); n > 0; n--) groups.push(readGroup(r));

        this.attempt = null;
        this.ops.delete(a.handle);
        this.desc = desc;
        this.localId = localId;
        this.hostId = hostId;
        this.session = "active";
        records.sort((x, y) => (x.id === hostId ? -1 : y.id === hostId ? 1 : x.id - y.id));
        const created: Player[] = [];
        for (const rec of records) {
            const atHost = rec.id === hostId;
            created.push(this.addPlayer({ id: rec.id, ip: atHost ? ip : rec.ip, port: atHost ? port : rec.port, local: false, name: rec.name, data: rec.data }));
        }
        const me = this.addPlayer({ id: localId, ip: this.t.ip, port: this.t.port, local: true, name: this.info.name, data: this.info.data });
        for (const g of groups) this.applyGroupCreate(g, false);

        void (async () => {
            for (const p of created) await this.emit({ t: "createPlayer", player: p });
            await this.emit({ t: "createPlayer", player: me });
            if (!a.sync) await this.emit({ t: "connectComplete", handle: a.handle, ctx: a.ctx, hr: Hr.OK, replyData, localId });
            a.resolve(Hr.OK);
        })();
    }

    private async onConnect(ip: number, port: number, r: Reader): Promise<void> {
        const connId = r.u32();
        const app = r.guid();
        const instance = r.guid();
        const password = r.str();
        const data = r.bytes();
        const name = r.str();
        const playerData = r.bytes();
        const key = `${keyOf(ip, port)}:${connId}`;
        const cached = this.replyCache.get(key);
        if (cached) {
            this.t.send(ip, port, cached.bytes);
            return;
        }
        if (this.pendingConnects.has(key)) return;

        const refuse = (hr: number, replyData: Uint8Array<ArrayBufferLike> = EMPTY): void => {
            const bytes = header(Dg.ConnectReply).u32(connId).u32(hr).bytes(replyData).done();
            this.replyCache.set(key, { bytes, at: this.env.now() });
            this.t.send(ip, port, bytes);
        };
        const d = this.desc;
        if (!this.isHost || !d) return refuse(Hr.NOTHOST);
        if (app !== ZERO_GUID && app !== d.application) return refuse(Hr.INVALIDAPPLICATION);
        if (instance !== ZERO_GUID && instance !== d.instance) return refuse(Hr.INVALIDINSTANCE);
        if (d.password && d.password !== password) return refuse(Hr.INVALIDPASSWORD);
        if (d.maxPlayers && this.players.size >= d.maxPlayers) return refuse(Hr.SESSIONFULL);

        this.pendingConnects.add(key);
        let verdict: { ret: number; reply?: Uint8Array };
        try {
            verdict = await this.emit({ t: "indicateConnect", ip, port, data });
        } finally {
            this.pendingConnects.delete(key);
        }
        if (verdict.ret !== 0) return refuse(Hr.HOSTREJECTEDCONNECTION, verdict.reply ?? EMPTY);
        if (!this.isHost || !this.desc) return;
        if (this.desc.maxPlayers && this.players.size >= this.desc.maxPlayers) return refuse(Hr.SESSIONFULL);

        const stale = this.links.get(keyOf(ip, port));
        const staleOwner = stale && this.players.get(stale.playerId);
        if (staleOwner) await this.removePlayer(staleOwner, DestroyReason.CONNECTIONLOST);

        const existing = [...this.players.values()];
        const id = this.nextId;
        const joiner = this.addPlayer({ id, ip, port, local: false, name, data: playerData });

        const w = header(Dg.ConnectReply).u32(connId).u32(Hr.OK).bytes(verdict.reply ?? EMPTY).u32(id).u32(this.hostId);
        writeAppDesc(w, { ...this.getApplicationDesc()!, password: "" });
        w.u32(existing.length);
        for (const p of existing) writePlayer(w, { id: p.id, ip: p.local ? this.t.ip : p.ip, port: p.local ? this.t.port : p.port, flags: 0, name: p.name, data: p.data });
        w.u32(this.groups.size);
        for (const g of this.groups.values()) writeGroup(w, { id: g.id, flags: g.flags, name: g.name, data: g.data, members: [...g.members] });
        const bytes = w.done();
        this.replyCache.set(key, { bytes, at: this.env.now() });

        const add = new Writer().u8(Msg.PeerAdd);
        writePlayer(add, { id, ip, port, flags: 0, name, data: playerData });
        const addMsg = add.done();
        for (const p of existing) if (!p.local) this.queue(p.link!, addMsg);
        this.t.send(ip, port, bytes);
        await this.emit({ t: "createPlayer", player: joiner });
    }

    // ---- enumeration -----------------------------------------------------------------------

    enumHosts(app: string, target: { ip: number; port: number } | null, data: Uint8Array, count: number, interval: number, timeout: number, ctx: number, sync: boolean): OpHandle {
        if (!this.ensureBound()) return this.refused(Hr.E_FAIL);
        const handle = this.nextHandle++;
        let resolve!: (hr: number) => void;
        const result = new Promise<number>(r => { resolve = r; });
        const op: EnumOp = {
            kind: "enum", handle, ctx, nonce: this.env.rand32() || 1, app, target, data,
            count: count || DEFAULT_ENUM_COUNT, interval: interval || DEFAULT_ENUM_INTERVAL,
            timeout: timeout || interval || DEFAULT_ENUM_INTERVAL, sent: 0, lastSent: 0, sync, resolve,
        };
        this.ops.set(handle, op);
        this.sendEnumQuery(op);
        return { hr: Hr.OK, handle, result };
    }

    private sendEnumQuery(op: EnumOp): void {
        const q = header(Dg.EnumQuery).u32(op.nonce).guid(op.app).bytes(op.data).done();
        if (op.target) this.t.send(op.target.ip, op.target.port, q);
        else this.t.broadcast(DPN_DEFAULT_PORT, q);
        op.sent++;
        op.lastSent = this.env.now();
    }

    private finishEnum(op: EnumOp, hr: number): void {
        if (!this.ops.delete(op.handle)) return;
        const done = op.sync ? Promise.resolve() : this.emit({ t: "asyncComplete", handle: op.handle, ctx: op.ctx, hr });
        void done.then(() => op.resolve(hr));
    }

    private onEnumQuery(ip: number, port: number, r: Reader): void {
        const nonce = r.u32();
        const app = r.guid();
        const data = r.bytes();
        const d = this.desc;
        if (!this.isHost || !d) return;
        if (app !== ZERO_GUID && app !== d.application) return;
        void this.emit({ t: "enumQuery", ip, port, data }).then(res => {
            if (res.ret !== 0 || !this.isHost) return;
            const w = header(Dg.EnumResponse).u32(nonce);
            writeAppDesc(w, { ...this.getApplicationDesc()!, password: "" });
            this.t.send(ip, port, w.bytes(res.reply ?? EMPTY).done());
        });
    }

    private onEnumResponse(ip: number, port: number, r: Reader): void {
        const nonce = r.u32();
        const desc = readAppDesc(r);
        const data = r.bytes();
        for (const op of this.ops.values()) {
            if (op.kind !== "enum" || op.nonce !== nonce) continue;
            void this.emit({ t: "enumResponse", ip, port, desc, data, rtt: Math.max(0, Math.round(this.env.now() - op.lastSent)) });
            return;
        }
    }

    // ---- cancellation ----------------------------------------------------------------------

    cancel(handle: number, flags: number): number {
        if (handle !== 0) {
            const op = this.ops.get(handle);
            if (!op) return Hr.INVALIDHANDLE;
            this.cancelOp(op);
            return Hr.OK;
        }
        const all = (flags & CancelFlag.ALL_OPERATIONS) !== 0;
        let found = false;
        for (const op of [...this.ops.values()]) {
            const wanted = all
                || (op.kind === "connect" && (flags & CancelFlag.CONNECT) !== 0)
                || (op.kind === "enum" && (flags & CancelFlag.ENUM) !== 0)
                || (op.kind === "send" && (flags & CancelFlag.SEND) !== 0);
            if (!wanted) continue;
            this.cancelOp(op);
            found = true;
        }
        return found ? Hr.OK : Hr.CANNOTCANCEL;
    }

    private cancelOp(op: Op): void {
        if (op.kind === "enum") this.finishEnum(op, Hr.USERCANCEL);
        else if (op.kind === "connect") this.failConnect(op.attempt, Hr.USERCANCEL);
        else this.finishSend(op, Hr.USERCANCEL);
    }

    // ---- data ------------------------------------------------------------------------------

    send(toId: number, data: Uint8Array, flags: number, timeoutMs: number, ctx: number, sync: boolean): OpHandle {
        if (this.session !== "active") return this.refused(Hr.NOCONNECTION);
        if (data.length > MAX_MESSAGE) return this.refused(Hr.SENDTOOLARGE);
        const targets: Player[] = [];
        if (toId === 0) {
            targets.push(...this.players.values());
        } else if (this.groups.has(toId)) {
            for (const id of this.groups.get(toId)!.members) {
                const p = this.players.get(id);
                if (p) targets.push(p);
            }
        } else {
            const p = this.players.get(toId);
            if (!p) return this.refused(toId & 0x80000000 ? Hr.INVALIDGROUP : Hr.INVALIDPLAYER);
            targets.push(p);
        }
        const handle = this.nextHandle++;
        const now = this.env.now();
        let resolve!: (hr: number) => void;
        const result = new Promise<number>(r => { resolve = r; });
        const op: SendOp = { kind: "send", handle, ctx, flags, started: now, deadline: timeoutMs > 0 ? now + timeoutMs : Infinity, remaining: 0, link: null, sync, resolve };
        this.ops.set(handle, op);

        const reliable = (flags & SendFlag.GUARANTEED) !== 0 || data.length > MAX_UNRELIABLE;
        for (const p of targets) {
            if (p.local) {
                if (toId === 0 && (flags & SendFlag.NOLOOPBACK)) continue;
                void this.emit({ t: "receive", from: p, data: data.slice() });
                continue;
            }
            if (!p.link) continue;
            if (reliable) {
                op.remaining++;
                op.link = p.link;
                this.queueData(p.link, flags, data, () => {
                    if (--op.remaining === 0) this.finishSend(op, Hr.OK);
                });
            } else {
                const w = header(Dg.Unreliable).u32(this.localId).u32(p.id).u32(flags).raw(data);
                this.t.send(p.ip, p.port, w.done());
                p.link.sentPackets++;
                p.link.sentBytes += data.length;
            }
        }
        if (op.remaining === 0) queueMicrotask(() => this.finishSend(op, Hr.OK));
        return { hr: sync ? Hr.OK : Hr.PENDING, handle, result };
    }

    private queueData(link: Link, flags: number, data: Uint8Array, onAcked: () => void): void {
        for (let off = 0; off < data.length || off === 0; off += CHUNK) {
            const end = Math.min(off + CHUNK, data.length);
            const frag = data.length <= CHUNK ? 0 : end === data.length ? 2 : 1;
            const msg = new Writer().u8(Msg.Data).u32(flags).u8(frag).bytes(data.subarray(off, end)).done();
            this.queue(link, msg, end === data.length ? onAcked : null);
            if (end === data.length) break;
        }
    }

    private finishSend(op: SendOp, hr: number): void {
        if (!this.ops.delete(op.handle)) return;
        const elapsed = Math.round(this.env.now() - op.started);
        let done: Promise<unknown> = Promise.resolve();
        if (!op.sync && !(op.flags & SendFlag.NOCOMPLETE)) {
            done = this.emit({ t: "sendComplete", handle: op.handle, ctx: op.ctx, hr, sendTime: elapsed, rtt: Math.round(op.link?.srtt ?? 0), retries: op.link?.retriedPackets ?? 0 });
        }
        void done.then(() => op.resolve(hr));
    }

    sendQueueInfo(id: number): { messages: number; bytes: number } | null {
        const p = this.players.get(id);
        if (!p) return null;
        return { messages: p.link?.unacked.length ?? 0, bytes: p.link?.queuedBytes ?? 0 };
    }

    // ---- players and groups ----------------------------------------------------------------

    private remotePlayers(): Player[] {
        const out: Player[] = [];
        for (const p of this.players.values()) if (!p.local && p.link) out.push(p);
        return out;
    }

    private addPlayer(init: Omit<Player, "ctx" | "link">): Player {
        const p: Player = { ...init, ctx: 0, link: null };
        if (!p.local) {
            p.link = new Link(p.ip, p.port, this.env.now());
            p.link.playerId = p.id;
            this.links.set(keyOf(p.ip, p.port), p.link);
        }
        this.players.set(p.id, p);
        if (p.id >= this.nextId) this.nextId = p.id + 1;
        return p;
    }

    private async removePlayer(p: Player, reason: number): Promise<void> {
        if (this.players.get(p.id) !== p) return;
        this.players.delete(p.id);
        if (p.link) this.links.delete(keyOf(p.ip, p.port));
        for (const g of this.groups.values()) g.members.delete(p.id);
        const wasHost = p.id === this.hostId;
        await this.emit({ t: "destroyPlayer", player: p, reason });
        if (wasHost && !p.local && !this.closing && this.session === "active") await this.onHostLost();
    }

    private async onHostLost(): Promise<void> {
        const desc = this.desc;
        if (desc && (desc.flags & SESSION_MIGRATE_HOST) && this.players.size > 0) {
            const next = Math.min(...this.players.keys());
            this.hostId = next;
            await this.emit({ t: "hostMigrate", newHost: this.players.get(next)! });
            return;
        }
        this.session = "terminated";
        await this.emit({ t: "terminate", hr: Hr.CONNECTIONLOST, data: EMPTY });
    }

    playerEndpoint(id: number): { ip: number; port: number } | null {
        const p = this.players.get(id);
        return p ? { ip: p.ip, port: p.port } : null;
    }

    createGroup(flags: number, name: string, data: Uint8Array): Group | null {
        if (this.session !== "active") return null;
        const id = (0x80000000 | ((this.localId & 0x7fff) << 16) | (this.nextGroup++ & 0xffff)) >>> 0;
        const g = this.applyGroupCreate({ id, flags, name, data, members: [] }, true);
        const w = new Writer().u8(Msg.GroupCreate);
        writeGroup(w, { id, flags, name, data, members: [] });
        const msg = w.done();
        for (const p of this.remotePlayers()) this.queue(p.link!, msg);
        return g;
    }

    private applyGroupCreate(rec: { id: number; flags: number; name: string; data: Uint8Array; members: number[] }, announce: boolean): Group {
        const owner = (rec.id >>> 16) & 0x7fff;
        const g: Group = { id: rec.id, owner, flags: rec.flags, name: rec.name, data: rec.data, ctx: 0, members: new Set(rec.members) };
        this.groups.set(g.id, g);
        if (announce) void this.emit({ t: "createGroup", group: g });
        return g;
    }

    async destroyGroup(id: number): Promise<number> {
        const g = this.groups.get(id);
        if (!g) return Hr.INVALIDGROUP;
        const msg = new Writer().u8(Msg.GroupDestroy).u32(id).done();
        for (const p of this.remotePlayers()) this.queue(p.link!, msg);
        this.groups.delete(id);
        await this.emit({ t: "destroyGroup", group: g, reason: DestroyReason.NORMAL });
        return Hr.OK;
    }

    async groupMember(group: number, player: number, add: boolean): Promise<number> {
        const g = this.groups.get(group);
        if (!g) return Hr.INVALIDGROUP;
        const p = this.players.get(player);
        if (!p) return Hr.INVALIDPLAYER;
        if (add === g.members.has(player)) return add ? Hr.ALREADYCONNECTED : Hr.DOESNOTEXIST;
        const msg = new Writer().u8(add ? Msg.GroupAdd : Msg.GroupRemove).u32(group).u32(player).done();
        for (const r of this.remotePlayers()) this.queue(r.link!, msg);
        if (add) g.members.add(player); else g.members.delete(player);
        await this.emit({ t: add ? "addToGroup" : "removeFromGroup", group: g, player: p });
        return Hr.OK;
    }

    async setGroupInfo(id: number, name: string | null, data: Uint8Array | null): Promise<number> {
        const g = this.groups.get(id);
        if (!g) return Hr.INVALIDGROUP;
        if (name !== null) g.name = name;
        if (data !== null) g.data = data;
        const msg = new Writer().u8(Msg.GroupInfo).u32(id).str(g.name).bytes(g.data).done();
        for (const p of this.remotePlayers()) this.queue(p.link!, msg);
        await this.emit({ t: "groupInfo", group: g });
        return Hr.OK;
    }

    // ---- teardown --------------------------------------------------------------------------

    async terminateSession(data: Uint8Array): Promise<number> {
        if (!this.isHost) return Hr.NOTHOST;
        const msg = new Writer().u8(Msg.Terminate).bytes(data).done();
        for (const p of this.remotePlayers()) this.queue(p.link!, msg);
        await this.flush(CLOSE_FLUSH_MS);
        this.session = "terminated";
        await this.emit({ t: "terminate", hr: Hr.HOSTTERMINATEDSESSION, data });
        return Hr.OK;
    }

    async destroyPeer(id: number, data: Uint8Array): Promise<number> {
        if (!this.isHost) return Hr.NOTHOST;
        const p = this.players.get(id);
        if (!p || p.local) return Hr.INVALIDPLAYER;
        this.queue(p.link!, new Writer().u8(Msg.Terminate).bytes(data).done());
        await this.flush(CLOSE_FLUSH_MS);
        await this.removePlayer(p, DestroyReason.HOSTDESTROYEDPLAYER);
        const gone = new Writer().u8(Msg.PeerGone).u32(id).u32(DestroyReason.HOSTDESTROYEDPLAYER).done();
        for (const r of this.remotePlayers()) this.queue(r.link!, gone);
        return Hr.OK;
    }

    async close(): Promise<void> {
        this.closing = true;
        for (const op of [...this.ops.values()]) this.cancelOp(op);
        if (this.session === "active") {
            const bye = new Writer().u8(Msg.Leave).done();
            for (const p of this.remotePlayers()) this.queue(p.link!, bye);
            await this.flush(CLOSE_FLUSH_MS);
        }
        const all = [...this.players.values()].sort((a, b) => Number(a.local) - Number(b.local));
        for (const g of [...this.groups.values()]) await this.emit({ t: "destroyGroup", group: g, reason: DestroyReason.NORMAL });
        for (const p of all) await this.emit({ t: "destroyPlayer", player: p, reason: DestroyReason.NORMAL });
        this.resetSession();
        this.t.close();
        this.closing = false;
    }

    private resetSession(): void {
        this.players.clear();
        this.groups.clear();
        this.links.clear();
        this.replyCache.clear();
        this.pendingConnects.clear();
        this.attempt = null;
        this.desc = null;
        this.session = "none";
        this.localId = 0;
        this.hostId = 0;
        this.nextId = FIRST_ID;
        this.nextGroup = 1;
        for (const w of this.flushWaiters.splice(0)) w.done();
    }

    private flush(ms: number): Promise<void> {
        if (this.remotePlayers().every(p => p.link!.unacked.length === 0)) return Promise.resolve();
        return new Promise(done => { this.flushWaiters.push({ deadline: this.env.now() + ms, done }); });
    }

    connectionInfo(id: number): Link | null {
        return this.players.get(id)?.link ?? null;
    }

    // ---- wire ------------------------------------------------------------------------------

    private queue(link: Link, payload: Uint8Array, onAcked: (() => void) | null = null): void {
        link.queue(payload, this.env.now(), this.xmit(link), onAcked);
    }

    private xmit(link: Link): Xmit {
        return d => this.t.send(link.ip, link.port, d);
    }

    private onDatagram(ip: number, port: number, data: Uint8Array): void {
        const type = datagramType(data);
        if (!type) return;
        try {
            const r = new Reader(data.subarray(3));
            switch (type) {
                case Dg.EnumQuery: this.onEnumQuery(ip, port, r); break;
                case Dg.EnumResponse: this.onEnumResponse(ip, port, r); break;
                case Dg.Connect: void this.onConnect(ip, port, r).catch(() => undefined); break;
                case Dg.ConnectReply: this.onConnectReply(ip, port, r); break;
                case Dg.Segment: this.onSegment(ip, port, r); break;
                case Dg.Unreliable: this.onUnreliable(ip, port, r); break;
            }
        } catch {
            // truncated or hostile datagram: drop
        }
    }

    private onUnreliable(ip: number, port: number, r: Reader): void {
        const link = this.links.get(keyOf(ip, port));
        const from = link && this.players.get(link.playerId);
        if (!from) return;
        r.u32();
        r.u32();
        r.u32();
        link.recvPackets++;
        link.recvBytes += r.left;
        void this.emit({ t: "receive", from, data: r.raw(r.left).slice() });
    }

    private onSegment(ip: number, port: number, r: Reader): void {
        const link = this.links.get(keyOf(ip, port));
        if (!link) return;
        const now = this.env.now();
        const seq = r.u32();
        const ack = r.u32();
        link.onAck(ack, now);
        if (seq === 0) return;
        const delivered = link.receive(seq, r.raw(r.left).slice(), now);
        link.sendAck(now, this.xmit(link));
        for (const payload of delivered) {
            if (this.links.get(keyOf(ip, port)) !== link) break;
            try {
                this.onMessage(link, new Reader(payload));
            } catch {
                // malformed message inside a valid segment: skip it
            }
        }
    }

    private onMessage(link: Link, r: Reader): void {
        const from = this.players.get(link.playerId);
        if (!from) return;
        const fromHost = from.id === this.hostId;
        switch (r.u8()) {
            case Msg.Data: {
                r.u32();
                const frag = r.u8();
                const chunk = r.bytes();
                if (frag === 0) {
                    void this.emit({ t: "receive", from, data: chunk });
                } else {
                    link.fragments.push(chunk);
                    if (frag === 2) {
                        const total = link.fragments.reduce((n, c) => n + c.length, 0);
                        const whole = new Uint8Array(total);
                        let off = 0;
                        for (const c of link.fragments) { whole.set(c, off); off += c.length; }
                        link.fragments = [];
                        void this.emit({ t: "receive", from, data: whole });
                    }
                }
                break;
            }
            case Msg.PeerAdd: {
                if (!fromHost) break;
                const rec = readPlayer(r);
                if (this.players.has(rec.id) || rec.id === this.localId) break;
                const p = this.addPlayer({ id: rec.id, ip: rec.ip, port: rec.port, local: false, name: rec.name, data: rec.data });
                void this.emit({ t: "createPlayer", player: p });
                break;
            }
            case Msg.PeerInfo: {
                const p = this.players.get(r.u32());
                if (!p || p.local || p.id !== from.id) break;
                p.name = r.str();
                p.data = r.bytes();
                void this.emit({ t: "peerInfo", player: p });
                break;
            }
            case Msg.Leave:
                void this.removePlayer(from, DestroyReason.NORMAL);
                break;
            case Msg.PeerGone: {
                if (!fromHost) break;
                const p = this.players.get(r.u32());
                const reason = r.u32();
                if (p && !p.local) void this.removePlayer(p, reason);
                break;
            }
            case Msg.Terminate:
                if (!fromHost) break;
                this.session = "terminated";
                void this.emit({ t: "terminate", hr: Hr.HOSTTERMINATEDSESSION, data: r.bytes() });
                break;
            case Msg.AppDesc:
                if (!fromHost) break;
                this.desc = readAppDesc(r);
                void this.emit({ t: "appDesc" });
                break;
            case Msg.Ping:
                break;
            case Msg.GroupCreate: {
                const rec = readGroup(r);
                if (!this.groups.has(rec.id)) this.applyGroupCreate(rec, true);
                break;
            }
            case Msg.GroupDestroy: {
                const g = this.groups.get(r.u32());
                if (!g) break;
                this.groups.delete(g.id);
                void this.emit({ t: "destroyGroup", group: g, reason: DestroyReason.NORMAL });
                break;
            }
            case Msg.GroupAdd: {
                const g = this.groups.get(r.u32());
                const p = this.players.get(r.u32());
                if (!g || !p || g.members.has(p.id)) break;
                g.members.add(p.id);
                void this.emit({ t: "addToGroup", group: g, player: p });
                break;
            }
            case Msg.GroupRemove: {
                const g = this.groups.get(r.u32());
                const p = this.players.get(r.u32());
                if (!g || !p || !g.members.delete(p.id)) break;
                void this.emit({ t: "removeFromGroup", group: g, player: p });
                break;
            }
            case Msg.GroupInfo: {
                const g = this.groups.get(r.u32());
                if (!g) break;
                g.name = r.str();
                g.data = r.bytes();
                void this.emit({ t: "groupInfo", group: g });
                break;
            }
        }
    }

    // ---- timers ----------------------------------------------------------------------------

    tick(): void {
        const now = this.env.now();
        const lost: Player[] = [];
        for (const p of this.players.values()) {
            const link = p.link;
            if (!link) continue;
            if (!link.tick(now, this.xmit(link))) {
                lost.push(p);
            } else if (link.unacked.length === 0 && link.idleFor(now) >= PING_AFTER_MS) {
                this.queue(link, new Writer().u8(Msg.Ping).done());
            }
        }
        for (const p of lost) void this.removePlayer(p, DestroyReason.CONNECTIONLOST);

        const a = this.attempt;
        if (a) {
            if (now - a.started >= CONNECT_TIMEOUT_MS) this.failConnect(a, Hr.NORESPONSE);
            else if (now - a.lastSent >= CONNECT_RETRY_MS) this.sendConnect(a);
        }

        for (const op of [...this.ops.values()]) {
            if (op.kind === "enum") {
                const infinite = op.count === INFINITE;
                if ((infinite || op.sent < op.count) && now - op.lastSent >= op.interval) this.sendEnumQuery(op);
                else if (!infinite && op.sent >= op.count && now - op.lastSent >= op.timeout) this.finishEnum(op, Hr.OK);
            } else if (op.kind === "send" && now >= op.deadline) {
                this.finishSend(op, Hr.TIMEDOUT);
            }
        }

        for (const [k, v] of this.replyCache) if (now - v.at > REPLY_CACHE_MS) this.replyCache.delete(k);

        if (this.flushWaiters.length) {
            const drained = this.remotePlayers().every(p => p.link!.unacked.length === 0);
            for (const w of this.flushWaiters.splice(0)) {
                if (drained || now >= w.deadline) w.done();
                else this.flushWaiters.push(w);
            }
        }
    }
}
