/**
 * Empire Earth (Winsock "TCP Protocol" multiplayer) over the virtual LAN, both directions
 * against a synthetic peer on the same relay room (a second guest costs gigabytes; the peer
 * speaks the game's own wire format):
 *
 *  - HOST: the guest hosts a game; a peer joins over TCP 33336 with the client hello and the
 *    version message, and the guest answers the roster and the game settings;
 *  - JOIN: the peer announces a game on UDP 8585; the guest lists it, joins it, sends its hello
 *    and version message in response to the peer's roster, and reaches the game lobby.
 *  Neither leg may fault the guest.
 *
 * Prereqs: `bun run dev` (the dev server carries the relay), `bun run dev:sidecar`,
 * `bun tools/harness.ts up`. WGB = absolute path of the repacked Empire Earth bundle.
 * Run with one tab open: the boot is long and the lobby clicks are timing-tolerant, not fast.
 * Screenshots land under logs/<BS_TAB>/debug/empire-earth-lan/.
 */
import { harness } from "../../harness";
import { connectTcp, listenTcp } from "../../lan-peer";

const wgb = process.env.WGB;
if (!wgb) throw new Error("WGB must point to the repacked Empire Earth bundle (a local owned copy)");
const bundle = wgb.startsWith("/apps/") || wgb.startsWith("http") ? wgb : `http://localhost:3001/wgb?path=${encodeURIComponent(wgb)}`;
const ROOM = `ee-lan-${process.pid}`;
const RELAY = process.env.RELAY ?? "ws://localhost:5174";

// Guest coordinates, 1024x768.
const UI = {
    refresh: [934, 659], firstRow: [300, 169], join: [623, 671], host: [788, 671], hostName: [565, 312],
    create: [462, 485], dialogOk: [520, 445], dissolve: [660, 254], dissolveOk: [452, 436],
} as const;

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const str = (s: string) => Buffer.concat([u16(s.length), Buffer.from(s, "utf16le")]);
const frame = (...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([u16(body.length + 2), body]); };

const PEER_NAME = "Joiner12345";
const VERSION_MSG = "20000801feff0a00760032002e00300030002e0032003900370034009e8b990e";
const HELLO = frame(Buffer.from([1]), str(PEER_NAME), u16(0)).toString("hex");
// Announce + the game settings frames a host sends, in the order the client asks for them.
const ANNOUNCE = "013882498b00060042005300470061006d006500000001000800000000";
const SETTINGS = "55000802000002000100feff00000200feff000100010000000d010101f401030001010001030000050064030000050064000000050064000000050064000000050064000000050064000000050064000000050064"
    + "0a0008030200feff0001";

function fail(msg: string): never { throw new Error(msg); }
const inbound = (events: { op: string; hex: string }[]) => events.filter(e => e.op === "data").map(e => e.hex);

async function step(what: string, chain: ReturnType<typeof harness>): Promise<Record<string, any>> {
    const r = await chain.run();
    if (!r.ok) fail(`${what}: ${JSON.stringify(r.error)}`);
    return r.named as Record<string, any>;
}
const click = (c: readonly [number, number], settle = 1500) => harness().clickAt(c[0], c[1]).sleep(300).clickAt(c[0], c[1]).sleep(settle);
async function noFault(when: string): Promise<void> {
    const rep = (await step(`report ${when}`, harness().report())).report as { crash: unknown; faults?: unknown[] };
    if (rep.crash || rep.faults?.length) fail(`guest faulted ${when}: ${JSON.stringify(rep.crash ?? rep.faults)}`);
}

// ---- boot to the LAN tab -----------------------------------------------------------------
let boot = harness().openWgb(bundle).lanJoin(ROOM).lanTrace({ enable: true, reset: true }).sleep(40_000);
for (let i = 0; i < 30; i++) boot = boot.keyHold("Escape", 150).sleep(2850);
await step("boot", boot.moveRelative(6, 0).sleep(300).moveRelative(-6, 0).sleep(800).clickHere(250, 0).sleep(90_000).clickAt(621, 641).sleep(30_000).shot({ save: `empire-earth-lan/01-lan-tab.png` }));

// ---- HOST leg ----------------------------------------------------------------------------
await step("host", harness().clickAt(...UI.dialogOk).sleep(2000).clickAt(...UI.host).sleep(300).clickAt(...UI.host).sleep(6000)
    .clickAt(...UI.hostName).sleep(300).type("BSGame").sleep(800).clickAt(...UI.create).sleep(300).clickAt(...UI.create).sleep(10_000)
    .shot({ save: `empire-earth-lan/02-hosting.png` }));
await noFault("after hosting");

const joined = await connectTcp({ room: ROOM, relay: RELAY, ip: "192.168.77.2", port: 33336, payload: HELLO + VERSION_MSG, ms: 20_000, log: () => {} });
const hostReplies = inbound(joined.events).join("");
if (!hostReplies.startsWith("3f000200")) fail(`host did not answer the hello with a roster: ${hostReplies.slice(0, 80) || "(nothing)"}`);
if (!hostReplies.includes("550008020000")) fail("host did not send the game settings after the version message");
if (!hostReplies.includes("0a0008030200")) fail("host did not close the join with its trailer frame");
await noFault("after a peer joined");
await step("host shot", harness().shot({ save: `empire-earth-lan/03-host-peer-joined.png` }));

// ---- JOIN leg ----------------------------------------------------------------------------
await step("dissolve", harness().clickAt(...UI.dissolve).sleep(300).clickAt(...UI.dissolve).sleep(1500)
    .clickAt(...UI.dissolveOk).sleep(300).clickAt(...UI.dissolveOk).sleep(2500));
const roster = frame(Buffer.from([2]), u16(0), u16(1), u16(2), u16(2), u16(1), str("SynthHost"), u16(2), str("Unknown7198")).toString("hex");
const synth = listenTcp({ room: ROOM, relay: RELAY, port: 33336, ms: 90_000, replyHex: `${roster},${SETTINGS}`, announceHex: ANNOUNCE, log: () => {} });
await step("join", harness().clickAt(...UI.refresh).sleep(8000).clickAt(...UI.firstRow).sleep(1500)
    .clickAt(...UI.join).sleep(300).clickAt(...UI.join).sleep(15_000).shot({ save: `empire-earth-lan/04-joined.png` }));
const synthResult = await synth;
const fromGuest = inbound(synthResult.events);
if (!fromGuest.some(h => h.startsWith("1d00010b"))) fail("guest never sent its hello to the announced game");
if (!fromGuest.some(h => h.startsWith("20000801"))) fail("guest did not send the version message after the roster");
await noFault("after joining");
console.log("empire-earth-lan: host leg and join leg ok");
