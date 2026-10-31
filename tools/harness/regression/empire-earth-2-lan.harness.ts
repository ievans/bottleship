/**
 * Empire Earth II LAN lobby, both directions against a synthetic peer on the virtual LAN
 * (a second guest costs gigabytes; the peer speaks the game's own wire format):
 *
 *  - HOST: the guest creates a LAN game and broadcasts a periodic UDP announce containing
 *    the game name and version — a synthetic peer sniffing the room decodes it.
 *  - JOIN: a synthetic peer broadcasts a spoofed announce; the guest lists it in "Available
 *    Games", and clicking "Join Selected Game" sends a structured binary join-request
 *    datagram directly to the announced host, retried on a backoff when unanswered.
 *
 * Neither leg may fault the guest. EE2's LAN protocol is entirely UDP port 26000 (no TCP
 * socket is opened at any point observed) — unlike Empire Earth's "TCP Protocol" lobby
 * (UDP announce + TCP 33336 join), confirmed by `lanState` showing a single bound UDP
 * socket throughout. The join-accept reply format is NOT reverse engineered (needs a
 * disassembled EE2.exe — pyghidra wasn't available in this environment, no JVM installed);
 * a synthetic peer that only broadcasts an announce therefore cannot complete a full join,
 * but the exchange up to that point — discovery, selection, and the guest's outbound join
 * request — is real, verified traffic. See docs/multiplayer.md for the decoded wire format
 * and this file's git history / issue #8 for the capture session.
 *
 * Prereqs: `bun run dev:mp` (vite + the LAN relay), `bun tools/harness.ts up`. WGB = the
 * repacked bundle. Menu navigation is absolute-click (EE2's menus do not use the relative
 * DirectInput cursor some other titles' menus do — confirmed via `relativeMousePosture()`
 * showing no guest reads of the buffered mouse device at any menu screen). Screenshots land
 * under logs/<BS_TAB>/debug/empire-earth-2-lan/.
 *
 * A ONE-TIME "New Feature: profanity filter" prompt follows the hosting warning on a
 * guest's first-ever visit to Multiplayer in a given bundle's persisted storage (it does
 * not reappear on later boots once dismissed — the flag survives a fresh process start
 * because it is written to the guest's own virtual disk, not in-memory state). Not handled
 * here: a click coordinate that safely dismisses it when present would land on a real
 * Multiplayer-screen button when it is absent (its Yes/No buttons overlap that screen's
 * button stack), and there is no cheap, reliable pixel check that discriminates a dialog
 * box from the Multiplayer panel sitting behind it (both are the same dark UI chrome). A
 * truly fresh bundle (clean OPFS) hits this once; this harness assumes storage already
 * past that first run, as any repeated local or CI run will be after the first.
 */
import { harness } from "../../harness";
import { LanPeer, parseIp, relayUrl, sniff } from "../../lan-peer";
import { ipToString } from "../../../src/net/lan-protocol";

const wgb = process.env.WGB;
if (!wgb) throw new Error("WGB must point to the repacked Empire Earth II bundle (a local owned copy)");
const bundle = wgb.startsWith("/apps/") || wgb.startsWith("http") ? wgb : `http://localhost:3001/wgb?path=${encodeURIComponent(wgb)}`;
const ROOM = `ee2-lan-${process.pid}`;
const RELAY = process.env.RELAY ?? "ws://localhost:5174";

// Guest coordinates, 1920x1080 (EE2's own internal resolution, independent of the bundle's
// manifest screenResolution — confirmed via gridShot).
const UI = {
    multiplayer: [987, 252], warningOk: [1146, 784],
    lanDirectConnect: [860, 510], createGame: [1140, 650], createGameConfirm: [1416, 638],
    createWarningOk: [1145, 682], cancelHosting: [1517, 1008],
    gameListRow: [676, 386], joinSelectedGame: [776, 647],
} as const;

