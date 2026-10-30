# Bringing up a game

How to take a game from an installer to playable, and to playable with friends over the
[virtual LAN](multiplayer.md). It's written for coding agents working one game at a time, often
several at once on one machine, and it works just as well by hand.

Each game has an issue with the `game` label, stating what done means for that title. Work from
that issue, and report on it.

## Where changes go

This repository is where the work lands. Every change goes through a pull request, and whoever
wrote it merges it once CI is green. Nothing is committed directly to `main`, and PRs stay within
this repository: anything for upstream is sent separately, later.

## Read first

- [`CLAUDE.md`](../CLAUDE.md): the engine's architecture and debugging rules. Follow it for all
  engine work.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [Contributing with an AI agent](contributing-with-ai.md):
  the bring-up loop and the bar for a PR.
- The `/bringup` skill (`.claude/skills/bringup/`): the harness checklist.
- [The automation harness](harness.md): `report()`, `stubs()`, `shot`, `BS_TAB`.
- [Multiplayer](multiplayer.md): the relay, `tools/lan-peer.ts`, and how Empire Earth's lobby was
  worked out. This is the template for the networking half.
- [Compatibility](compatibility.md), [Importing games](bundles.md), [GOG import](gog-import.md):
  how bundles are built and what has been tested.
- `tools/harness/regression/empire-earth-single-player.harness.ts` and
  `empire-earth-lan.harness.ts`: the shape your regression scripts should take.

## Set up a workspace

Each agent gets its own worktree, with its own dev stack, so that different code never runs behind
one dev server. Start from one clone of the repository, and pick a name and a slot number that no
running agent is using.

```sh
git fetch origin
git worktree add ../bottleship-<name> -b game/<game-id>/bringup origin/main
cd ../bottleship-<name>
git submodule update --init --recursive
bun install

# Slot 1 shown; add 10 to each port for slot 2, and so on.
export BS_TAB=<name>
export BS_VITE_PORT=5184 LAN_PORT=5185
export BS_SIDECAR_PORT=3011 VITE_SIDECAR_PORT=3011
export BS_CDP_PORT=9343 BS_CHROME_PROFILE="$PWD/tmp/chrome-profile"
export BS_WGB_ROOTS=<folder holding your bundles>

bun run dev:lan &    # the multiplayer relay
bun tools/harness.ts up
```

