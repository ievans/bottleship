/**
 * DirectPlay 8 (dpnet.dll): the peer session object, the address object and the lobbied
 * application object. The session itself is Dp8Engine (modules/dpnet/), carried over the
 * virtual-LAN UDP stack; this file is the COM surface around it.
 *
 * The application's message handler runs as real guest code on the shared callback-pump thread,
 * one message at a time and in the order the engine produced them. A handler's return value and
 * the fields it fills in (a player context, connect reply data, an enum response) are read back
 * after it returns and handed to the engine, which is waiting on exactly that.
 */

import { dpnetModule } from "../api/dpnet.api";
import { createVTablesFromDescriptor, VTableInfo } from "../api/adapters/module-adapter";
import { BaseComObject } from "../core/com/base-com-object";
import { allocateComObject } from "../core/com/com-memory";
import { InterfaceRegistry } from "../core/com/interface-registry";
import { Logger, LogCategory } from "../core/logger";
import { isValidAddress } from "../core/memory/address-guard";
import { Mem } from "../core/memory/mem-accessor";
import { IModule } from "../core/module";
import { Process } from "../core/process";
import { SystemResourceProvider } from "../core/resources/system-resource-provider";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import type { WinMM } from "./winmm";
import { ipToString } from "../../net/lan-protocol";
import { lanStack } from "../net/lan";
import {
    CLSID_DP8SP_TCPIP, DPNA_DATATYPE_BINARY, DPNA_DATATYPE_DWORD, DPNA_DATATYPE_GUID, DPNA_DATATYPE_STRING,
    DPNA_KEY_DEVICE, DPNA_KEY_HOSTNAME, DPNA_KEY_PORT, DPNA_KEY_PROVIDER, DPN_DEFAULT_PORT, Dp8Address,
    bytesToGuid, endpointAddress, guidToBytes, normalizeGuid,
} from "./dpnet/dpnet-address";
import { Hr, Msgid, OP_SYNC, PLAYER_HOST, PLAYER_LOCAL, SendFlag } from "./dpnet/dpnet-constants";
import {
    Dp8Engine, type EngineEvent, type EventResult, type Group, type OpHandle, type Player,
} from "./dpnet/dpnet-engine";
import { LanTransport } from "./dpnet/dpnet-transport";
import { type AppDesc, ZERO_GUID } from "./dpnet/dpnet-wire";

export const CLSID_DirectPlay8Peer = "286f484d-375e-4458-a272-b138e2f80a6a";
export const CLSID_DirectPlay8Address = "934a9523-a3ca-4bc5-ada0-d6d95d979421";
export const CLSID_DirectPlay8LobbiedApplication = "667955ad-6b3b-43ca-b949-bc69b5baff7f";

const IID_IUnknown = "00000000-0000-0000-c000-000000000046";
const IID_IDirectPlay8Peer = "5102dacf-241b-11d3-aea7-006097b01411";
const IID_IDirectPlay8Address = "83783300-4063-4c8a-9db3-82830a7feb31";
const IID_IDirectPlay8LobbiedApplication = "819074a3-016c-11d3-ae14-006097b01411";

const S_OK = 0;
const S_FALSE = 1;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;

const APPDESC_SIZE = 0x48;
const PLAYER_INFO_SIZE = 0x18;
const GROUP_INFO_SIZE = 0x18;
const CAPS_SIZE = 0x14;
const SP_CAPS_SIZE = 0x24;
const CONNECTION_INFO_SIZE = 0x5c;
const SP_INFO_SIZE = 0x20;
const INFO_NAME = 0x1;
const INFO_DATA = 0x2;
const ENUM_PLAYERS = 0x1;
const ENUM_GROUPS = 0x10;
const FIRST_OP_HANDLE = 0x40000000;
const MAX_GUEST_BYTES = 64 * 1024 * 1024;
const MAX_REPLY_BYTES = 8192;
const MAX_STRING_CHARS = 1024;

const SERVICE_PROVIDER_NAME = "DirectPlay8 TCP/IP Service Provider";
const DEVICE_NAME = "Virtual LAN Adapter";
const DEVICE_GUID = "5b8b3e4c-0a6d-4f5d-9f6e-5f9e6d0b1a01";

function validPointer(ptr: number, size: number, perms: "r" | "rw"): boolean {
    const mem = Mem.getView();
    return !!ptr && !!mem && ptr + size <= mem.length && isValidAddress(mem, ptr, size, perms);
}

function guidAt(address: number): string {
    const b = Mem.readBytes(address, 16);
    return b ? bytesToGuid(b) : "";
}

function readWide(address: number, maxChars: number): string {
    let out = "";
    for (let i = 0; address && i < maxChars; i++) {
        const code = Mem.readUint16(address + i * 2);
        if (!code) break;
        out += String.fromCharCode(code);
    }
    return out;
}

function readAnsi(address: number, maxChars: number): string {
    let out = "";
    for (let i = 0; address && i < maxChars; i++) {
        const code = Mem.readUint8(address + i);
        if (!code) break;
        out += String.fromCharCode(code);
    }
    return out;
}

