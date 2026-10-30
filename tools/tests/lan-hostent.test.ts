import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { LanStack } from "../../src/worker/net/lan-stack";
import { createLanExports, PASS } from "../../src/worker/net/lan-exports";
import { WsaSocketTable } from "../../src/worker/modules/wsa-stub-shared";

const guest = new Uint8Array(1 << 16);
Mem.bind(() => guest);
const dv = new DataView(guest.buffer);
const ip = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

function host(addr: number | null) {
    const stack = new LanStack();
    stack.ip = addr;
    let err = -1;
    const x = createLanExports({
        stack, table: new WsaSocketTable(),
        process: { memory: { alloc: () => 0x4000 } } as never,
        setError: e => { err = e; }, isActive: () => true, clearEvent: () => {},
    });
    const str = (off: number, s: string) => { guest.set(new TextEncoder().encode(`${s}\0`), off); return off; };
    const call = (name: string, ...args: number[]) => x[name](null as never, guest, args);
    const hostent = (p: number) => {
        const nameAt = dv.getUint32(p, true);
        const list = dv.getUint32(p + 12, true);
        const a = dv.getUint32(list, true);
        return {
            name: new TextDecoder().decode(guest.subarray(nameAt, guest.indexOf(0, nameAt))),
            type: dv.getUint16(p + 8, true), len: dv.getUint16(p + 10, true),
            addr: ip(guest[a], guest[a + 1], guest[a + 2], guest[a + 3]),
            terminated: dv.getUint32(list + 4, true) === 0,
        };
    };
    return { call, str, hostent, err: () => err };
}

describe("LAN host name resolution", () => {
    test("gethostbyname resolves our own name and a peer's BOTTLESHIP-N on the /24", () => {
        const h = host(ip(192, 168, 77, 2));
        const own = h.call("gethostbyname", h.str(0x100, "BOTTLESHIP-2")) as number;
        expect(h.hostent(own)).toMatchObject({ name: "BOTTLESHIP-2", type: 2, len: 4, addr: ip(192, 168, 77, 2), terminated: true });
        const peer = h.call("gethostbyname", h.str(0x100, "bottleship-3")) as number;
        expect(h.hostent(peer)).toMatchObject({ name: "BOTTLESHIP-3", addr: ip(192, 168, 77, 3) });
        expect(h.err()).toBe(0);
    });

    test("gethostbyname defers for names it does not own", () => {
        const h = host(ip(192, 168, 77, 2));
        expect(h.call("gethostbyname", h.str(0x100, "example.com"))).toBe(PASS);
        expect(h.call("gethostbyname", h.str(0x100, "BOTTLESHIP-0"))).toBe(PASS);
        expect(h.call("gethostbyname", h.str(0x100, "BOTTLESHIP-300"))).toBe(PASS);
        expect(host(null).call("gethostbyname", 0)).toBe(PASS);
    });

    test("gethostbyaddr returns the peer's name for a LAN address", () => {
        const h = host(ip(192, 168, 77, 2));
        h.str(0x200, "");
        guest.set([192, 168, 77, 7], 0x200);
        const p = h.call("gethostbyaddr", 0x200, 4, 2) as number;
        expect(h.hostent(p)).toMatchObject({ name: "BOTTLESHIP-7", addr: ip(192, 168, 77, 7) });
        expect(h.err()).toBe(0);
    });

    test("gethostbyaddr defers for off-LAN addresses, bad length/type, or no room", () => {
        const h = host(ip(192, 168, 77, 2));
        guest.set([8, 8, 8, 8], 0x200);
        expect(h.call("gethostbyaddr", 0x200, 4, 2)).toBe(PASS);
        guest.set([192, 168, 77, 7], 0x200);
        expect(h.call("gethostbyaddr", 0x200, 3, 2)).toBe(PASS);
        expect(h.call("gethostbyaddr", 0x200, 4, 23)).toBe(PASS);
        expect(host(null).call("gethostbyaddr", 0x200, 4, 2)).toBe(PASS);
    });
});