const UDP_PORT = 26000;
// A real captured host announce (magic, opcode 4, tick, then u16-length-prefixed "Player's
// Game" and "1.2" strings, then a ~20-byte trailer not decoded further).
const ANNOUNCE = Uint8Array.from(Buffer.from(
    "ffff000100049e84000000000b0000000000003a00000000020000000d00" +
    "506c6179657227732047616d650300312e32050076daaf6458a9007d7b19daedb4ffe473f5bd4f2e",
    "hex",
));

function fail(msg: string): never { throw new Error(msg); }
async function step(what: string, chain: ReturnType<typeof harness>): Promise<Record<string, any>> {
    const r = await chain.run();
    if (!r.ok) fail(`${what}: ${JSON.stringify(r.error)}`);
    return r.named as Record<string, any>;
}
// A single click, held briefly (clickAt's own press/release timing) — verified directly
// against the live menu; EE2's buttons do not need empire-earth-lan.harness.ts's
// double-click (and a same-position second click within the system dblclk window risks
// being coalesced into WM_LBUTTONDBLCLK instead of a second DOWN/UP, which a button that
// only handles single clicks silently drops).
const click = (c: readonly [number, number], settle = 2500) => harness().clickAt(c[0], c[1]).sleep(settle);
async function noFault(when: string): Promise<void> {
    const rep = (await step(`report ${when}`, harness().report())).report as { crash: unknown; faults?: unknown[] };
    if (rep.crash || rep.faults?.length) fail(`guest faulted ${when}: ${JSON.stringify(rep.crash ?? rep.faults)}`);
}

// ---- boot and reach the LAN lobby --------------------------------------------------------
// lanJoin's own URL default resolves against the PAGE's origin (same-origin /lan/ proxy), which
// is NOT necessarily RELAY — pass the same relayUrl(RELAY, ROOM) explicitly so the guest and
// the synthetic peers below are provably on the same relay, not just usually on the same one.
await step("boot", harness().openWgb(bundle).lanJoin(ROOM, relayUrl(RELAY, ROOM)).lanTrace({ enable: true, reset: true }).sleep(25_000)
    .key("Escape").sleep(4000).key("Escape").sleep(10_000));
await step("multiplayer", click(UI.multiplayer, 3500));
await step("hosting warning", click(UI.warningOk, 3500));
await step("lan lobby", click(UI.lanDirectConnect, 3500));
await noFault("at the LAN lobby");
await step("lan lobby shot", harness().shot({ save: "empire-earth-2-lan/00-lobby.png" }));

// ---- HOST leg: create a game, a synthetic peer sniffs the announce -----------------------
// Confirmed layout (docs/multiplayer.md): magic ffff0001 [0:4], pad 00 [4], then (leaving
// [5:28] explicitly undecoded — byte [5] looked like a fixed "announce opcode" (04) across
// one hosting session's 5 captures, but reads 00 in another session: it is NOT a stable
// marker, don't validate on it) a u16-LE name length at [28:30] + the UTF-8 name, immediately
// followed by a u16-LE version length + the version string.
function parseAnnounce(hex: string): { name: string; version: string } | null {
    const b = Buffer.from(hex, "hex");
    if (b.length < 30 || b.readUInt32BE(0) !== 0xffff0001 || b[4] !== 0x00) return null;
    const nameLen = b.readUInt16LE(28);
    const nameEnd = 30 + nameLen;
    if (nameEnd + 2 > b.length) return null;
    const verLen = b.readUInt16LE(nameEnd);
    const verEnd = nameEnd + 2 + verLen;
    if (verEnd > b.length) return null;
    return { name: b.subarray(30, nameEnd).toString("utf8"), version: b.subarray(nameEnd + 2, verEnd).toString("utf8") };
}

const sniffing = sniff({ room: ROOM, relay: RELAY, ms: 20_000, log: () => {} });
await step("create game dialog", click(UI.createGame, 3500));
await step("confirm create", click(UI.createGameConfirm, 4000));
await step("create-game warning", click(UI.createWarningOk, 3500));
await harness().sleep(9000).run();
const hostResult = await sniffing;
const announces = hostResult.events
    .filter((e) => e.op === "udp" && e.dstPort === UDP_PORT && e.len > 0)
    .map((e) => parseAnnounce(e.hex))
    .filter((a): a is { name: string; version: string } => a !== null && a.name === "Player's Game");