See [Separate worktrees](harness.md#separate-worktrees). The dev servers only serve bundles from the
repository and `BS_WGB_ROOTS`, so a bundle anywhere else fails to load with an HTTP 403.

Memory sets the limit on parallel work. A guest can take several GB, so 2-3 running at once is the
sane range on a desktop, and two Empire Earth guests don't fit in 8 GB.

- Run one guest per agent, and close its tab when you aren't using it.
- Play the second player with `tools/lan-peer.ts`, which costs a few MB, not a second real guest.
- Take timing measurements only with a single guest running.

Keep plans and notes in the ignored `plan/` folder, and evidence in the ignored `logs/` folder.

## Check what the harness tells you

A harness command can exit 0 after a step failed. Read the result for `"ok": false`, and confirm a
game really loaded with `report()` and `shot`, since a failed load leaves the CPU at its reset
address behind a "Couldn't load the game" dialog. A screenshot can also catch a black screen
between intro videos or during a load, so give a game time before calling it stuck. Empire Earth
takes a while to reach its menu because its intro is long.

## Phase 1: Quick check

Find out what the game needs before committing to it.

1. **Build a bundle.** Use your own lawfully obtained copy, and keep bundles outside the repository.
   - Start from [`gog-to-wgb`](gog-import.md) with `--extract-only --keep-gog --extract-dir <dir>`
     for a GOG installer, or from the installed folder for a disc.
   - Pack with `tools/make-wgb.ts`. Empire Earth's settings are a good start for a 2000s game:
     `--os winxp --ram 1536 --width 1024 --height 768 --bpp 32`, with the game's own audio and
     video DLLs in `--app-dir-dlls` (BottleShip's built-in versions don't cover every export).
   - Turn the `setRegistry` actions in the extracted `goggame-*.script` into a `.reg` file for
     `--reg-import`, with `{app}` as `C:`.
   - Add `--create-dirs` for folders the game expects, such as its saved games folder.
   - Keep each game's folder under its own name. An expansion's bundle carries the base game's
     folder too, as The Art of Conquest does.
2. **Drive it** with the harness to the main menu, then into a skirmish or first mission.
3. **Look at the network.** Join a room (`lanJoin`), turn tracing on, and open the multiplayer menu.
   `lanTrace` shows the Winsock calls, ports, and whether traffic is broadcast or unicast. `stubs()`
   names missing APIs. Check specifically for DirectPlay (`dplayx`), which the relay doesn't carry.
4. **Report on the issue:** what works, what breaks, a rough size for the missing work, and
   anything that needs a decision. Then continue, unless it's a blocker from
   [When to stop and ask](#when-to-stop-and-ask).

Skip step 3 for a game with no multiplayer.

## Phase 2: Single player

Fix what the quick check found, one focused PR at a time, until the game reaches gameplay and its
own save and load work. Add `tools/harness/regression/<game-id>-single-player.harness.ts`.

## Phase 3: Multiplayer

1. **Discovery and lobby.** Get hosting and joining working against a `tools/lan-peer.ts` peer, as
   in the Empire Earth section of [Multiplayer](multiplayer.md). Record the wire format you observe
   there.
2. **Launch.** Get a match started, and note how the game behaves with the relay's latency. The
   relay carries UDP over a WebSocket, so nothing is lost but anything can arrive late, which
   matters most to lockstep games.
3. **Add** `tools/harness/regression/<game-id>-lan.harness.ts`.
4. **Play a real match:** two people, on separate machines, over the Internet, through a deployed
   server. Create a room with the 🌐 button, share the invite link, and use the game's LAN menu.
   Record how it felt on the issue, especially lag. Restarting the server ends any room in
   progress, so check before deploying.

## Pull requests

- Name branches `game/<game-id>/<topic>`.
- Keep each PR to one change. A generic engine fix is its own PR, not part of a catalog change.
- **Keep UI changes and engine changes in separate PRs.** If a task needs both, split it, so that
  each can be reviewed on its own, here and upstream.
- Say what changed, cite the API contract, and include the harness script or verbs that prove it,
  with their output. Use `Refs #<issue>`, and `Closes #<issue>` only on the PR that finishes a game.
- Before merging, rebase on the latest `main`, run the
  [quality gate](../CONTRIBUTING.md#the-quality-gate-required-before-every-pr), and wait for CI,
  which runs the full `bun run gate`. In shared files such as `docs/compatibility.md`, keep both
  sides of a conflict. Then merge with `gh pr merge --squash --delete-branch`.
- Merge generic fixes promptly, since another game may need them.
- If you change shared networking code (`src/worker/net/`, or the Winsock and `iphlpapi` modules),
  run the Empire Earth LAN regression too, and say so in the PR.
- Leave other agents' branches alone.

Add the game to [Compatibility](compatibility.md), with the bundle settings that worked, and add
anything learned about networking to [Multiplayer](multiplayer.md).

## Working habits

- **Prove it with data.** A claim that something works or is fixed needs a harness result,
  screenshot, `report()` or log line behind it.
- **Fix the class, not the game.** Correct the Windows or DirectX behavior BottleShip gets wrong, so
  every game on that path benefits. See the Prime Directive in [`CLAUDE.md`](../CLAUDE.md).
- **Time-box rabbit holes.** After two hours on one bug with no new finding, write up the symptom,
  the evidence and what you tried on the issue, and ask whether to keep going.
- **Stay in scope.** Fix what your game needs, and file unrelated bugs as issues.
- **Use the existing tools.** Look for a harness verb or `tools/` script first, and add new
  diagnostics to the harness rather than writing a one-off probe.

## When to stop and ask

- The game needs DirectPlay, copy protection, or another large subsystem BottleShip doesn't have.
  Give a size estimate and options.
- You need a different copy or edition of the game, or files you don't have.
- A fix would only work by being game-specific.
- A step would delete data, force-push, or touch another agent's work.

## Reporting

Comment on the game's issue at the end of each phase, and when blocked: where the game is (boots,
menu, in game, lobby, match), the PRs merged, what's next, and anything you need. Finish with the
bundle settings, the harness scripts, and what the real match showed.
