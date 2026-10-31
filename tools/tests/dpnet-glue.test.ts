import { afterEach, beforeEach, expect, test } from "bun:test";
import { CLSID_DirectPlay8Address, CLSID_DirectPlay8Peer, Dpnet } from "../../src/worker/modules/dpnet";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { Msgid } from "../../src/worker/modules/dpnet/dpnet-constants";

const system = System.getInstance(), rp = SystemResourceProvider.getInstance();
const IID_IUnknown = "00000000-0000-0000-c000-000000000046";
const TCPIP = "ebfe7ba0-628d-11d2-ae0f-006097b01411";
const OUT = 0x200, TMP = 0x400, BUF = 0x1000, DESC = 0x3000, DEVS = 0x3200;
const BUFFERTOOSMALL = 0x80158100 | 0;
let module: Dpnet, mem: Uint8Array, savedProcess: any;
let callbacks: Array<{ addr: number; ctx: number; msg: number; size: number; player: number }>;
let bump: number;
const created: any[] = [];

beforeEach(() => {
    savedProcess = system.process;
    mem = new Uint8Array(0x100000);
    Mem.bind(() => mem);
    bump = 0x10000;
    callbacks = [];
    const alloc = (n: number) => { const p = bump; bump += (n + 15) & ~15; return p; };
    const process = {
        memory: { systemPoolGeneration: 9100, allocSystemBlock: alloc, freeSystemBlock: () => {}, alloc, free: () => {} },
        addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length },
        getCurrentMemory: () => mem,
        getModule: (name: string) => name !== "winmm" ? undefined : {
            postGuestCallback: (addr: number, args: number[], onReturn?: (eax: number) => void) => {
                const [ctx, msg, ptr] = args;
                callbacks.push({ addr, ctx: ctx!, msg: msg!, size: Mem.readUint32(ptr!)!, player: Mem.readUint32(ptr! + 4)! });
                queueMicrotask(() => onReturn?.(0));
                return true;
            },
        },
    };
    system.process = process as any;
    module = new Dpnet();
    (module as any).process = process;
    module.vtables = new Proxy({}, { get: () => ({ address: 0x1000 }) });
    for (const i of ["IDirectPlay8Peer", "IDirectPlay8Address", "IDirectPlay8LobbiedApplication"]) (module as any).registerUnknownExports(i);
    (module as any).registerPeerExports();
    (module as any).registerAddressExports();
    (module as any).registerLobbyExports();
});
afterEach(() => {
    module.reset();
    for (const o of created.splice(0)) o.forceRelease?.();
    system.process = savedProcess;
});

const call = (name: string, ...args: number[]) => module.exports[name]!({} as never, mem, args) as number | Promise<number>;
const wide = (at: number, s: string) => { for (let i = 0; i <= s.length; i++) Mem.writeUint16(at + i * 2, i < s.length ? s.charCodeAt(i) : 0); };
const guid = (at: number, g: string) => {
    const h = g.replace(/-/g, "");
    const b = [0, 1, 2, 3].map(i => parseInt(h.substr(6 - i * 2, 2), 16)).concat([4, 5].map(i => parseInt(h.substr(10 - (i - 4) * 2, 2), 16)),
        [6, 7].map(i => parseInt(h.substr(14 - (i - 6) * 2, 2), 16)), [8, 9, 10, 11, 12, 13, 14, 15].map(i => parseInt(h.substr(i * 2, 2), 16)));
    mem.set(b, at);
};
function create(clsid: string): number {
    expect(module.coCreateInstance(clsid, IID_IUnknown, OUT)).toBe(0);
    const ptr = Mem.readUint32(OUT)!;
    created.push(rp.getComObjectByAddress(ptr));
    return ptr;
}
const text = (at: number) => { let s = ""; for (let c = mem[at]!; c; c = mem[++at]!) s += String.fromCharCode(c); return s; };