function wideBytes(s: string): Uint8Array {
    const out = new Uint8Array((s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) {
        out[i * 2] = s.charCodeAt(i) & 0xff;
        out[i * 2 + 1] = s.charCodeAt(i) >> 8;
    }
    return out;
}

function ansiBytes(s: string): Uint8Array {
    const out = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

function wideFromBytes(b: Uint8Array): string {
    let out = "";
    for (let i = 0; i + 1 < b.length; i += 2) {
        const code = b[i]! | (b[i + 1]! << 8);
        if (!code) break;
        out += String.fromCharCode(code);
    }
    return out;
}

/** Copies `len` guest bytes, or null when the range is not readable. A zero length is an empty array. */
function readGuestBytes(ptr: number, len: number): Uint8Array | null {
    if (len === 0) return new Uint8Array(0);
    if (len > MAX_GUEST_BYTES || !validPointer(ptr, len, "r")) return null;
    const b = Mem.readBytes(ptr, len);
    return b ? b.slice() : null;
}

function out32(ptr: number, value: number): void {
    if (ptr && validPointer(ptr, 4, "rw")) Mem.writeUint32(ptr, value >>> 0);
}

function w32(base: number, offset: number, value: number): void {
    Mem.writeUint32(base + offset, value >>> 0);
}

function r32(base: number, offset: number): number {
    return Mem.readUint32(base + offset) ?? 0;
}

function comRelease(ptr: number): void {
    if (ptr) SystemResourceProvider.getInstance().getComObjectByAddress(ptr)?.release(ptr);
}

type GuestMemory = Process["memory"];

/** Guest scratch for one callback; everything it handed out is freed together. */
class Arena {
    private readonly ptrs: number[] = [];

    constructor(private readonly memory: GuestMemory) {}

    alloc(size: number): number {
        const ptr = this.memory.alloc(Math.max(4, (size + 3) & ~3)) >>> 0;
        if (!ptr) return 0;
        Mem.writeBytes(ptr, new Uint8Array(Math.max(4, (size + 3) & ~3)));
        this.ptrs.push(ptr);
        return ptr;
    }

    bytes(data: Uint8Array): number {
        if (data.length === 0) return 0;
        const ptr = this.alloc(data.length);
        if (ptr) Mem.writeBytes(ptr, data);
        return ptr;
    }

    wide(s: string): number {
        return s ? this.bytes(wideBytes(s)) : 0;
    }

    detach(ptr: number): void {
        const i = this.ptrs.indexOf(ptr);
        if (i >= 0) this.ptrs.splice(i, 1);
    }

    free(): void {
        for (const p of this.ptrs.splice(0)) this.memory.free(p);
    }
}

interface Job {
    msgId: number;
    size: number;
    build(msg: number, arena: Arena): void;
    finish(msg: number, eax: number, arena: Arena): EventResult;
    done(result: EventResult): void;
}

abstract class Dp8Object extends BaseComObject {
    readonly addresses = new Map<string, number>();
    abstract readonly primaryVtable: string;
    abstract readonly interfaces: Readonly<Record<string, string>>;
    onDestroy: (() => void) | null = null;

    constructor() {
        super(IID_IUnknown, 0);
    }

    protected destroy(): void {
        this.onDestroy?.();
        this.onDestroy = null;
        this.addresses.clear();
    }
}

class AddressObject extends Dp8Object {
    readonly primaryVtable = "IDirectPlay8Address";
    readonly interfaces = { [IID_IDirectPlay8Address]: "IDirectPlay8Address" };

    constructor(public addr: Dp8Address = new Dp8Address()) {
        super();
    }
}

class LobbyObject extends Dp8Object {
    readonly primaryVtable = "IDirectPlay8LobbiedApplication";
    readonly interfaces = { [IID_IDirectPlay8LobbiedApplication]: "IDirectPlay8LobbiedApplication" };
    initialized = false;
}

interface Caps { flags: number; connectTimeout: number; connectRetries: number; keepAlive: number }

interface SpCaps {
    flags: number; numThreads: number; enumCount: number; enumRetryInterval: number; enumTimeout: number;
    maxEnumPayload: number; buffersPerThread: number; systemBufferSize: number;
}

class PeerObject extends Dp8Object {
    readonly primaryVtable = "IDirectPlay8Peer";
    readonly interfaces = { [IID_IDirectPlay8Peer]: "IDirectPlay8Peer" };
    engine: Dp8Engine | null = null;
    transport: LanTransport | null = null;
    handler = 0;
    handlerCtx = 0;
    localCtx = 0;
    readonly queue: Job[] = [];
    pumping = false;
    nextOpHandle = FIRST_OP_HANDLE;
    nextBuffer = 1;
    readonly buffers = new Map<number, number>();
    readonly sendBuffers = new Map<number, Uint8Array>();
    caps: Caps = { flags: 0, connectTimeout: 200, connectRetries: 14, keepAlive: 60000 };
    spCaps: SpCaps = {
        flags: 0x0f, numThreads: 3, enumCount: 5, enumRetryInterval: 1500, enumTimeout: 1500,
        maxEnumPayload: 983, buffersPerThread: 1, systemBufferSize: 0,
    };
}

export class Dpnet implements IModule {
    name = "dpnet";
    exports: Record<string, ThunkImplementation> = {};
    vtables: Record<string, VTableInfo> = {};
    private process!: Process;
    private readonly peers = new Set<PeerObject>();

    initialize(process: Process): void {
        this.process = process;
        InterfaceRegistry.getInstance().registerFromModuleDescriptor(dpnetModule);
        this.vtables = createVTablesFromDescriptor(this.process, dpnetModule);
        for (const iface of dpnetModule.interfaces ?? []) this.registerUnknownExports(iface.name);
        this.registerPeerExports();
        this.registerAddressExports();
        this.registerLobbyExports();
    }

    reset(): void {
        for (const peer of [...this.peers]) this.shutdown(peer);
        this.peers.clear();
    }

    recreateVTables(): void {
        if (this.process) this.vtables = createVTablesFromDescriptor(this.process, dpnetModule);
    }

    // ── objects and interfaces ──────────────────────────────────────────────────

    private object<T extends Dp8Object>(thisPtr: number | undefined, type: abstract new (...a: never[]) => T): T | null {
        if (!thisPtr) return null;
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(thisPtr >>> 0);
        return obj instanceof type ? obj : null;
    }

    private addressOf(obj: Dp8Object, vtableName: string): number {
        const known = obj.addresses.get(vtableName);
        if (known) return known;
        const vtable = this.vtables[vtableName];
        const mem = Mem.getView();
        if (!vtable || !mem) return 0;
        const address = allocateComObject(this.process.memory, mem, vtable.address) >>> 0;
        SystemResourceProvider.getInstance().mapAddressToHandle(address, obj.handle);
        obj.addresses.set(vtableName, address);
        return address;
    }

    private queryInterface(obj: Dp8Object, iid: string, ppOut: number): number {
        if (!validPointer(ppOut, 4, "rw")) return E_POINTER;
        const vtableName = iid === IID_IUnknown ? obj.primaryVtable : obj.interfaces[iid];
        const address = vtableName ? this.addressOf(obj, vtableName) : 0;
        if (!address) {
            Mem.writeUint32(ppOut, 0);
            return E_NOINTERFACE;
        }
        Mem.writeUint32(ppOut, address);
        obj.addRef();
        return S_OK;
    }

    private registerUnknownExports(iface: string): void {
        const e = this.exports;
        e[`${iface}_QueryInterface`] = (_c, _m, a) => {
            if (!validPointer(a[1] >>> 0, 16, "r")) return E_POINTER | 0;
            const obj = this.object(a[0], Dp8Object);
            if (!obj) {
                out32(a[2] >>> 0, 0);
                return E_NOINTERFACE | 0;
            }
            return this.queryInterface(obj, guidAt(a[1] >>> 0), a[2] >>> 0) | 0;
        };
        e[`${iface}_AddRef`] = (_c, _m, a) => this.object(a[0], Dp8Object)?.addRef() ?? 0;
        e[`${iface}_Release`] = (_c, _m, a) => this.object(a[0], Dp8Object)?.release() ?? 0;
    }

    /** CoCreateInstance for the DirectPlay 8 classes; null for any other class. */
    coCreateInstance(clsid: string, iid: string, ppOut: number): number | null {
        let obj: Dp8Object;
        switch (clsid) {
            case CLSID_DirectPlay8Peer: {
                const peer = new PeerObject();
                this.peers.add(peer);
                peer.onDestroy = () => {
                    this.shutdown(peer);
                    this.peers.delete(peer);
                };
                obj = peer;
                break;
            }
            case CLSID_DirectPlay8Address: obj = new AddressObject(); break;
            case CLSID_DirectPlay8LobbiedApplication: obj = new LobbyObject(); break;
            default: return null;
        }
        const hr = this.queryInterface(obj, iid, ppOut);
        obj.release();
        return hr | 0;
    }

    /** A new IDirectPlay8Address holding `addr`; the caller owns its one reference. */
    private newAddress(addr: Dp8Address): number {
        return this.addressOf(new AddressObject(addr), "IDirectPlay8Address");
    }

    private addressFromPointer(ptr: number): Dp8Address | null {
        return this.object(ptr, AddressObject)?.addr ?? null;
    }

    // ── engine and the guest message pump ───────────────────────────────────────

    private createEngine(peer: PeerObject): void {
        const transport = new LanTransport(lanStack);
        peer.transport = transport;
        peer.engine = new Dp8Engine({
            transport,
            now: () => performance.now(),
            every: (ms, fn) => {
                const timer = setInterval(fn, ms);
                return () => clearInterval(timer);
            },
            guid: () => crypto.randomUUID(),
            rand32: () => crypto.getRandomValues(new Uint32Array(1))[0]!,
        }, ev => this.enqueue(peer, ev));
    }

    private shutdown(peer: PeerObject): void {
        peer.engine?.dispose();
        peer.engine = null;
        peer.transport = null;
        for (const ptr of peer.buffers.values()) this.process.memory.free(ptr);
        peer.buffers.clear();
        peer.sendBuffers.clear();
    }

    private enqueue(peer: PeerObject, ev: EngineEvent): Promise<EventResult> {
        return new Promise<EventResult>(resolve => {
            const job = this.jobFor(peer, ev);
            job.done = resolve;
            peer.queue.push(job);
            this.pump(peer);
        });
    }

    private pump(peer: PeerObject): void {
        if (peer.pumping) return;
        const job = peer.queue.shift();
        if (!job) return;
        peer.pumping = true;
        const arena = new Arena(this.process.memory);
        const next = (result: EventResult): void => {
            arena.free();
            peer.pumping = false;
            job.done(result);
            this.pump(peer);
        };
        const msg = arena.alloc(job.size);
        if (!msg) {
            next({ ret: Hr.E_OUTOFMEMORY });
            return;
        }
        job.build(msg, arena);
        w32(msg, 0, job.size);
        Logger.verbose(LogCategory.COM, `[dpnet] -> msg 0x${job.msgId.toString(16)} handler=0x${peer.handler.toString(16)}`);
        const posted = (this.process.getModule("winmm") as WinMM | undefined)?.postGuestCallback(
            peer.handler, [peer.handlerCtx, job.msgId, msg], (eax: number) => {
                Logger.verbose(LogCategory.COM, `[dpnet] <- msg 0x${job.msgId.toString(16)} ret=0x${(eax >>> 0).toString(16)}`);
                next(job.finish(msg, eax >>> 0, arena));
            });
        if (!posted) next({ ret: Hr.E_FAIL });
    }

    private jobFor(peer: PeerObject, ev: EngineEvent): Job {
        const job = (msgId: number, size: number, build: Job["build"], finish?: Job["finish"]): Job => ({
            msgId, size, build, finish: finish ?? ((_m, eax) => ({ ret: eax })), done: () => {},
        });
        switch (ev.t) {
            case "createPlayer": {
                const p = ev.player;
                return job(Msgid.CREATE_PLAYER, 12,
                    m => { w32(m, 4, p.id); w32(m, 8, p.local ? peer.localCtx : p.ctx); },
                    (m, eax) => { p.ctx = r32(m, 8); return { ret: eax }; });
            }
            case "destroyPlayer": {
                const p = ev.player;
                return job(Msgid.DESTROY_PLAYER, 16, m => { w32(m, 4, p.id); w32(m, 8, p.ctx); w32(m, 0xc, ev.reason); });
            }
            case "createGroup": {
                const g = ev.group;
                return job(Msgid.CREATE_GROUP, 16,
                    m => { w32(m, 4, g.id); w32(m, 8, g.owner); w32(m, 0xc, g.ctx); },
                    (m, eax) => { g.ctx = r32(m, 0xc); return { ret: eax }; });
            }
            case "destroyGroup": {
                const g = ev.group;
                return job(Msgid.DESTROY_GROUP, 16, m => { w32(m, 4, g.id); w32(m, 8, g.ctx); w32(m, 0xc, ev.reason); });
            }
            case "addToGroup":
            case "removeFromGroup": {
                const { group, player } = ev;
                return job(ev.t === "addToGroup" ? Msgid.ADD_PLAYER_TO_GROUP : Msgid.REMOVE_PLAYER_FROM_GROUP, 20, m => {
                    w32(m, 4, group.id); w32(m, 8, group.ctx); w32(m, 0xc, player.id); w32(m, 0x10, player.ctx);
                });
            }
            case "groupInfo": {
                const g = ev.group;
                return job(Msgid.GROUP_INFO, 12, m => { w32(m, 4, g.id); w32(m, 8, g.ctx); });
            }
            case "peerInfo": {
                const p = ev.player;
                return job(Msgid.PEER_INFO, 12, m => { w32(m, 4, p.id); w32(m, 8, p.ctx); });
            }
            case "appDesc":
                return job(Msgid.APPLICATION_DESC, 4, () => {});
            case "connectComplete":
                return job(Msgid.CONNECT_COMPLETE, 0x1c, (m, arena) => {
                    w32(m, 4, ev.handle); w32(m, 8, ev.ctx); w32(m, 0xc, ev.hr);
                    w32(m, 0x10, arena.bytes(ev.replyData)); w32(m, 0x14, ev.replyData.length); w32(m, 0x18, ev.localId);
                });
            case "asyncComplete":
                return job(Msgid.ASYNC_OP_COMPLETE, 16, m => { w32(m, 4, ev.handle); w32(m, 8, ev.ctx); w32(m, 0xc, ev.hr); });
            case "sendComplete": {
                const buffers = peer.sendBuffers.get(ev.handle);
                peer.sendBuffers.delete(ev.handle);
                return job(Msgid.SEND_COMPLETE, 0x28, (m, arena) => {
                    w32(m, 4, ev.handle); w32(m, 8, ev.ctx); w32(m, 0xc, ev.hr);
                    w32(m, 0x10, ev.sendTime); w32(m, 0x14, ev.rtt); w32(m, 0x18, ev.retries);
                    if (buffers) { w32(m, 0x20, arena.bytes(buffers)); w32(m, 0x24, buffers.length / 8); }
                });
            }
            case "receive": {
                let data = 0;
                let handle = 0;
                return job(Msgid.RECEIVE, 0x18, (m, arena) => {
                    data = arena.bytes(ev.data);
                    handle = peer.nextBuffer++;
                    w32(m, 4, ev.from.id); w32(m, 8, ev.from.ctx); w32(m, 0xc, data); w32(m, 0x10, ev.data.length); w32(m, 0x14, handle);
                }, (_m, eax, arena) => {
                    if (eax === Hr.PENDING && data) {
                        arena.detach(data);
                        peer.buffers.set(handle, data);
                    }
                    return { ret: eax };
                });
            }
            case "indicateConnect": {
                const engine = peer.engine!;
                const owned: number[] = [];
                return job(Msgid.INDICATE_CONNECT, 32, (m, arena) => {
                    const player = this.newAddress(endpointAddress(ipToString(ev.ip), ev.port));
                    const device = this.newAddress(endpointAddress(ipToString(engine.localIp), engine.localPort));
                    owned.push(player, device);
                    w32(m, 4, arena.bytes(ev.data)); w32(m, 8, ev.data.length);
                    w32(m, 0x18, player); w32(m, 0x1c, device);
                }, (m, eax) => {
                    const size = r32(m, 0x10);
                    const reply = eax === 0 && size > 0 && size <= MAX_REPLY_BYTES ? readGuestBytes(r32(m, 0xc), size) : null;
                    for (const p of owned) comRelease(p);
                    return { ret: eax, reply: reply ?? undefined };
                });
            }
            case "enumQuery": {
                const engine = peer.engine!;
                const owned: number[] = [];
                return job(Msgid.ENUM_HOSTS_QUERY, 0x24, (m, arena) => {
                    const sender = this.newAddress(endpointAddress(ipToString(ev.ip), ev.port));
                    const device = this.newAddress(endpointAddress(ipToString(engine.localIp), engine.localPort));
                    owned.push(sender, device);
                    w32(m, 4, sender); w32(m, 8, device); w32(m, 0xc, arena.bytes(ev.data)); w32(m, 0x10, ev.data.length);
                    w32(m, 0x14, peer.spCaps.maxEnumPayload);
                }, (m, eax) => {
                    const size = r32(m, 0x1c);
                    const reply = eax === 0 && size > 0 && size <= peer.spCaps.maxEnumPayload ? readGuestBytes(r32(m, 0x18), size) : null;
                    for (const p of owned) comRelease(p);
                    return { ret: eax, reply: reply ?? undefined };
                });
            }
            case "enumResponse": {
                const engine = peer.engine!;
                const owned: number[] = [];
                return job(Msgid.ENUM_HOSTS_RESPONSE, 28, (m, arena) => {
                    const sender = this.newAddress(endpointAddress(ipToString(ev.ip), ev.port));
                    const device = this.newAddress(endpointAddress(ipToString(engine.localIp), engine.localPort));
                    owned.push(sender, device);
                    const desc = arena.alloc(appDescSize(ev.desc));
                    writeAppDesc(desc, ev.desc);
                    w32(m, 4, sender); w32(m, 8, device); w32(m, 0xc, desc);
                    w32(m, 0x10, arena.bytes(ev.data)); w32(m, 0x14, ev.data.length); w32(m, 0x18, ev.rtt);
                }, (_m, eax) => {
                    for (const p of owned) comRelease(p);
                    return { ret: eax };
                });
            }
            case "hostMigrate":
                return job(Msgid.HOST_MIGRATE, 12, m => { w32(m, 4, ev.newHost.id); w32(m, 8, ev.newHost.ctx); });
            case "terminate":
                return job(Msgid.TERMINATE_SESSION, 16, (m, arena) => {
                    w32(m, 4, ev.hr); w32(m, 8, arena.bytes(ev.data)); w32(m, 0xc, ev.data.length);
                });
        }
    }

    /** The result of an engine operation: immediate for a refusal, the completion for a sync call, PENDING otherwise. */
    private engineOp(op: OpHandle, flags: number, phAsync: number): number | Promise<number> {
        if (op.handle === 0) return op.hr;
        if (flags & OP_SYNC) return op.result;
        out32(phAsync, op.handle);
        return Hr.PENDING;
    }

    /** `work` as a DirectPlay operation of the peer: its result is the return value when sync, an ASYNC_OP_COMPLETE otherwise. */
    private localOp(peer: PeerObject, flags: number, asyncCtx: number, phAsync: number, work: Promise<number>): number | Promise<number> {
        if (flags & OP_SYNC) return work;
        const handle = peer.nextOpHandle++;
        out32(phAsync, handle);
        void work.then(hr => this.enqueue(peer, { t: "asyncComplete", handle, ctx: asyncCtx, hr }));
        return Hr.PENDING;
    }

    private session(thisPtr: number | undefined): { peer: PeerObject; engine: Dp8Engine } | number {
        const peer = this.object(thisPtr, PeerObject);
        if (!peer) return E_POINTER;
        return peer.engine ? { peer, engine: peer.engine } : Hr.UNINITIALIZED;
    }

    // ── IDirectPlay8Peer ────────────────────────────────────────────────────────

    private registerPeerExports(): void {
        const e = this.exports;
        const define = (name: string, fn: (peer: PeerObject, engine: Dp8Engine, a: number[]) => number | Promise<number>): void => {
            e[`IDirectPlay8Peer_${name}`] = (_c, _m, a): number | Promise<number> => {
                const s = this.session(a[0]);
                if (typeof s === "number") return s | 0;
                const r = fn(s.peer, s.engine, a);
                if (typeof r === "number") return r | 0;
                return r.then((v: number) => v | 0);
            };
        };

        e.IDirectPlay8Peer_Initialize = (_c, _m, a) => {
            const peer = this.object(a[0], PeerObject);
            if (!peer) return E_POINTER | 0;
            if (peer.engine) return Hr.ALREADYINITIALIZED | 0;
            if (!(a[2] >>> 0)) return E_POINTER | 0;
            peer.handlerCtx = a[1] >>> 0;
            peer.handler = a[2] >>> 0;
            this.createEngine(peer);
            return S_OK;
        };

        e.IDirectPlay8Peer_EnumServiceProviders = (_c, _m, a) => {
            const spGuid = a[1] ? guidAt(a[1] >>> 0) : "";
            if (spGuid && normalizeGuid(spGuid) !== CLSID_DP8SP_TCPIP) return Hr.DOESNOTEXIST | 0;
            const infoPtr = a[3] >>> 0, cbPtr = a[4] >>> 0, countPtr = a[5] >>> 0;
            if (!validPointer(cbPtr, 4, "rw") || !validPointer(countPtr, 4, "rw")) return E_POINTER | 0;
            const name = wideBytes(spGuid ? DEVICE_NAME : SERVICE_PROVIDER_NAME);
            const need = SP_INFO_SIZE + name.length;
            const have = Mem.readUint32(cbPtr) ?? 0;
            Mem.writeUint32(cbPtr, need);
            Mem.writeUint32(countPtr, 1);
            if (!infoPtr || have < need || !validPointer(infoPtr, need, "rw")) return Hr.BUFFERTOOSMALL | 0;
            const bytes = new Uint8Array(need);
            bytes.set(guidToBytes(spGuid ? DEVICE_GUID : CLSID_DP8SP_TCPIP), 4);
            bytes.set(name, SP_INFO_SIZE);
            Mem.writeBytes(infoPtr, bytes);
            w32(infoPtr, 0x14, infoPtr + SP_INFO_SIZE);
            return S_OK;
        };

        define("CancelAsyncOperation", (_p, engine, a) => {
            const handle = a[1] >>> 0, flags = a[2] >>> 0;
            if (handle === 0 && flags === 0) return Hr.INVALIDFLAGS;
            return engine.cancel(handle, flags);
        });

        define("Connect", (peer, engine, a) => {
            const desc = readAppDesc(a[1] >>> 0);
            if (!desc) return E_POINTER;
            const host = this.addressFromPointer(a[2] >>> 0);
            if (!host) return Hr.INVALIDHOSTADDRESS;
            const ip = host.hostIp();
            if (ip === null) return host.string(DPNA_KEY_HOSTNAME) === null ? Hr.INCOMPLETEADDRESS : Hr.ADDRESSING;
            const device = this.addressFromPointer(a[3] >>> 0);
            const devicePort = device?.dword(DPNA_KEY_PORT) ?? 0;
            if (devicePort && engine.localPort === 0) peer.transport?.bind(devicePort);
            const data = readGuestBytes(a[6] >>> 0, a[7] >>> 0);
            if (!data) return E_POINTER;
            const flags = a[11] >>> 0;
            peer.localCtx = a[8] >>> 0;
            Logger.log(LogCategory.COM, `[dpnet] Connect ${ipToString(ip)}:${host.dword(DPNA_KEY_PORT) ?? DPN_DEFAULT_PORT} sync=${!!(flags & OP_SYNC)}`);
            const op = engine.connect(desc, ip, host.dword(DPNA_KEY_PORT) ?? DPN_DEFAULT_PORT, data, a[9] >>> 0, !!(flags & OP_SYNC));
            return this.engineOp(op, flags, a[10] >>> 0);
        });

        define("SendTo", (peer, engine, a) => {
            const count = a[3] >>> 0, descs = a[2] >>> 0, flags = a[7] >>> 0;
            if (count === 0 || count > 256 || !validPointer(descs, count * 8, "r")) return E_POINTER;
            let total = 0;
            for (let i = 0; i < count; i++) total += r32(descs, i * 8);
            if (total > MAX_GUEST_BYTES) return Hr.SENDTOOLARGE;
            const data = new Uint8Array(total);
            let at = 0;
            for (let i = 0; i < count; i++) {
                const size = r32(descs, i * 8);
                const part = readGuestBytes(r32(descs, i * 8 + 4), size);
                if (!part) return E_POINTER;
                data.set(part, at);
                at += size;
            }
            const op = engine.send(a[1] >>> 0, data, flags, a[4] >>> 0, a[5] >>> 0, !!(flags & OP_SYNC));
            if (op.handle !== 0 && !(flags & OP_SYNC) && (flags & SendFlag.NOCOPY) && !(flags & SendFlag.NOCOMPLETE)) {
                peer.sendBuffers.set(op.handle, Mem.readBytes(descs, count * 8)!.slice());
            }
            return this.engineOp(op, flags, a[6] >>> 0);
        });

        define("GetSendQueueInfo", (_p, engine, a) => {
            const info = engine.sendQueueInfo(a[1] >>> 0);
            if (!info) return Hr.INVALIDPLAYER;
            out32(a[2] >>> 0, info.messages);
            out32(a[3] >>> 0, info.bytes);
            return S_OK;
        });

        define("Host", async (peer, engine, a) => {
            const desc = readAppDesc(a[1] >>> 0);
            if (!desc) return E_POINTER;
            const count = a[3] >>> 0;
            if (count === 0 || !validPointer(a[2] >>> 0, count * 4, "r")) return Hr.INVALIDDEVICEADDRESS;
            const device = this.addressFromPointer(r32(a[2] >>> 0, 0));
            if (!device) return Hr.INVALIDDEVICEADDRESS;
            const port = device.dword(DPNA_KEY_PORT);
            peer.localCtx = a[6] >>> 0;
            Logger.log(LogCategory.COM, `[dpnet] Host "${desc.sessionName}" port=${port ?? "default"} max=${desc.maxPlayers}`);
            return engine.host(desc, port ?? DPN_DEFAULT_PORT, port !== null);
        });

        define("GetApplicationDesc", (_p, engine, a) => {
            const desc = engine.getApplicationDesc();
            if (!desc) return Hr.NOCONNECTION;
            const cbPtr = a[2] >>> 0;
            if (!validPointer(cbPtr, 4, "rw")) return E_POINTER;
            const need = appDescSize(desc);
            const have = Mem.readUint32(cbPtr) ?? 0;
            Mem.writeUint32(cbPtr, need);
            const buf = a[1] >>> 0;
            if (!buf || have < need || !validPointer(buf, need, "rw")) return Hr.BUFFERTOOSMALL;
            writeAppDesc(buf, desc);
            return S_OK;
        });

        define("SetApplicationDesc", (_p, engine, a) => {
            const desc = readAppDesc(a[1] >>> 0);
            if (!desc) return E_POINTER;
            return engine.setApplicationDesc(desc);
        });

        define("CreateGroup", (peer, engine, a) => {
            const info = readGroupInfo(a[1] >>> 0);
            if (!info) return E_POINTER;
            const group = engine.createGroup(info.groupFlags, info.name ?? "", info.data ?? new Uint8Array(0));
            if (!group) return Hr.NOCONNECTION;
            group.ctx = a[2] >>> 0;
            return this.localOp(peer, a[5] >>> 0, a[3] >>> 0, a[4] >>> 0, Promise.resolve(Hr.OK));
        });

        define("DestroyGroup", (peer, engine, a) => {
            if (!engine.groups.has(a[1] >>> 0)) return Hr.INVALIDGROUP;
            return this.localOp(peer, a[4] >>> 0, a[2] >>> 0, a[3] >>> 0, engine.destroyGroup(a[1] >>> 0));
        });

        for (const [name, add] of [["AddPlayerToGroup", true], ["RemovePlayerFromGroup", false]] as const) {
            define(name, (peer, engine, a) => {
                if (!engine.groups.has(a[1] >>> 0)) return Hr.INVALIDGROUP;
                if (!engine.players.has(a[2] >>> 0)) return Hr.INVALIDPLAYER;
                return this.localOp(peer, a[5] >>> 0, a[3] >>> 0, a[4] >>> 0, engine.groupMember(a[1] >>> 0, a[2] >>> 0, add));
            });
        }

        define("SetGroupInfo", (peer, engine, a) => {
            if (!engine.groups.has(a[1] >>> 0)) return Hr.INVALIDGROUP;
            const info = readGroupInfo(a[2] >>> 0);
            if (!info) return E_POINTER;
            return this.localOp(peer, a[5] >>> 0, a[3] >>> 0, a[4] >>> 0, engine.setGroupInfo(a[1] >>> 0, info.name, info.data));
        });

        define("GetGroupInfo", (_p, engine, a) => {
            const g = engine.groups.get(a[1] >>> 0);
            if (!g) return Hr.INVALIDGROUP;
            return writeInfoStruct(a[2] >>> 0, a[3] >>> 0, GROUP_INFO_SIZE, g.name, g.data, g.flags);
        });

        define("EnumPlayersAndGroups", (_p, engine, a) => {
            const flags = a[3] >>> 0;
            const ids: number[] = [];
            if (flags & ENUM_PLAYERS) ids.push(...engine.players.keys());
            if (flags & ENUM_GROUPS) ids.push(...engine.groups.keys());
            return writeIdList(a[1] >>> 0, a[2] >>> 0, ids);
        });

        define("EnumGroupMembers", (_p, engine, a) => {
            const g = engine.groups.get(a[1] >>> 0);
            return g ? writeIdList(a[2] >>> 0, a[3] >>> 0, [...g.members]) : Hr.INVALIDGROUP;
        });

        define("SetPeerInfo", (peer, engine, a) => {
            const info = readPlayerInfo(a[1] >>> 0);
            if (!info) return E_POINTER;
            engine.setPeerInfo(info.name, info.data);
            const me = engine.players.get(engine.localId);
            if (me) void this.enqueue(peer, { t: "peerInfo", player: me });
            return this.localOp(peer, a[4] >>> 0, a[2] >>> 0, a[3] >>> 0, Promise.resolve(Hr.OK));
        });

        define("GetPeerInfo", (_p, engine, a) => {
            const p = engine.players.get(a[1] >>> 0);
            if (!p) return Hr.INVALIDPLAYER;
            const playerFlags = (p.local ? PLAYER_LOCAL : 0) | (p.id === engine.hostId ? PLAYER_HOST : 0);
            return writeInfoStruct(a[2] >>> 0, a[3] >>> 0, PLAYER_INFO_SIZE, p.name, p.data, playerFlags);
        });

        define("GetPeerAddress", (_p, engine, a) => {
            const ep = engine.playerEndpoint(a[1] >>> 0);
            if (!ep) return Hr.INVALIDPLAYER;
            if (!validPointer(a[2] >>> 0, 4, "rw")) return E_POINTER;
            Mem.writeUint32(a[2] >>> 0, this.newAddress(endpointAddress(ipToString(ep.ip), ep.port)));
            return S_OK;
        });

        define("GetLocalHostAddresses", (_p, engine, a) => {
            const arr = a[1] >>> 0, countPtr = a[2] >>> 0;
            if (!validPointer(countPtr, 4, "rw")) return E_POINTER;
            if (!engine.ensureBound()) return Hr.E_FAIL;
            const have = Mem.readUint32(countPtr) ?? 0;
            Mem.writeUint32(countPtr, 1);
            if (!arr || have < 1 || !validPointer(arr, 4, "rw")) return Hr.BUFFERTOOSMALL;
            Mem.writeUint32(arr, this.newAddress(endpointAddress(ipToString(engine.localIp), engine.localPort)));
            return S_OK;
        });

        define("Close", async (peer, engine) => {
            await engine.close();
            this.shutdown(peer);
            return S_OK;
        });

        define("EnumHosts", (_p, engine, a) => {
            const desc = readAppDesc(a[1] >>> 0);
            if (!desc) return E_POINTER;
            const host = this.addressFromPointer(a[2] >>> 0);
            let target: { ip: number; port: number } | null = null;
            if (host && host.string(DPNA_KEY_HOSTNAME) !== null) {
                const ip = host.hostIp();
                if (ip === null) return Hr.ADDRESSING;
                target = { ip, port: host.dword(DPNA_KEY_PORT) ?? DPN_DEFAULT_PORT };
            }
            const data = readGuestBytes(a[4] >>> 0, a[5] >>> 0);
            if (!data) return E_POINTER;
            const flags = a[11] >>> 0;
            const op = engine.enumHosts(desc.application, target, data, a[6] >>> 0, a[7] >>> 0, a[8] >>> 0, a[9] >>> 0, !!(flags & OP_SYNC));
            return this.engineOp(op, flags, a[10] >>> 0);
        });

        define("DestroyPeer", (_p, engine, a) => {
            const data = readGuestBytes(a[2] >>> 0, a[3] >>> 0);
            return data ? engine.destroyPeer(a[1] >>> 0, data) : E_POINTER;
        });

        define("ReturnBuffer", (peer, _e, a) => {
            const ptr = peer.buffers.get(a[1] >>> 0);
            if (ptr === undefined) return Hr.INVALIDHANDLE;
            peer.buffers.delete(a[1] >>> 0);
            this.process.memory.free(ptr);
            return S_OK;
        });

        define("GetPlayerContext", (_p, engine, a) => {
            const p = engine.players.get(a[1] >>> 0);
            if (!p) return Hr.INVALIDPLAYER;
            return validPointer(a[2] >>> 0, 4, "rw") ? (Mem.writeUint32(a[2] >>> 0, p.ctx), S_OK) : E_POINTER;
        });

        define("GetGroupContext", (_p, engine, a) => {
            const g = engine.groups.get(a[1] >>> 0);
            if (!g) return Hr.INVALIDGROUP;
            return validPointer(a[2] >>> 0, 4, "rw") ? (Mem.writeUint32(a[2] >>> 0, g.ctx), S_OK) : E_POINTER;
        });

        define("GetCaps", (peer, _e, a) => {
            const ptr = a[1] >>> 0;
            if (!validPointer(ptr, CAPS_SIZE, "rw") || r32(ptr, 0) !== CAPS_SIZE) return Hr.E_INVALIDARG;
            const c = peer.caps;
            w32(ptr, 4, c.flags); w32(ptr, 8, c.connectTimeout); w32(ptr, 0xc, c.connectRetries); w32(ptr, 0x10, c.keepAlive);
            return S_OK;
        });

        define("SetCaps", (peer, _e, a) => {
            const ptr = a[1] >>> 0;
            if (!validPointer(ptr, CAPS_SIZE, "r") || r32(ptr, 0) !== CAPS_SIZE) return Hr.E_INVALIDARG;
            peer.caps = { flags: r32(ptr, 4), connectTimeout: r32(ptr, 8), connectRetries: r32(ptr, 0xc), keepAlive: r32(ptr, 0x10) };
            return S_OK;
        });

        define("SetSPCaps", (peer, _e, a) => {
            const ptr = a[2] >>> 0;
            if (!a[1] || normalizeGuid(guidAt(a[1] >>> 0)) !== CLSID_DP8SP_TCPIP) return Hr.DOESNOTEXIST;
            if (!validPointer(ptr, SP_CAPS_SIZE, "r") || r32(ptr, 0) !== SP_CAPS_SIZE) return Hr.E_INVALIDARG;
            const c = peer.spCaps;
            c.numThreads = r32(ptr, 8) || c.numThreads;
            c.enumCount = r32(ptr, 0xc) || c.enumCount;
            c.enumRetryInterval = r32(ptr, 0x10) || c.enumRetryInterval;
            c.enumTimeout = r32(ptr, 0x14) || c.enumTimeout;
            c.buffersPerThread = r32(ptr, 0x1c) || c.buffersPerThread;
            c.systemBufferSize = r32(ptr, 0x20);
            return S_OK;
        });

        define("GetSPCaps", (peer, _e, a) => {
            const ptr = a[2] >>> 0;
            if (!a[1] || normalizeGuid(guidAt(a[1] >>> 0)) !== CLSID_DP8SP_TCPIP) return Hr.DOESNOTEXIST;
            if (!validPointer(ptr, SP_CAPS_SIZE, "rw") || r32(ptr, 0) !== SP_CAPS_SIZE) return Hr.E_INVALIDARG;
            const c = peer.spCaps;
            for (const [i, v] of [c.flags, c.numThreads, c.enumCount, c.enumRetryInterval, c.enumTimeout, c.maxEnumPayload,
                c.buffersPerThread, c.systemBufferSize].entries()) w32(ptr, 4 + i * 4, v);
            return S_OK;
        });

        define("GetConnectionInfo", (_p, engine, a) => {
            const ptr = a[2] >>> 0;
            if (!validPointer(ptr, CONNECTION_INFO_SIZE, "rw") || r32(ptr, 0) !== CONNECTION_INFO_SIZE) return Hr.E_INVALIDARG;
            const link = engine.connectionInfo(a[1] >>> 0);
            if (!link) return Hr.INVALIDPLAYER;
            const out = new Uint32Array(CONNECTION_INFO_SIZE / 4);
            out[0] = CONNECTION_INFO_SIZE;
            out[1] = Math.round(link.srtt);
            out[2] = out[3] = 0;
            out[4] = link.sentBytes; out[5] = link.sentPackets;
            out[8] = link.retriedBytes; out[9] = link.retriedPackets;
            out[18] = link.recvBytes; out[19] = link.recvPackets;
            out[22] = link.recvPackets;
            Mem.writeBytes(ptr, new Uint8Array(out.buffer));
            return S_OK;
        });

        define("RegisterLobby", () => S_OK);

        define("TerminateSession", (_p, engine, a) => {
            const data = readGuestBytes(a[1] >>> 0, a[2] >>> 0);
            return data ? engine.terminateSession(data) : E_POINTER;
        });
    }

    // ── IDirectPlay8LobbiedApplication ──────────────────────────────────────────

    private registerLobbyExports(): void {
        const e = this.exports;
        e.IDirectPlay8LobbiedApplication_Initialize = (_c, _m, a) => {
            const lobby = this.object(a[0], LobbyObject);
            if (!lobby) return E_POINTER | 0;
            if (lobby.initialized) return Hr.ALREADYINITIALIZED | 0;
            if (!(a[2] >>> 0)) return E_POINTER | 0;
            lobby.initialized = true;
            out32(a[3] >>> 0, 0);
            return S_OK;
        };
        for (const name of ["Close", "SetAppAvailable", "UpdateStatus"]) {
            e[`IDirectPlay8LobbiedApplication_${name}`] = (_c, _m, a) => (this.object(a[0], LobbyObject) ? S_OK : E_POINTER | 0);
        }
    }

    // ── IDirectPlay8Address ─────────────────────────────────────────────────────

    private registerAddressExports(): void {
        const e = this.exports;
        const define = (name: string, fn: (obj: AddressObject, a: number[]) => number): void => {
            e[`IDirectPlay8Address_${name}`] = (_c, _m, a) => {
                const obj = this.object(a[0], AddressObject);
                return obj ? fn(obj, a) | 0 : E_POINTER | 0;
            };
        };
        const build = (obj: AddressObject, url: string): number => {
            const parsed = Dp8Address.fromUrl(url);
            if (!parsed) return Hr.INVALIDURL;
            obj.addr = parsed;
            return S_OK;
        };
        const writeText = (obj: AddressObject, a: number[], bytes: (s: string) => Uint8Array, unit: number): number => {
            const lenPtr = a[2] >>> 0;
            if (!validPointer(lenPtr, 4, "rw")) return E_POINTER;
            const text = bytes(obj.addr.toUrl());
            const have = Mem.readUint32(lenPtr) ?? 0;
            Mem.writeUint32(lenPtr, text.length / unit);
            if (!a[1] || have < text.length / unit || !validPointer(a[1] >>> 0, text.length, "rw")) return Hr.BUFFERTOOSMALL;
            Mem.writeBytes(a[1] >>> 0, text);
            return S_OK;
        };

        define("BuildFromURLW", (obj, a) => build(obj, readWide(a[1] >>> 0, MAX_STRING_CHARS * 4)));
        define("BuildFromURLA", (obj, a) => build(obj, readAnsi(a[1] >>> 0, MAX_STRING_CHARS * 4)));
        define("GetURLW", (obj, a) => writeText(obj, a, wideBytes, 2));
        define("GetURLA", (obj, a) => writeText(obj, a, ansiBytes, 1));
        define("Duplicate", (obj, a) => {
            if (!validPointer(a[1] >>> 0, 4, "rw")) return E_POINTER;
            Mem.writeUint32(a[1] >>> 0, this.newAddress(obj.addr.clone()));
            return S_OK;
        });
        define("SetEqual", (obj, a) => {
            const other = this.addressFromPointer(a[1] >>> 0);
            if (!other) return Hr.INVALIDOBJECT;
            obj.addr = other.clone();
            return S_OK;
        });
        define("IsEqual", (obj, a) => {
            const other = this.addressFromPointer(a[1] >>> 0);
            if (!other) return Hr.INVALIDOBJECT;
            return obj.addr.isEqual(other) ? S_OK : S_FALSE;
        });
        define("Clear", obj => (obj.addr.clear(), S_OK));
        define("GetSP", (obj, a) => {
            const g = obj.addr.guid(DPNA_KEY_PROVIDER);
            if (!g) return Hr.DOESNOTEXIST;
            if (!validPointer(a[1] >>> 0, 16, "rw")) return E_POINTER;
            Mem.writeBytes(a[1] >>> 0, guidToBytes(g));
            return S_OK;
        });
        define("SetSP", (obj, a) => {
            if (!validPointer(a[1] >>> 0, 16, "r")) return E_POINTER;
            obj.addr.setGuid(DPNA_KEY_PROVIDER, guidAt(a[1] >>> 0));
            return S_OK;
        });
        define("GetDevice", (obj, a) => {
            const g = obj.addr.guid(DPNA_KEY_DEVICE);
            if (!g) return Hr.DOESNOTEXIST;
            if (!validPointer(a[1] >>> 0, 16, "rw")) return E_POINTER;
            Mem.writeBytes(a[1] >>> 0, guidToBytes(g));
            return S_OK;
        });
        define("SetDevice", (obj, a) => {
            if (!validPointer(a[1] >>> 0, 16, "r")) return E_POINTER;
            obj.addr.setGuid(DPNA_KEY_DEVICE, guidAt(a[1] >>> 0));
            return S_OK;
        });
        define("GetUserData", (obj, a) => {
            const data = obj.addr.userData;
            if (!data) return Hr.DOESNOTEXIST;
            return writeSized(a[1] >>> 0, a[2] >>> 0, data);
        });
        define("SetUserData", (obj, a) => {
            const data = readGuestBytes(a[1] >>> 0, a[2] >>> 0);
            if (!data) return E_POINTER;
            obj.addr.userData = data.length ? data : null;
            return S_OK;
        });
        define("GetNumComponents", (obj, a) => {
            if (!validPointer(a[1] >>> 0, 4, "rw")) return E_POINTER;
            Mem.writeUint32(a[1] >>> 0, obj.addr.components.size);
            return S_OK;
        });
        define("GetComponentByName", (obj, a) => {
            const name = readWide(a[1] >>> 0, MAX_STRING_CHARS).toLowerCase();
            const value = obj.addr.components.get(name);
            if (!value) return Hr.DOESNOTEXIST;
            return writeComponent(value, a[2] >>> 0, a[3] >>> 0, a[4] >>> 0);
        });
        define("GetComponentByIndex", (obj, a) => {
            const entry = [...obj.addr.components.entries()][a[1] >>> 0];
            if (!entry) return Hr.DOESNOTEXIST;
            const [name, value] = entry;
            const lenPtr = a[3] >>> 0;
            if (!validPointer(lenPtr, 4, "rw")) return E_POINTER;
            const have = Mem.readUint32(lenPtr) ?? 0;
            Mem.writeUint32(lenPtr, name.length + 1);
            if (!a[2] || have < name.length + 1 || !validPointer(a[2] >>> 0, (name.length + 1) * 2, "rw")) return Hr.BUFFERTOOSMALL;
            Mem.writeBytes(a[2] >>> 0, wideBytes(name));
            return writeComponent(value, a[4] >>> 0, a[5] >>> 0, a[6] >>> 0);
        });
        define("AddComponent", (obj, a) => {
            const name = readWide(a[1] >>> 0, MAX_STRING_CHARS).toLowerCase();
            const size = a[3] >>> 0, type = a[4] >>> 0;
            const raw = readGuestBytes(a[2] >>> 0, size);
            if (!name || !raw) return E_POINTER;
            switch (type) {
                case DPNA_DATATYPE_DWORD:
                    if (size !== 4) return Hr.E_INVALIDARG;
                    obj.addr.setDword(name, new DataView(raw.buffer).getUint32(0, true));
                    return S_OK;
                case DPNA_DATATYPE_GUID:
                    if (size !== 16) return Hr.E_INVALIDARG;
                    obj.addr.setGuid(name, bytesToGuid(raw));
                    return S_OK;
                case DPNA_DATATYPE_STRING:
                    obj.addr.setString(name, wideFromBytes(raw));
                    return S_OK;
                case DPNA_DATATYPE_BINARY:
                    obj.addr.components.set(name, { type: DPNA_DATATYPE_BINARY, value: raw });
                    return S_OK;
                default:
                    return Hr.E_INVALIDARG;
            }
        });
    }
}

// ── guest structure helpers ─────────────────────────────────────────────────────

/** Bytes DPN_APPLICATION_DESC occupies with its strings and data appended. */
function appDescSize(d: AppDesc): number {
    return APPDESC_SIZE + (d.sessionName ? (d.sessionName.length + 1) * 2 : 0) + (d.password ? (d.password.length + 1) * 2 : 0)
        + d.reserved.length + d.appReserved.length;
}

function writeAppDesc(ptr: number, d: AppDesc): void {
    const buf = new Uint8Array(appDescSize(d));
    const view = new DataView(buf.buffer);
    let at = APPDESC_SIZE;
    const append = (data: Uint8Array): number => {
        if (data.length === 0) return 0;
        buf.set(data, at);
        const va = ptr + at;
        at += data.length;
        return va;
    };
    view.setUint32(0, APPDESC_SIZE, true);
    view.setUint32(4, d.flags, true);
    buf.set(guidToBytes(d.instance), 8);
    buf.set(guidToBytes(d.application), 0x18);
    view.setUint32(0x28, d.maxPlayers, true);
    view.setUint32(0x2c, d.currentPlayers, true);
    view.setUint32(0x30, append(d.sessionName ? wideBytes(d.sessionName) : new Uint8Array(0)), true);
    view.setUint32(0x34, append(d.password ? wideBytes(d.password) : new Uint8Array(0)), true);
    view.setUint32(0x38, append(d.reserved), true);
    view.setUint32(0x3c, d.reserved.length, true);
    view.setUint32(0x40, append(d.appReserved), true);
    view.setUint32(0x44, d.appReserved.length, true);
    Mem.writeBytes(ptr, buf);
}

function readAppDesc(ptr: number): AppDesc | null {
    if (!validPointer(ptr, APPDESC_SIZE, "r") || r32(ptr, 0) < APPDESC_SIZE) return null;
    const reserved = readGuestBytes(r32(ptr, 0x38), r32(ptr, 0x3c));
    const appReserved = readGuestBytes(r32(ptr, 0x40), r32(ptr, 0x44));
    if (!reserved || !appReserved) return null;
    return {
        flags: r32(ptr, 4),
        instance: guidAt(ptr + 8) || ZERO_GUID,
        application: guidAt(ptr + 0x18) || ZERO_GUID,
        maxPlayers: r32(ptr, 0x28),
        currentPlayers: r32(ptr, 0x2c),
        sessionName: readWide(r32(ptr, 0x30), MAX_STRING_CHARS),
        password: readWide(r32(ptr, 0x34), MAX_STRING_CHARS),
        reserved,
        appReserved,
    };
}

/** DPN_PLAYER_INFO / DPN_GROUP_INFO share their first five fields; only fields flagged in dwInfoFlags are returned. */
function readInfoStruct(ptr: number): { name: string | null; data: Uint8Array | null; extra: number } | null {
    if (!validPointer(ptr, PLAYER_INFO_SIZE, "r") || r32(ptr, 0) !== PLAYER_INFO_SIZE) return null;
    const flags = r32(ptr, 4);
    const data = flags & INFO_DATA ? readGuestBytes(r32(ptr, 0xc), r32(ptr, 0x10)) : new Uint8Array(0);
    if (!data) return null;
    return {
        name: flags & INFO_NAME ? readWide(r32(ptr, 8), MAX_STRING_CHARS) : null,
        data: flags & INFO_DATA ? data : null,
        extra: r32(ptr, 0x14),
    };
}

function readPlayerInfo(ptr: number): { name: string | null; data: Uint8Array | null } | null {
    return readInfoStruct(ptr);
}

function readGroupInfo(ptr: number): { name: string | null; data: Uint8Array | null; groupFlags: number } | null {
    const info = readInfoStruct(ptr);
    return info ? { name: info.name, data: info.data, groupFlags: info.extra } : null;
}

/** Fill a caller-sized DPN_PLAYER_INFO / DPN_GROUP_INFO, appending the name and data after the struct. */
function writeInfoStruct(ptr: number, sizePtr: number, structSize: number, name: string, data: Uint8Array, extra: number): number {
    if (!validPointer(sizePtr, 4, "rw")) return E_POINTER;
    const nameBytes = name ? wideBytes(name) : new Uint8Array(0);
    const need = structSize + nameBytes.length + data.length;
    const have = Mem.readUint32(sizePtr) ?? 0;
    Mem.writeUint32(sizePtr, need);
    if (!ptr || have < need || !validPointer(ptr, need, "rw")) return Hr.BUFFERTOOSMALL;
    const buf = new Uint8Array(need);
    const view = new DataView(buf.buffer);
    view.setUint32(0, structSize, true);
    view.setUint32(4, (name ? INFO_NAME : 0) | (data.length ? INFO_DATA : 0), true);
    buf.set(nameBytes, structSize);
    buf.set(data, structSize + nameBytes.length);
    view.setUint32(8, name ? ptr + structSize : 0, true);
    view.setUint32(0xc, data.length ? ptr + structSize + nameBytes.length : 0, true);
    view.setUint32(0x10, data.length, true);
    view.setUint32(0x14, extra, true);
    Mem.writeBytes(ptr, buf);
    return S_OK;
}

function writeIdList(arr: number, countPtr: number, ids: number[]): number {
    if (!validPointer(countPtr, 4, "rw")) return E_POINTER;
    const have = Mem.readUint32(countPtr) ?? 0;
    Mem.writeUint32(countPtr, ids.length);
    if (ids.length === 0) return S_OK;
    if (!arr || have < ids.length || !validPointer(arr, ids.length * 4, "rw")) return Hr.BUFFERTOOSMALL;
    Mem.writeBytes(arr, new Uint8Array(Uint32Array.from(ids).buffer));
    return S_OK;
}

/** Copy `data` into a caller buffer of `*sizePtr` bytes, reporting the size needed. */
function writeSized(buf: number, sizePtr: number, data: Uint8Array): number {
    if (!validPointer(sizePtr, 4, "rw")) return E_POINTER;
    const have = Mem.readUint32(sizePtr) ?? 0;
    Mem.writeUint32(sizePtr, data.length);
    if (data.length === 0) return S_OK;
    if (!buf || have < data.length || !validPointer(buf, data.length, "rw")) return Hr.BUFFERTOOSMALL;
    Mem.writeBytes(buf, data);
    return S_OK;
}

function writeComponent(value: Dp8Address["components"] extends Map<string, infer V> ? V : never, buf: number, sizePtr: number, typePtr: number): number {
    let raw: Uint8Array;
    switch (value.type) {
        case DPNA_DATATYPE_DWORD: {
            raw = new Uint8Array(4);
            new DataView(raw.buffer).setUint32(0, value.value, true);
            break;
        }
        case DPNA_DATATYPE_GUID: raw = guidToBytes(value.value); break;
        case DPNA_DATATYPE_STRING: raw = wideBytes(value.value); break;
        default: raw = value.value;
    }
    out32(typePtr, value.type);
    return writeSized(buf, sizePtr, raw);
}

export type { Group, Player };
