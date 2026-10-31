/**
 * Civilization III LAN multiplayer (DirectPlay 8 over the virtual LAN), both directions against a
 * synthetic DP8 peer on the same relay room (a second guest costs gigabytes; the peer runs the same
 * Dp8Engine the guest's dpnet.dll does):
 *
 *  - HOST: the guest hosts; the peer enumerates it, connects with the game's "Firaxis" connect
 *    handshake and receives the game's session data;
 *  - JOIN: the peer hosts and answers the enumeration; the guest lists the session, joins it and
 *    the peer sees the connection.
 *  Neither leg may fault the guest.
 *
 * Prereqs: `bun run dev` (the dev server carries the relay), `bun run dev:sidecar`,
 * `bun tools/harness.ts up`. WGB = the Civ3 Complete bundle (a local owned copy).
 * Run with one tab open. Screenshots land under logs/<BS_TAB>/debug/civ3-lan/.
 */
import { harness } from "../../harness";
import { dp8Host, dp8Join } from "../../dp8-peer";

const wgb = process.env.WGB ?? "/apps/external-wgb/civilization3-complete.wgb";
const bundle = wgb.startsWith("/apps/") || wgb.startsWith("http") ? wgb : `http://localhost:3001/wgb?path=${encodeURIComponent(wgb)}`;
const ROOM = `civ3-lan-${process.pid}`;
const RELAY = process.env.RELAY ?? "ws://localhost:5174";
const CIV3_APP = "f0886188-9cf8-c246-95f4-9834afc4b8c6";

// Guest coordinates, 1024x768.
const UI = {
    multiplayer: [286, 637], lan: [340, 245], gameTypeOk: [667, 327], nicknameOk: [492, 154],
    noOnlineOk: [647, 204], host: [113, 156], join: [115, 191], refresh: [115, 222], firstRow: [300, 138], close: [988, 739],
} as const;

const CONNECT_DATA = Buffer.from("Firaxis\0").toString("hex");
// A host's enum reply: the 272-byte session name field, then the lobby's seven status dwords.
const enumReply = (name: string): string => {
    const b = Buffer.alloc(272 + 28);
    b.write(name, 0, "latin1");
    [1, 8, 0xffffffff, 1, 0x16, 0x20, 0].forEach((v, i) => b.writeUInt32LE(v, 272 + i * 4));
    return b.toString("hex");
};

function fail(msg: string): never { throw new Error(msg); }
async function step(what: string, chain: ReturnType<typeof harness>): Promise<Record<string, any>> {
    const r = await chain.run();
    if (!r.ok) fail(`${what}: ${JSON.stringify(r.error)}`);
    return r.named as Record<string, any>;
}
const click = (c: readonly [number, number], settle = 3000) => harness().clickAt(c[0], c[1]).sleep(300).clickAt(c[0], c[1]).sleep(settle);
async function noFault(when: string): Promise<void> {
    const rep = (await step(`report ${when}`, harness().report())).report as { crash: unknown; faults?: unknown[] };
    if (rep.crash || rep.faults?.length) fail(`guest faulted ${when}: ${JSON.stringify(rep.crash ?? rep.faults)}`);
}
const relayOpts = { room: ROOM, relay: RELAY, app: CIV3_APP };

// ---- boot to the LAN game list --------------------------------------------------------------
// Clicks sent while the game is still loading are queued and replayed in order, so the peers below
// wait (poll) for the guest rather than assume how long its boot took.
await step("boot", harness().openWgb(bundle).sleep(60_000));
await step("join room", harness().lanJoin(ROOM).lanTrace({ enable: true, reset: true }));
let nav = harness();
for (const [c, settle] of [[UI.multiplayer, 3000], [UI.lan, 3000], [UI.gameTypeOk, 4000], [UI.nicknameOk, 4000], [UI.noOnlineOk, 4000]] as const) nav = nav.clickAt(c[0], c[1]).sleep(300).clickAt(c[0], c[1]).sleep(settle);
await step("to game list", nav.shot({ save: "civ3-lan/01-game-list.png" }));

// ---- HOST leg -----------------------------------------------------------------------------
await step("host", click(UI.host, 8000).shot({ save: "civ3-lan/02-hosting.png" }));
await noFault("after hosting");
const joined = await dp8Join({ ...relayOpts, ms: 300_000, linger: 4000, connectHex: CONNECT_DATA, sendHex: "00" });
if (!joined.ok) fail(`peer could not join the guest's game: ${joined.reason}`);
if (joined.session?.application !== CIV3_APP) fail(`guest hosted under application ${joined.session?.application}`);
if (joined.received.length === 0) fail("host sent the joined peer no session data");
await noFault("after a peer joined");
await step("host shot", harness().shot({ save: "civ3-lan/03-host-peer-joined.png" }));

// ---- JOIN leg -----------------------------------------------------------------------------
await step("leave", click(UI.close, 4000).clickAt(UI.close[0], UI.close[1]).sleep(3000));
const hosted = dp8Host("SynthGame", { ...relayOpts, ms: 300_000, linger: 4000, enumReplyHex: enumReply("SynthGame") });
await step("to game list again", harness().clickAt(...UI.lan).sleep(3000).clickAt(...UI.gameTypeOk).sleep(4000)
    .clickAt(...UI.nicknameOk).sleep(4000).clickAt(...UI.noOnlineOk).sleep(4000)
    .clickAt(...UI.refresh).sleep(5000).shot({ save: "civ3-lan/04-listed.png" }));
// The list is game-drawn: a row is selected by a quick double-click after the pointer has hovered it.
await step("select a session", harness().move(...UI.firstRow).sleep(400).clickAt(...UI.firstRow).sleep(60).clickAt(...UI.firstRow).sleep(2000));
await step("join", harness().move(...UI.join).sleep(400).clickAt(...UI.join).sleep(15_000).shot({ save: "civ3-lan/05-joined.png" }));
await noFault("after joining");
const peerSaw = await hosted;
if (peerSaw.players < 2) fail(`the guest did not connect to the synthetic host: ${peerSaw.reason}`);
console.log("civ3-lan: host and join legs passed");