if (announces.length < 2) fail(`expected at least 2 valid host announces (name "Player's Game") on UDP ${UDP_PORT}, saw ${announces.length}`);
const name = announces[0]!.name;
await noFault("after hosting");
await step("host shot", harness().shot({ save: "empire-earth-2-lan/01-hosting.png" }));

await step("cancel hosting", click(UI.cancelHosting, 2500));
await noFault("after cancelling hosting");

// ---- JOIN leg: a synthetic peer announces; the guest discovers and attempts to join -------
// The guest is always the first peer to join the room (in the "boot" step above, before any
// synthetic peer here), so it is provably 192.168.77.2 — this is also the convention
// empire-earth-lan.harness.ts uses for the same reason.
const GUEST_IP = parseIp("192.168.77.2")!;
// Confirmed layout (docs/multiplayer.md): magic ffff0001 [0:4], pad 00 [4], exactly 56 bytes,
// with a self-length field at [16:20] that reads 44 (= 56 - 12, the negotiation body's own
// length) in every capture seen.
function isJoinRequest(data: Uint8Array): boolean {
    if (data.length !== 56) return false;
    const b = Buffer.from(data);
    // The negotiation body's own fields are big-endian, unlike the announce packet's
    // little-endian string-length prefixes — confirmed empirically, not a typo.
    return b.readUInt32BE(0) === 0xffff0001 && b[4] === 0x00 && b.readUInt32BE(16) === 44;
}

const peer = await LanPeer.join({ room: ROOM, relay: RELAY, log: () => {} });
const SOCK_UDP = 2;
const s = peer.socket(SOCK_UDP);
const berr = peer.stack.bind(s, 0, UDP_PORT);
if (berr) fail(`synthetic peer bind UDP ${UDP_PORT}: Winsock error ${berr}`);

const broadcast = parseIp("broadcast")!;
const joinRequests: string[] = [];
let lastAnnounce = 0;
const joinStart = Date.now();
let joinClick: Promise<{ ok: boolean; error?: unknown }> | null = null;
while (Date.now() - joinStart < 20_000) {
    if (Date.now() - lastAnnounce > 3000) {
        peer.stack.sendTo(s, broadcast, UDP_PORT, ANNOUNCE);
        lastAnnounce = Date.now();
    }
    for (;;) {
        const r = peer.stack.recv(s, 65535, false);
        if (r.err !== 0) break;
        // Must be addressed to us specifically (not a broadcast this peer also just happens
        // to receive) and structurally a join request, not incidental traffic of some other
        // length and shape.
        if (r.ip === GUEST_IP && isJoinRequest(r.data)) {
            joinRequests.push(Buffer.from(r.data).toString("hex"));
            // No accept-reply format is known (see header comment) — the request itself,
            // arriving well-formed and addressed to us, is what this leg verifies.
        }
    }
    if (!joinClick && Date.now() - joinStart > 1500) {
        joinClick = harness().clickAt(...UI.gameListRow).sleep(1000).clickAt(...UI.joinSelectedGame).sleep(1000)
            .clickAt(...UI.joinSelectedGame).sleep(3000).shot({ save: "empire-earth-2-lan/02-join-attempt.png" })
            .run();
    }
    await new Promise((r) => setTimeout(r, 120));
}
peer.leave();

if (!joinClick) fail("the join click chain never started");
const joinClickResult = await joinClick;
if (!joinClickResult.ok) fail(`the join click chain failed: ${JSON.stringify(joinClickResult.error)}`);

if (joinRequests.length === 0) {
    fail("the guest never sent a valid join request, from itself, to the announced synthetic host");
}
await noFault("after attempting to join");
console.log(`empire-earth-2-lan: host leg ok (announce "${name}" decoded), join leg ok ` +
    `(${joinRequests.length} valid join request(s) reached the synthetic host from the guest); ` +
    `full join-accept not exercised (reply format unknown — see header comment)`);
