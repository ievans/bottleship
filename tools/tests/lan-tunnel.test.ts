import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LanRelay, MAX_CONN_PER_KEY, addressKey, serveLan } from "../../deploy/lan-relay";
import { ROOM_NAME } from "../../src/net/lan-protocol";
import { lanInviteUrl, lanRoomFromSearch, newLanRoom } from "../../src/net/lan-url";
import { standRelaySource, writeStandRelay } from "../stand-relay";

function keyFor(opts: { trustProxy: boolean }, headers: Record<string, string>, socket = "10.0.0.1"): string {
    let key = "";
    const server = { upgrade: (_r: Request, o: { data: { key: string } }) => { key = o.data.key; return true; }, requestIP: () => ({ address: socket }) };
    serveLan({ relay: new LanRelay(), ...opts }).upgrade(new Request("http://h/lan/a", { headers: { Host: "h", ...headers } }), server);
    return key;
}

describe("behind a tunnel", () => {
    test("CF-Connecting-IP identifies the client, and is not forgeable through X-Forwarded-For", () => {
        const spoof = { "CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "1.2.3.4, 203.0.113.7" };
        expect(keyFor({ trustProxy: true }, spoof)).toBe("203.0.113.7");
        expect(keyFor({ trustProxy: true }, { "X-Forwarded-For": "1.2.3.4" })).toBe("1.2.3.4");
        expect(keyFor({ trustProxy: true }, {})).toBe("10.0.0.1");
    });
    test("without trust every client shares the proxy's address; headers are ignored", () => {
        expect(keyFor({ trustProxy: false }, { "CF-Connecting-IP": "203.0.113.7" })).toBe("10.0.0.1");
    });
    test("clients behind one tunnel get a cap each once the proxy is trusted", () => {
        const relay = new LanRelay();
        const open = (key: string) => relay.join("r", () => {}, { key });
        for (let i = 0; i < MAX_CONN_PER_KEY; i++) expect(open("10.0.0.1")).not.toBeNull();
        expect(open("10.0.0.1")).toBeNull();
        expect(open("203.0.113.7")).not.toBeNull();
    });
    test("an IPv6 client is capped per /64, not per address", () => {
        expect(addressKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(addressKey("2001:DB8:1:2::1"));
        expect(addressKey("2001:db8:1:2::1")).not.toBe(addressKey("2001:db8:1:3::1"));
        expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
        expect(addressKey("::1")).toBe("0:0:0:0::/64");
        expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
        expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
        expect(addressKey("unknown")).toBe("unknown");
        expect(addressKey("1:2:3")).toBe("1:2:3");
    });
});

describe("room names", () => {
    test("are valid, long, distinct and unbiased in alphabet", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) {
            const r = newLanRoom();
            expect(ROOM_NAME.test(r)).toBe(true);
            expect(r.length).toBe(20);
            seen.add(r);
        }
        expect(seen.size).toBe(200);
    });
    test("bytes at or above 252 are rejected rather than folded onto the first letters", () => {
        const bytes = [255, 252, 0, 35, 36, 71];
        let i = 0;
        const rand = (n: number) => Uint8Array.from({ length: n }, () => bytes[i++ % bytes.length]);
        expect(newLanRoom(rand)).toBe("a9a9a9a9a9a9a9a9a9a9");
    });
});

describe("stand payload", () => {
    test("the relay ships beside server.ts and loads from the flat layout", async () => {
        const repo = path.resolve(import.meta.dir, "../..");
        const out = mkdtempSync(path.join(tmpdir(), "bs-stand-"));
        try {
            writeStandRelay(repo, out);
            const mod = await import(path.join(out, "lan-relay.ts"));
            expect(typeof mod.serveLan).toBe("function");
            expect(readFileSync(path.join(out, "lan-relay.ts"), "utf8")).not.toContain("../src/net");
        } finally { rmSync(out, { recursive: true, force: true }); }
    });
    test("a relay that stops importing the wire format by that path fails the pack loudly", () => {
        expect(() => standRelaySource('import x from "./other";')).toThrow(/no longer imports/);
    });
});

describe("invite links and ?lan= parsing", () => {
    test("an invalid or absent room is not a room", () => {
        expect(lanRoomFromSearch("?game=dev")).toBeNull();
        expect(lanRoomFromSearch("?lan=")).toBeNull();
        expect(lanRoomFromSearch("?lan=a%2Fb")).toBeNull();
        expect(lanRoomFromSearch("?lan=" + "a".repeat(33))).toBeNull();
        expect(lanRoomFromSearch("?lan=room_1-x")).toBe("room_1-x");
    });

    test("an invite keeps what a peer needs and drops what is local to this browser", () => {
        const u = new URL(lanInviteUrl("http://10.0.0.5:5174/?game=dev&load=%2Fapps%2Fx.wgb&bs=alpha&ingest=1&lan=old", "newroom"));
        expect(u.origin + u.pathname).toBe("http://10.0.0.5:5174/");
        expect(u.searchParams.get("game")).toBe("dev");
        expect(u.searchParams.get("load")).toBe("/apps/x.wgb");
        expect(u.searchParams.get("lan")).toBe("newroom");
        expect(u.searchParams.has("bs")).toBe(false);
        expect(u.searchParams.has("ingest")).toBe(false);
    });
});