test("an address built from components reports its URL, with the size query answered first", () => {
    const addr = create(CLSID_DirectPlay8Address);
    guid(TMP, TCPIP);
    expect(call("IDirectPlay8Address_SetSP", addr, TMP)).toBe(0);
    wide(TMP + 0x40, "hostname");
    wide(TMP + 0x80, "10.1.2.3");
    expect(call("IDirectPlay8Address_AddComponent", addr, TMP + 0x40, TMP + 0x80, 18, 1)).toBe(0);
    Mem.writeUint32(OUT + 8, 0);
    expect(call("IDirectPlay8Address_GetURLA", addr, BUF, OUT + 8)).toBe(BUFFERTOOSMALL);
    const need = Mem.readUint32(OUT + 8)!;
    expect(need).toBeGreaterThan(10);
    expect(call("IDirectPlay8Address_GetURLA", addr, BUF, OUT + 8)).toBe(0);
    const url = text(BUF);
    expect(url).toContain("hostname=10.1.2.3");
    expect(url.length + 1).toBe(need);

    const copy = create(CLSID_DirectPlay8Address);
    mem.set(new TextEncoder().encode(url + "\0"), BUF + 0x400);
    expect(call("IDirectPlay8Address_BuildFromURLA", copy, BUF + 0x400)).toBe(0);
    expect(call("IDirectPlay8Address_IsEqual", addr, copy)).toBe(0);
    expect(call("IDirectPlay8Address_Clear", copy)).toBe(0);
    expect(call("IDirectPlay8Address_IsEqual", addr, copy)).toBe(1);
});

test("a peer rejects use before Initialize and a second Initialize", () => {
    const peer = create(CLSID_DirectPlay8Peer);
    expect(call("IDirectPlay8Peer_Close", peer)).toBe(0x80158600 | 0);
    expect(call("IDirectPlay8Peer_Initialize", peer, 7, 0x5000, 0)).toBe(0);
    expect(call("IDirectPlay8Peer_Initialize", peer, 7, 0x5000, 0)).toBe(0x80158070 | 0);
});

test("Host delivers CREATE_PLAYER to the guest handler and the session is enumerable", async () => {
    const peer = create(CLSID_DirectPlay8Peer);
    expect(call("IDirectPlay8Peer_Initialize", peer, 0x1234, 0x5000, 0)).toBe(0);

    const dev = create(CLSID_DirectPlay8Address);
    wide(TMP + 0x40, "port");
    Mem.writeUint32(TMP + 0x80, 6199);
    expect(call("IDirectPlay8Address_AddComponent", dev, TMP + 0x40, TMP + 0x80, 4, 2)).toBe(0);
    Mem.writeUint32(DEVS, dev);

    Mem.writeUint32(DESC, 0x48);
    wide(DESC + 0x100, "Glue Session");
    Mem.writeUint32(DESC + 0x30, DESC + 0x100);
    Mem.writeUint32(DESC + 0x28, 4);

    expect(await call("IDirectPlay8Peer_Host", peer, DESC, DEVS, 1, 0, 0, 0xabc, 0)).toBe(0);
    expect(callbacks.length).toBe(1);
    expect(callbacks[0]).toMatchObject({ addr: 0x5000, ctx: 0x1234, msg: Msgid.CREATE_PLAYER >>> 0, size: 12 });

    Mem.writeUint32(OUT, 4);
    expect(call("IDirectPlay8Peer_EnumPlayersAndGroups", peer, BUF, OUT, 1)).toBe(0);
    expect(Mem.readUint32(OUT)).toBe(1);
    expect(Mem.readUint32(BUF)).toBe(callbacks[0]!.player);

    Mem.writeUint32(OUT + 8, 0);
    expect(call("IDirectPlay8Peer_GetApplicationDesc", peer, BUF, OUT + 8, 0)).toBe(BUFFERTOOSMALL);
    expect(call("IDirectPlay8Peer_GetApplicationDesc", peer, BUF, OUT + 8, 0)).toBe(0);
    expect(Mem.readUint32(BUF + 0x28)).toBe(4);
    expect(Mem.readUint32(BUF + 0x2c)).toBe(1);

    expect(await call("IDirectPlay8Peer_Close", peer)).toBe(0);
    expect(call("IDirectPlay8Peer_Close", peer)).toBe(0x80158600 | 0);
});

test("a class that is not DirectPlay 8 is left for other providers", () => {
    expect(module.coCreateInstance("0f0f094b-b01c-4091-a14d-dd0cd807711a", IID_IUnknown, OUT)).toBeNull();
});
