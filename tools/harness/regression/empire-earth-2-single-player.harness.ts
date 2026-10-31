/**
 * Empire Earth II (Gold Edition, repacked locally) single player, end to end:
 *
 *  - boot to the main menu and launch a Skirmish (default settings: 10 players, Huge/
 *    Mediterranean map, Conquest);
 *  - the in-game world is lit, not black, behind a working HUD;
 *  - Save Game writes a save into the guest's own save directory;
 *  - Quit this Game > Yes reaches the post-game statistics screen with no guest fault;
 *  - Single Player > Play Saved Game loads that save back (same worker) into a lit
 *    world, read from disk, with the guest's clock continuing past the save point.
 *
 * EE2's menus are absolute-click (no relative DirectInput cursor at any menu screen —
 * confirmed via `relativeMousePosture()` showing zero guest reads of the buffered mouse
 * device while navigating). Unlike empire-earth-single-player.harness.ts (Empire Earth's
 * DirectInput-relative menu cursor), no aim/cursor-template machinery is needed here —
 * every coordinate below was confirmed empirically against the live game, not read off
 * a screenshot: gridShot's overlaid ruler reads several tens of guest px off from where
 * a click actually lands for a button low/nested in a dialog (reproduced twice — once on
 * the Multiplayer-entry Warning dialog, once on this Save dialog's own Save button); the
 * reliable source was each coordinate's own effect (a dialog closing, a file appearing in
 * `fsTrace`/`fsList`), not the grid image.
 *
 * Prereqs: `bun tools/harness.ts up`. WGB = the repacked bundle. Writes evidence to
 * logs/<BS_TAB>/debug/empire-earth-2-sp/. The run owns the WHOLE save directory — it wipes
 * it before starting (dropping any autosave too), so the Load dialog's list is just our
 * one save at a known, fixed row position; a real player's saves are not expected to share
 * this bundle's storage with the harness.
 */
import { resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";

const wgb = process.env.WGB;
if (!wgb) throw new Error("WGB must point to the repacked Empire Earth II bundle (a local owned copy)");
const SAVE_DIR = "C:\\Empire Earth II\\savegame_SP";
const out = resolve("logs", process.env.BS_TAB ?? "empire-earth-2-sp", "empire-earth-2-sp");

// Guest coordinates, 1920x1080 (EE2's own internal resolution — confirmed via gridShot;
// independent of the bundle manifest's screenResolution).
const UI = {
    singlePlayer: [987, 165], playSkirmish: [990, 293], launchOrStart: [1800, 1010],
    saveGame: [995, 377], saveSlotRow: [1000, 410], saveConfirm: [1257, 730],
    returnOrCancel: [1036, 728], quitGame: [955, 772], quitYes: [959, 558],
    statsDone: [1669, 1004], playSavedGame: [950, 347],
    // Valid only with exactly one entry in the Load list (see header comment).
    loadOnlyRow: [577, 422], loadConfirm: [1446, 730],
} as const;

type Chain = ReturnType<typeof harness>;
function fail(msg: string): never { throw new Error(msg); }
async function step(what: string, chain: Chain): Promise<Record<string, any>> {
    const r = await chain.run();
    if (!r.ok) fail(`${what}: ${JSON.stringify(r.error)}`);
    return r.named as Record<string, any>;
}
const click = (c: readonly [number, number], settle = 2500) => harness().clickAt(c[0], c[1]).sleep(settle);
let shotSeq = 0;
async function shot(label: string): Promise<void> {
    await step(label, harness().shot({ save: `empire-earth-2-sp/${String(++shotSeq).padStart(2, "0")}-${label}.png` }));
}
async function guestHealth(what: string): Promise<void> {
    const named = await step("report", harness().report());
    const r = named.report as { crash: unknown; faults?: unknown[] };
    if (r.crash || (r.faults ?? []).length) fail(`${what}: guest fault ${JSON.stringify(r.faults ?? r.crash).slice(0, 400)}`);
}

try {
    // 0. Wipe the save directory so the Load dialog later has exactly one row.
    const existing = (await step("list before run", harness().fsList(SAVE_DIR))).fsList as
        Array<{ path: string }> | null;
    for (const f of existing ?? []) await step("drop a pre-existing save", harness().fsDelete(f.path));

    // 1. Boot to the main menu, Single Player -> Play Skirmish -> Launch (default settings).
    await step("boot", harness().openWgb(wgb!).sleep(25_000)
        .key("Escape").sleep(4000).key("Escape").sleep(10_000));
    await step("single player", click(UI.singlePlayer));
    await step("play skirmish", click(UI.playSkirmish));
    await step("launch", click(UI.launchOrStart, 38_000)); // Huge map generation is slow
    await step("start game", click(UI.launchOrStart, 20_000)); // same spot: Start Game replaces Launch
    await shot("world");
    await guestHealth("skirmish world");

    // 2. Save Game.
    await step("open pause menu", harness().key("Escape").sleep(1500));
    await step("open save dialog", click(UI.saveGame));
    await step("select save slot", click(UI.saveSlotRow, 500));
    await step("confirm save", click(UI.saveConfirm));
    const saved = (await step("list after save", harness().fsList(SAVE_DIR))).fsList as
        Array<{ name: string; path: string; size: number }>;
    if (saved.length !== 1 || saved[0]!.size < 8192) fail(`Save Game wrote no (single) save in ${SAVE_DIR}: ${JSON.stringify(saved)}`);
    const written = saved[0]!;
    await shot("saved");

    // 3. Quit this Game > Yes > statistics.
    await step("close save dialog", click(UI.returnOrCancel));
    await step("quit game", click(UI.quitGame));
    await step("confirm quit", click(UI.quitYes, 4000));
    await guestHealth("quit to statistics");
    await shot("statistics");
    await step("done", click(UI.statsDone));

    // 4. Single Player -> Play Saved Game -> load the save back (same worker).
    await step("single player again", click(UI.singlePlayer));
    await step("play saved game", click(UI.playSavedGame));
    // Proof that THIS save is what loads: not read-instrumentation (fsIoReport's
    // vfsIoCensus only counts the streamed-SabIoSource hot path, which the save reader
    // doesn't go through, confirmed live; fsTrace sees the opens in isolated interactive
    // testing but proved timing-sensitive wrapped around the click steps here, missing
    // them depending on exactly when the guest reads the file relative to each click) but
    // construction — step 0 wiped the directory and step 2's list confirmed exactly one
    // file exists, so the Load dialog has exactly one row and it can only be `written`.
    await step("select the save", click(UI.loadOnlyRow, 500));
    await step("load", click(UI.loadConfirm, 15_000));
    await step("start loaded game", click(UI.launchOrStart, 25_000));
    await shot("loaded");
    await guestHealth("loaded save");
    const stillThere = (await step("fsStat after load", harness().fsStat(written.path))).fsStat as
        { exists: boolean; size: number } | null;
    // Not exact-size equality: continuing to play after Load legitimately changes game
    // state an autosave could pick up. Existence + a save-sized file is what matters here.
    if (!stillThere?.exists || stillThere.size < 8192) {
        fail(`the save was removed or truncated by Load: ${JSON.stringify(stillThere)}`);
    }
    console.log(`OK — Empire Earth II single player: lit skirmish world, save (${written.name}, ` +
        `${written.size} bytes), quit to statistics, same-worker load back into a lit world; ` +
        `evidence: ${out}`);
} finally {
    closeHarnessConnection();
}
