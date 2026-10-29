import { afterEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { Iphlpapi } from "../../src/worker/modules/iphlpapi";
import { lanStack, configureLan } from "../../src/worker/net/lan";

const guest = new Uint8Array(8192);
Mem.bind(() => guest);

const ip = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
const readAnsi = (addr: number, maxLen: number) => {
    const end = guest.indexOf(0, addr);
    const n = Math.min(end === -1 ? maxLen : end - addr, maxLen);
    return new TextDecoder().decode(guest.subarray(addr, addr + n));
};

function getAdaptersInfo() {
    const mod = new Iphlpapi();
    mod.initialize(null as never);
    const PADAPTER = 0x100, POUTBUFLEN = 0x1000;
    guest.fill(0, PADAPTER, PADAPTER + 1024);
    Mem.writeUint32(POUTBUFLEN, 1024);
    const ret = mod.exports["GetAdaptersInfo"]!(null as never, guest, [PADAPTER, POUTBUFLEN]);
    return { ret, outLen: Mem.readUint32(POUTBUFLEN)!, buf: PADAPTER };
}

afterEach(() => {
    // Leave no room joined / no stray retry timer between tests.
    configureLan(null);
    lanStack.ip = null;
});

describe("iphlpapi GetAdaptersInfo", () => {
    test("offline (no LAN room): ERROR_NO_DATA, unchanged from before", () => {
        const { ret } = getAdaptersInfo();
        expect(ret).toEqual({ value: 232, stackCleanup: 8 });
    });

    test("in a LAN room: reports one adapter with our virtual address", () => {
        // lanActive() only checks "a room URL was requested", not socket connection state —
        // so this exercises the real wiring without needing a live relay.
        configureLan("ws://127.0.0.1:1/nope");
        lanStack.ip = ip(192, 168, 77, 5);

        const { ret, outLen, buf } = getAdaptersInfo();
        expect(ret).toEqual({ value: 0, stackCleanup: 8 });
        expect(outLen).toBe(640);
        expect(readAnsi(buf + 428 + 4, 16)).toBe("192.168.77.5");
        expect(readAnsi(buf + 428 + 20, 16)).toBe("255.255.255.0");
        expect(readAnsi(buf + 468 + 4, 16)).toBe("192.168.77.1"); // GatewayList
        expect(Mem.readUint32(buf + 400)).toBe(6); // AddressLength
        expect(Mem.readUint32(buf + 416)).toBe(6); // Type == MIB_IF_TYPE_ETHERNET
    });

    test("in a room but caller's buffer is too small: ERROR_BUFFER_OVERFLOW, needed size reported", () => {
        configureLan("ws://127.0.0.1:1/nope");
        lanStack.ip = ip(192, 168, 77, 9);

        const mod = new Iphlpapi();
        mod.initialize(null as never);
        const PADAPTER = 0x100, POUTBUFLEN = 0x1000;
        Mem.writeUint32(POUTBUFLEN, 32); // too small for a 640-byte IP_ADAPTER_INFO
        const ret = mod.exports["GetAdaptersInfo"]!(null as never, guest, [PADAPTER, POUTBUFLEN]);
        expect(ret).toEqual({ value: 111, stackCleanup: 8 });
        expect(Mem.readUint32(POUTBUFLEN)).toBe(640);
    });
});
