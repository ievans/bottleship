/**
 * Close Combat II two-player TCP/IP netplay over the virtual LAN (Winsock TCP, port 1945), both
 * directions against a synthetic peer on the same relay room (a second guest costs gigabytes):
 *
 *  - JOIN: the guest connects to a listening peer and sends its handshake (net name + version);
 *  - HOST: the guest listens, a peer connects to it and the guest greets with its version string.
 *  Neither leg may fault the guest. The game's own netplay protocol is not modelled, so this proves
 *  the Winsock + LAN path and the dialog plumbing, not a full game.
 *
 * Prereqs: `bun run dev` (the dev server carries the relay), `bun run dev:sidecar`,
 * `bun tools/harness.ts up`. WGB = the Close Combat II bundle (a local owned copy).
 * Run with one tab open.
 */
import { harness } from "../../harness";
import { connectTcp, listenTcp } from "../../lan-peer";

const wgb = process.env.WGB ?? "/apps/external-wgb/close-combat-2.wgb";
const bundle = wgb.startsWith("/apps/") || wgb.startsWith("http") ? wgb : `http://localhost:3001/wgb?path=${encodeURIComponent(wgb)}`;
const ROOM = `cc2-lan-${process.pid}`;
const RELAY = process.env.RELAY ?? "ws://localhost:5174";
const PORT = 1945;
const PEER_IP = "192.168.77.3";
const hex = (s: string) => Buffer.from(s, "latin1").toString("hex");

// Guest coordinates, 1024x768 desktop with the 800x600 game centred in it.
const UI = { players: [497, 538], connect: [499, 592], hostIp: [447, 383], netName: [711, 356], hostRadio: [258, 297] } as const;

function fail(msg: string): never { throw new Error(msg); }
async function step(what: string, chain: ReturnType<typeof harness>): Promise<Record<string, any>> {
    const r = await chain.run();
    if (!r.ok) fail(`${what}: ${JSON.stringify(r.error)}`);
    return r.named as Record<string, any>;
}
async function noFault(when: string): Promise<void> {
    const rep = (await step(`report ${when}`, harness().report())).report as { crash: unknown; faults?: unknown[] };
    if (rep.crash || rep.faults?.length) fail(`guest faulted ${when}: ${JSON.stringify(rep.crash ?? rep.faults)}`);
}
const typed = (c: readonly [number, number], text: string) => harness().clickAt(c[0], c[1]).sleep(500).type(text).sleep(800);
const openDialog = () => harness().clickAt(UI.connect[0], UI.connect[1]).sleep(4000);

await step("boot", harness().openWgb(bundle).sleep(45_000));
await step("join room", harness().lanJoin(ROOM).lanTrace({ enable: true, reset: true }));
// An initial help dialog is modal and swallows clicks until acknowledged.
await step("to the connect dialog", harness().click("Continue").sleep(2000)
    .clickAt(UI.players[0], UI.players[1]).sleep(2000).clickAt(UI.connect[0], UI.connect[1]).sleep(4000));

// ---- JOIN leg ---------------------------------------------------------------------------------
await step("fill in", typed(UI.netName, "Tester").clickAt(UI.hostIp[0], UI.hostIp[1]).sleep(500).type(PEER_IP).sleep(800));
const listening = listenTcp({ room: ROOM, relay: RELAY, port: PORT, ms: 25_000, log: () => {} });
await step("join", harness().click("OK").sleep(8000));
const seen = await listening;
if (!seen.events.some((e) => e.op === "accept")) fail("the guest never connected to the listening peer");
const sent = seen.events.filter((e) => e.op === "data").map((e) => e.hex).join("");
if (!sent.includes(hex("Tester"))) fail(`the guest's handshake did not carry the net name: ${sent}`);
if (!sent.includes(hex("2.2 Retail"))) fail(`the guest's handshake did not carry the game version: ${sent}`);
await noFault("after joining");

// ---- HOST leg ---------------------------------------------------------------------------------
// The peer going away makes the game report the lost connection in a message box that swallows
// clicks until it is answered; it appears some seconds after the peer leaves.
let box = false;
for (let i = 0; i < 10 && !box; i++) {
    const wins = (await step("windows", harness().sleep(2000).state(["windows"]))).state.windows as Array<{ cls: string }>;
    box = wins.some((w) => w.cls === "#32770");
}
if (!box) fail("the game did not report the lost connection when the peer left");
await step("dismiss", harness().click("OK").sleep(2500));
await step("reopen", openDialog().clickAt(UI.hostRadio[0], UI.hostRadio[1]).sleep(800).click("OK").sleep(5000));
const joined = await connectTcp({ ip: "192.168.77.2", port: PORT, room: ROOM, relay: RELAY, ms: 15_000, log: () => {} });
const greeting = joined.events.filter((e) => e.op === "data").map((e) => e.hex).join("");
if (!greeting.includes(hex("2.2 Retail"))) fail(`the hosting guest sent no version greeting (${joined.reason ?? "no data"}): ${greeting}`);
await noFault("after a peer joined");
console.log("cc2-lan: join and host legs passed");
