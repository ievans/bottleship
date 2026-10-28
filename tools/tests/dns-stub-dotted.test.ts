import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createDnsStubs } from "../../src/worker/modules/wsa-stub-shared";

const guest = new Uint8Array(1 << 16);
Mem.bind(() => guest);
const dv = new DataView(guest.buffer);

function stubs() {
    let next = 0x1000;
    let err = -1;
    const process = { memory: { alloc: (n: number) => { const a = next; next += (n + 15) & ~15; return a; } } } as never;
    const dns = createDnsStubs(process, e => { err = e; });
    const lookup = (name: string) => {
        guest.set(new TextEncoder().encode(`${name}\0`), 0x100);
        const p = dns.gethostbyname(null as never, guest, [0x100]) as number;
        if (!p) return null;
        const nameAt = dv.getUint32(p, true), a = dv.getUint32(dv.getUint32(p + 12, true), true);
        return { name: new TextDecoder().decode(guest.subarray(nameAt, guest.indexOf(0, nameAt))), addr: Array.from(guest.subarray(a, a + 4)).join(".") };
    };
    return { dns, lookup, err: () => err };
}

describe("offline gethostbyname", () => {
    test("a dotted-decimal name resolves to itself, not loopback", () => {
        const s = stubs();
        expect(s.lookup("192.168.77.3")).toEqual({ name: "192.168.77.3", addr: "192.168.77.3" });
        expect(s.lookup("255.255.255.255")).toEqual({ name: "255.255.255.255", addr: "255.255.255.255" });
        expect(s.err()).toBe(0);
    });

    test("every other name still resolves to loopback, and the static buffer is overwritten per call", () => {
        const s = stubs();
        s.lookup("10.1.2.3");
        expect(s.lookup("example.com")).toEqual({ name: "localhost", addr: "127.0.0.1" });
        expect(s.lookup("1.2.3")).toEqual({ name: "localhost", addr: "127.0.0.1" });
        expect(s.lookup("999.1.1.1")).toEqual({ name: "localhost", addr: "127.0.0.1" });
    });

    test("gethostbyaddr after a dotted lookup answers loopback again", () => {
        const s = stubs();
        s.lookup("10.1.2.3");
        guest.set([10, 1, 2, 3], 0x200);
        const p = s.dns.gethostbyaddr(null as never, guest, [0x200, 4, 2]) as number;
        const a = dv.getUint32(dv.getUint32(p + 12, true), true);
        expect(Array.from(guest.subarray(a, a + 4))).toEqual([127, 0, 0, 1]);
    });
});
