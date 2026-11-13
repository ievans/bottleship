# Changelog

## [0.8.3](https://github.com/ievans/bottleship/compare/v0.8.2...v0.8.3) (2026-11-11)


### Bug Fixes

* **ui:** default the LAN server field to the page origin ([#100](https://github.com/ievans/bottleship/issues/100)) ([8d1c68b](https://github.com/ievans/bottleship/commit/8d1c68bbc18c359befc983b3b34dd3fb27687f48))

## [0.8.2](https://github.com/ievans/bottleship/compare/v0.8.1...v0.8.2) (2026-11-10)


### Bug Fixes

* **net:** draw default LAN addresses from one /16 ([#98](https://github.com/ievans/bottleship/issues/98)) ([3bec200](https://github.com/ievans/bottleship/commit/3bec2006688630119cb2f3f95a7baa840b3ce1b5))

## [0.8.1](https://github.com/ievans/bottleship/compare/v0.8.0...v0.8.1) (2026-11-10)


### Bug Fixes

* **dev:** make the harness honor BS_DEV_PORT and stop only its own Vite ([#95](https://github.com/ievans/bottleship/issues/95)) ([d18be9b](https://github.com/ievans/bottleship/commit/d18be9b04ad5f8acec8b9b40d9f1256d6d70aae6))

## [0.8.0](https://github.com/ievans/bottleship/compare/v0.7.0...v0.8.0) (2026-11-08)


### Features

* add MSVCP110 (VC++2012 C++ stdlib) HLE module ([#42](https://github.com/ievans/bottleship/issues/42)) ([7dffcae](https://github.com/ievans/bottleship/commit/7dffcaeb8135b5f9b00c85b95cfb9511747eb44b))
* add MSVCR110 (VC++2012 CRT) HLE module ([#41](https://github.com/ievans/bottleship/issues/41)) ([45ebd87](https://github.com/ievans/bottleship/commit/45ebd878b630c37a7b02d807df020633bb9360e3))
* add steam_api.dll HLE module ([#43](https://github.com/ievans/bottleship/issues/43)) ([4630496](https://github.com/ievans/bottleship/commit/46304969c9211acabff9de76774df3d516d715e0))
* add twitchsdk_32_release.dll stub module ([#44](https://github.com/ievans/bottleship/issues/44)) ([9658f32](https://github.com/ievans/bottleship/commit/9658f3219a1ab3407ba0336bdd5e1fb6c9a810fd))
* **com:** follow HKCR\CLSID\{x}\TreatAs in in-process CoCreateInstance ([#59](https://github.com/ievans/bottleship/issues/59)) ([d8a33c2](https://github.com/ievans/bottleship/commit/d8a33c234ede0631797a80e684d9a20e563ff353)), closes [#10](https://github.com/ievans/bottleship/issues/10)
* **d3d11:** a WebGPU Direct3D 11 device with an SM4-to-WGSL translator ([#66](https://github.com/ievans/bottleship/issues/66)) ([56773dd](https://github.com/ievans/bottleship/commit/56773dd464db2fc4b073ef75acddcfcf583d9423))
* **dmusic:** wave segments, mixed on their audio path's buffer ([#72](https://github.com/ievans/bottleship/issues/72)) ([75f2573](https://github.com/ievans/bottleship/commit/75f25739feefd471b62e46b46e175a7163584a8d))
* **msvcrt, advapi32:** the wide and secure CRT calls d3dcompiler_46 and d3dgl import ([#62](https://github.com/ievans/bottleship/issues/62)) ([d2bd436](https://github.com/ievans/bottleship/commit/d2bd4368820fc6b857f7dcad8d1cb6a030d883b0))
* **msvcrt:** fgetws ([#69](https://github.com/ievans/bottleship/issues/69)) ([13f14d2](https://github.com/ievans/bottleship/commit/13f14d25a1c39c8896863820c657954ee0e1bf6f))
* **steam_api:** SDK 1.30 interface objects and call results for an offline user ([#65](https://github.com/ievans/bottleship/issues/65)) ([91f237d](https://github.com/ievans/bottleship/commit/91f237d186c920d70f9e0b171a20c3c252a6ed74))
* **urlmon:** file URL monikers, bind contexts and BindToStorage ([#58](https://github.com/ievans/bottleship/issues/58)) ([c1f7e7c](https://github.com/ievans/bottleship/commit/c1f7e7c1a47dab31fb9a07b1d2610eb6ea91bba4)), closes [#10](https://github.com/ievans/bottleship/issues/10)


### Bug Fixes

* bound WGB cache growth and restore D3D9 depth clears ([3e11673](https://github.com/ievans/bottleship/commit/3e11673616d312e664942831c05fa70f7d83799e))
* **d3d11:** NaN and infinite shader constants compile; an invalid pipeline no longer blacks out the frame ([#74](https://github.com/ievans/bottleship/issues/74)) ([23248a0](https://github.com/ievans/bottleship/commit/23248a0994a5f8b3a593abd6a5102ac4ae54852e))
* **dmusic:** InitAudio returns its DirectSound; audio paths have a buffer and a tool graph ([#71](https://github.com/ievans/bottleship/issues/71)) ([10df4d8](https://github.com/ievans/bottleship/commit/10df4d80055def674c3fcbd0f9011c57cd0693c8))
* **dmusic:** StopEx on an audio path stops only that path; audio paths honor SetVolume ([#75](https://github.com/ievans/bottleship/issues/75)) ([2266fbb](https://github.com/ievans/bottleship/commit/2266fbb8e01e5d7147a67934a82cdabeae642888))
* **gdi32:** declare GetGlyphOutlineA/W and GetKerningPairsA/W ([#63](https://github.com/ievans/bottleship/issues/63)) ([d45ee64](https://github.com/ievans/bottleship/commit/d45ee644125dbf1a16ca4d77bf9aef1bff1225b8))
* **kernel32:** a zero-byte HeapAlloc returns a block, not NULL ([#61](https://github.com/ievans/bottleship/issues/61)) ([551652b](https://github.com/ievans/bottleship/commit/551652b98b8cb1eee3f3c1164634b79a338adf92))
* **mss32:** decode MS ADPCM with msacm32's block decoder ([#73](https://github.com/ievans/bottleship/issues/73)) ([45e9837](https://github.com/ievans/bottleship/commit/45e9837172ee6b2e79a3a58b16ce4d1e21780567))
* **msvcp110:** a real classic locale for code that inlines use_facet ([#67](https://github.com/ievans/bottleship/issues/67)) ([6049877](https://github.com/ievans/bottleship/commit/604987748364aa7a06072f88b16f5fe6cc7d32db))
* **msvcp110:** basic_ostream ctor pops its hidden vbase flag; declare _Fiopen ([#56](https://github.com/ievans/bottleship/issues/56)) ([546641b](https://github.com/ievans/bottleship/commit/546641b6558334d1dc5db05128ac850f68d24fb8))
* **oledlg, avicap32:** declare the imports that kept unicows.dll from loading ([#57](https://github.com/ievans/bottleship/issues/57)) ([0b3c171](https://github.com/ievans/bottleship/commit/0b3c171bf44980f9c24a95d5fdd5e72496644f00))
* **runtime:** restore resource loading and x87 precision for Empires ([7b25393](https://github.com/ievans/bottleship/commit/7b25393ee4e8653da2c94eb3e030b5f0d9084059))
* **steam_api:** ISteamMatchmaking vtable covers slot 20, fixing an OOB read ([#53](https://github.com/ievans/bottleship/issues/53)) ([0399d4d](https://github.com/ievans/bottleship/commit/0399d4de173581f08a6fa77f0d53d890680c7b7c))
* **steam_api:** SteamMatchmaking() returns a real object instead of NULL ([#52](https://github.com/ievans/bottleship/issues/52)) ([b2d6953](https://github.com/ievans/bottleship/commit/b2d69539fe0ab1e3c1225b9f5fdc57136d34d05f))
* **user32:** windows created by class name keep their class; FindWindow ignores case ([#70](https://github.com/ievans/bottleship/issues/70)) ([8da92bc](https://github.com/ievans/bottleship/commit/8da92bcf2080590ca2884b45519ff4dffd3fe33c))
* **vfs:** drop trailing dots and spaces from path components ([#68](https://github.com/ievans/bottleship/issues/68)) ([21e184f](https://github.com/ievans/bottleship/commit/21e184f5f866b02ef8fa0f4907321d141e087b80))
* **vfs:** SetEndOfFile keeps writes still buffered below the new end ([#64](https://github.com/ievans/bottleship/issues/64)) ([8eca9be](https://github.com/ievans/bottleship/commit/8eca9be0b0a40b2fb037ce1d3aa3880d050455cb))

## 0.8 — 2026-11-12

This release covers changes merged since 0.7 on October 8, 2026. The compatibility list
grows from 53 to 85 entries, including Half-Life 2, Red Alert 3, Deus Ex, Unreal Tournament
GOTY, Empire Earth and GTA 1/2. LAN multiplayer arrives for Winsock and DirectPlay 1–4/8
games through a self-hosted relay. The savestate foundation covers every major module,
behind a developer flag. Other additions are a General MIDI synthesizer and performance
work on Direct3D 9 and GDI. The public demo catalog now contains 48 entries.

Read the [0.8 release notes](docs/releases/0.8.md) for the newly compatible games,
multiplayer coverage and limitations, contributors and what comes next. The dated entries
below summarize the changes by theme.

### Newly compatible games

- Maintainer-confirmed: Half-Life 2 (20th Anniversary), Command & Conquer: Red Alert 3,
  Deus Ex: GOTY, Sid Meier's Pirates! (2004), The Longest Journey, Empires: Dawn of the
  Modern World (GOG; boots, random map reaches gameplay), Neighbours from Hell (Russian
  Buka disc), Heroes of Might and Magic II Gold (GOG), Grand Theft Auto (1997) and Grand
  Theft Auto 2 (Rockstar Classics freeware), Unreal Tournament GOTY (v432).
- Contributor bring-ups: Empire Earth 2.00 and The Art of Conquest 1.00 (single player),
  Star Wars Episode I: Battle for Naboo, Shrek 2, Colin McRae Rally 2.0, RollerCoaster
  Tycoon Deluxe, Safari Biathlon, Command & Conquer and Red Alert (Win95 editions), Heart
  of Empty, Bigfoot 4x4 Challenge, Stabilo Boss Mania, Amore, Beavis and Butt-Head in
  Hock-A-Loogie, and the freeware T-32K, I'm OK, Zep's Dreamland and Echoes.
- Booting, not yet playable end to end: Diner Dash, Gravity Bone. The full Midtown
  Madness 2 runtime is imported; its gameplay is unverified.

See [compatibility](docs/compatibility.md) for the observed stage of each title.

### Multiplayer

- Virtual LAN over the `bottleship-lan` relay (`packages/lan-rust`): **Settings → Network**,
  room names and invite links. Each player gets a stable virtual IPv4/IPX address. Default
  addresses share one /16.
- Winsock (`wsock32`, `ws2_32`): TCP and UDP over IPv4/IPv6, broadcast, IPv4 multicast and
  IPX datagrams.
- DirectPlay 1–4 (`dplayx`) and DirectPlay 8 (`dpnet`) between BottleShip players:
  enumeration, host/join, players, groups, chat, messages and lobbies. An optional server
  gateway connects to real Windows DirectPlay 8 games.
- Played or checked: Heroes III, Worms Armageddon, Quake II, Serious Sam, Re-Volt,
  Cossacks, GTA 1 (two-tab DirectPlay match), GTA 2 (Manager with lobby chat), Unreal
  Tournament GOTY (listen server and client) and Empire Earth's LAN lobby.
- Not yet: a public relay server (run your own; see [multiplayer](docs/multiplayer.md)),
  online services and master servers, joining real Windows DirectPlay 4 games, secure
  sessions, NAT traversal, SPX, and reconnecting in place.
- Multiplayer is new and lightly tested so far; LAN testing and reports are welcome.
- The next minor release completes multiplayer with a deployed demo server.

## 2026-11-09 – 2026-11-12

- Savestates: participants for msvcrt, ole32 (including module loads that COM holds),
  oleaut32, dbghelp, comctl32, comdlg32, version, smackw32, binkw32, mss32, msacm32,
  DirectMusic (objects saved as their source, playback continues after a load), winmm
  (open waveOut devices, PlaySound), Winsock and DirectPlay (idle state). DDE
  conversations, open FindFirstFile handles and DLLs loaded at run time are now saved.
  Keys and mouse buttons held at capture are released after a load. Anything that cannot
  be saved refuses the save by name. The bundle content hash ignores compressed sizes.
- Direct3D 9: SetStreamSource, SetIndices and SetStreamSourceFreq ride the write ring.
  Large buffers are enqueued without a copy, and guest vertex/index storage is 16-byte
  aligned. Getters and MultiplyTransform have fast paths. Fixed MultiplyTransform order and
  pre-transformed draws in sub-viewports. D3DX9 CommitChanges sends only written
  parameters. Fixed effect pools, member writes and volume DDS uploads.
- Half-Life 2's 3D menu frame time drops from about 128 to 88 ms. The changes are shared
  HLE boundary and GPU-process work. JIT-compiled stores into their own code page now exit
  and replay in the interpreter.
- GDI: a DIB section blitted to a window is converted once. TextOut and DrawText draw over
  a DIB section's current bits. Fixed baseline alignment, text metrics, counted strings,
  SetPixel and CreateDIBitmap.
- USER32 and input: GetInputState, IsCharAlpha and its relatives, and typed characters
  from the host keyboard layout. Right-hand modifier keys are separate keys. A pointer the
  guest keeps warping back is hidden. The app deactivates when its last active window
  goes away (Neverwinter Nights, #234). Subclassed combobox drop-downs paint at once.
- Audio: band-limited resampling for low-rate sources (NFS Porsche menu music). Fixed
  DirectSound refills across the play cursor, device release, SetFrequency original rate,
  stopped-buffer status and LOCSOFTWARE, plus the cursor step cap (HP1). OpenAL ALC 1.1
  queries. A guest pause silences audio.
- kernel32: fibers with guarded pooled stacks, GetPrivateProfileSection with BOM
  profiles, VirtualAlloc over a live heap block, GetShortPathNameW, external manifests and
  DLL_PROCESS_DETACH. Version-like DLL names (`lua5.1`) load correctly. `_close` reports
  failures as the CRT does.
- DirectDraw/D3D7: depth-only Clear and late readbacks no longer overwrite newer pixels.
  Clear with a NULL rect array clears the viewport. 8-bit modes are offered at every
  16-bit size. Blt and pixel-format validation are cheaper. OpenGL: a first-time current
  context takes its drawable's viewport.
- VFS path classification and normalization are memoized. `_finite`/`_isnan` bind to
  native micro-thunks. The libgcc SjLj frame registration uses the TEB TLS slot directly.
- Tools: `bench-v86` function-tier ceiling probes, and a recorded negative result for AOT
  stack-load forwarding. The harness reads DirectDraw textures by guest handle.

## 2026-11-04 – 2026-11-08

- Savestates (issue #66): a session-state registry with a census, timer and wait
  completions as data, and named readiness blockers. Also a RAM chunk store and container
  format, core and kernel32 participants with field policies, and loading into a fresh
  worker at entry. Slots and save/load verbs sit behind a developer flag. Participants
  for user32/gdi32, ddraw, winmm, dsound, dinput and DirectMusic follow. A restore must
  load the same modules.
- Multiplayer fixes for GTA 1/2: USER timers in modal dialogs, DirectPlay name
  termination, lobby chat, empty class names and combobox heights. Also a `dplayState`
  harness verb. Winsock's default blocking hook reuses the session's USER32 exports.
  Multiplayer citations were rebased on public protocol specifications.
- Bring-ups: GTA 1 and GTA 2, Unreal Tournament GOTY, Heroes II Gold (WinG over GDI, CD
  audio TOC), RollerCoaster Tycoon Deluxe, and contributor freeware and late-90s titles.
- Fixes: Deus Ex first run (modal dialog pump on its own thread), Alice Greenfingers
  (inherited handles), Blade of Darkness (fixed-address VirtualAlloc), Racer cutscene
  audio, Max Payne intro (MPEG program streams, video plane above GDI), Quake II sound
  latency, HP Chamber of Secrets startup race and voice-over, Half-Life Day One New Game
  (DDSD_PITCH), The Longest Journey (TransformVertices, `fscanf`), Empires (one CRT per
  process, `_ismbcalpha`, `_mbs*` fast paths) and Cossacks GOG Video Player.
- MIDI: SoundFont 2/3 banks as DLS collections, a General MIDI synth behind `midiOut`, the
  MCI sequencer, and the default DirectMusic GM collection from that bank. DirectMusic
  loads Standard MIDI Files and WAVE files as segments.
- USER32: window state and message fixes, DDE connections, accelerators, CreateIcon and
  cursors from resources, WM_SIZE/WM_MOVE on first show and WM_ENABLE. Posted messages are
  delivered before hardware input.
- kernel32: WinExec over CreateProcess. CreateProcess resolves bare command lines, keeps
  their spacing, carries STARTUPINFO and reports start errors. Atom tables are
  reference-counted and indexed, and directory enumeration reports `.` and `..`. New fast
  paths for GetCurrentThread, TlsSetValue and NtQueryInformationThread. Ordinal imports
  resolve through the shipped DLL or get a trap stub.
- DirectDraw: an Unlock merges into pending dirty regions, implicit primary presents latch
  to the display refresh, and `dwBackBufferCount` is honored only with its flag. D3D9:
  stencil needs STENCILENABLE, released textures live until submit, lockable back buffers
  work, and the Firefox canvas is reconfigured. Display modes match on D3D8/9. GDI:
  GetDIBits reads DIB sections of every depth. OpenGL: fog by eye-space distance.
- Audio: Miles raw PCM sound images and AIL timers on the pump thread. DirectSound
  primary buffers per device, Restore and GetCurrentPosition, and winmm timer periods and
  waveOutReset. Pause intent survives automatic resumes.
- Bundles and import: block-indexed DEFLATE WGB members that keep range streaming.
  `make-wgb --copy` and `--sdb` VirtualRegistry shims. ZIP SFX and InstallShield 5 volumes,
  Unreal `.uz`, `iso-to-wgb --raw` and `unshield-extract --install-layout`. Local disk
  bundles use a metadata ETag, and dev disk bundles stream without an OPFS copy.
- Mobile: iOS/iPadOS 27 defaults to the JIT without tail calls (#46). Guest RAM is zeroed
  lazily and GPU rings start small. Movement keys are choosable, with per-orientation
  phone layouts. The harness gains a remote bridge for iPhone Safari and a footprint verb.
- The internal-resolution label shows the scale the backend renders at. A smoke
  checklist was added for manual regression passes.

## 2026-10-09 – 2026-11-02

- Multiplayer: a virtual LAN stack with a bounded Rust relay, Winsock TCP/UDP, multicast
  and IPX, and DirectPlay 4 and 8 sessions and lobbies. A native conformance suite
  (`tools/lan-conformance`) and user and development guides are included.
- Added Star Wars Episode I: Battle for Naboo, the Midtown Madness 2 trial, the Crimson
  Skies trial and The Lord of the Rings: The Return of the King demo to the public catalog.
  Empire Earth and The Art of Conquest work in single player, and Shrek 2, Safari Biathlon,
  Diner Dash and Neighbours from Hell were brought up. Half-Life 2, Red Alert 3, Deus Ex,
  Pirates! and The Longest Journey were confirmed working.
- DirectMusic segments, styles, bands and DLS collections render into DirectSound. MCIWnd
  plays video in its window. D3D3/7 strided draws, IDirect3DDevice3::SetLightState,
  DirectShow multimedia streaming and GDI write-back into 16/24-bit DIB sections were
  added. Fonts install into the Windows Fonts folder at boot.
- D3D8: fixed-function vertex lighting with pixel shaders, CPU-written back buffers and
  viewport/fog for pixel-shader draws. D3D7 state blocks record instead of applying zeros.
  App-directory DLLs take precedence over HLE aliases.
- Empires: resource loading and x87 precision fixes. Miles stream drain, resampling and
  seek/loop blocks were fixed. Padded MPEG audio is recognized.
- Import: Inno 5.1–5.2, InstallShield file-group destinations, Unicode RAR4 names and
  RAR29 solid history, LZX cabinets, loose MSI media and nested ISO images. Installer file
  times are kept with `make-wgb --file-times`.
- The setup wizard adds *Language for non-Unicode programs*. New imports default to
  1024 × 768, 32-bit color and 128 MB. The support menu is replaced by a GitHub contribution
  button.

## 0.7 — 2026-10-08

This release covers changes merged into `main` since October 5, 2026. Compatibility
grows from 15 to 53 games, with an optimized Direct3D 9 renderer, easier GOG imports,
mobile controls, loading and frame-rate improvements, and experimental AOT code caching.
The public demo catalog now contains 42 entries.

Read the [0.7 release notes](docs/releases/0.7.md) for highlights, AOT usage and the next
version's goals. The dated entries below retain the detailed change history.

## 2026-10-08

- Seeded the original Alice demo with native 1280 × 1024, 32-bit color and textures, maximum texture detail, detail textures and trilinear filtering.
- Added the original Blade of Darkness demo with native Direct3D and audio settings. Sargon's prison level, movement, turning and mouse attack are verified.
- Fixed fixed-function texture sampling when alpha uses a texture independently of vertex color, including selected operands and implicit texture-alpha blends. Declared the Video for Windows MCI window creation ABI and separated query-addressed bundles in trailing-slash cache routes.
- Published the original Mafia, Painkiller Demo 2, Carmageddon II and Worms World Party demos with original cover artwork. Mafia includes its native Setup registry settings for 1024 × 768, 32-bit fullscreen startup; no first-run Setup is required.
- Demo compatibility records distinguish Mafia's rendered mission from the menu or splash stages verified for the other three editions.

## 2026-10-07

- Added the original Thief Gold demo with the installer's native resource-path configuration. Thieves' Guild loads, with keyboard movement and mouse look verified.
- The demo catalog opens with a curated selection followed by genre groups. The sort menu now orders games by title, genre or year and restores the featured selection.
- Harness screenshots can save the composited screen mirror directly; `BS_URL_MATCH` selects a library page for UI checks through the same CDP connection.
- Added the original Cossacks: European Wars demo to the public catalog. Primary DirectDraw scanout observes directly mapped indexed pixels and palette changes; queued presentation re-derives guest memory after yields. The bundle uses native Slow mode with a 50 ms simulation interval.
- Added self-hosted Wise, VISE, InstallShield 3 and non-solid RAR4 LZ/PPMd payload readers with checksum validation, shared browser import and extraction CLI support. Unsupported script/compression variants fail explicitly.

- Added self-hosted MSI payload extraction and a CLI, including compound-file streams, installed directory/file tables, embedded or adjacent cabinets, and installed-file size/MD5 validation. Appended Microsoft Cabinet self-extractors can also be opened directly; installer custom actions are not executed.
- D3D9 frame capture now records the separate render worker's draws without blocking future frame messages; remote Present closes the recording at the frame boundary. Overlapping requests and capture timeouts are handled explicitly.

- Added the original English Need for Speed: Underground 2 PC demo with original PC box artwork. Free Roam driving, keyboard controls and the City Hall Circuit race are verified, including a production HTTP launch. Cold startup/level loading can take several minutes.

- Guest threads that suspend themselves now park when every peer is blocked and stay parked until resumed. Regression tests execute the caller on v86 with interpreter and production JIT settings.
- Added the original English Gothic 1.08h demo with original cover artwork and required save directories. Dialogue exit, HUD, movement and native saving are verified; restoring a saved game can still stall.

- Legacy Direct3D now reports four simultaneous texture samplers, matching the renderer, while retaining eight arithmetic blend stages. Manifest overrides cannot exceed this limit. This fixes invisible dialogue text and HUD in the Gothic USA demo.

- Added the original English The Bard's Tale (2005) and Deponia 1.1 demos with original cover artwork. Bard's tutorial, summoning and Mountain Tomb movement are verified; Deponia's tutorial, first room and native saving/loading across reload are verified.
- OpenGL texture readback now preserves uploaded image contents and applies pixel packing, fixing corrupted texture atlases and cursors in Deponia.
- Cursor warps immediately update the WASM GetCursorPos cache, preventing stale coordinates within the same guest tick.
- Added Unicode CRT file opening and long-path queries; CRT and WinAPI now share the process working directory, and drive-relative full paths resolve against it. Release CRT modules no longer expose debug-only exports through a warmed GetProcAddress cache.
- Added the original English Blackwell Legacy and KKND2: Krossfire demos with real cover artwork. Both retain native saves across page reload; KKND2 mission control and Blackwell’s apartment introduction are verified.
- Added a self-hosted NSIS 2 ANSI/non-solid zlib payload reader and extraction CLI. It verifies installer CRC, reconstructs static installation paths and rejects unsupported conditional/dynamic file sections. Installer plugins and custom actions are not executed.
- InstallShield extraction supports explicit recovery of plaintext data incorrectly marked as obfuscated; size and MD5 verification remain enabled. This unblocks packaging the original KKND2 demo without modifying its executable.

## 2026-10-06

- Borland CRT directory enumeration now uses its native Win32 implementation, so games can find and load save files written through the VFS-backed stdio layer.
- USER32 timers now continue while the only guest thread is blocked in GetMessage, preventing native installer message loops from stalling with a frozen virtual clock.
- Added the original English Harry Potter and the Chamber of Secrets demo and Tomb Raider II Great Wall demo, with real cover artwork and verified level movement.
- The Tomb Raider II demo includes its native 640 × 480, 16-bit video settings for a fresh-container launch. The unconfigured setup dialog remains a known failure.
- CRT process termination now uses the same child hand-off and durability barrier as ExitProcess, preserving a game launched by an exiting front-end and terminating all parent threads.
- Added Racer with real cover artwork; the Boonta Training Course race is playable.
- Added the English Discworld Noir interactive demo with original PC box artwork, native installation settings, and verified saving/loading across reload. Automatic attract-mode playback is disabled in the demo's menu resource, avoiding stripped-scene `bogus.scn` errors and a blank menu on return; its executable is unchanged. The WGB downloads into OPFS before launch for reliable CRT file reads.

## 2026-10-05

### Library and importing

- Added Red Faction Worldwide Demo and both Half-Life demos (Uplink and Day One) to the public catalog with original covers.
- Both Half-Life demos include a tested 1024 × 768, 16-bit video configuration: Direct3D for Uplink and OpenGL for Day One.
- Added the Far Cry Research demo to the public catalog with the original PC cover.

- Added Warcraft III Demo, Quake II, American McGee's Alice, XIII, Hitman: Codename 47,
  Serious Sam: The First Encounter, Worms Armageddon and System Shock 2 demos to the catalog.
- Demo pages with a GOG edition now explain how to launch an owned
  GOG copy and offer an offline-installer picker, including EXE + BIN selection.
- Large GOG imports extract and build WGBs in browser storage, with progress and multipart
  validation. WGB export streams from disk; Storage can clear abandoned import/download files
  while keeping cached games and saves.
- The WGB wizard supports inspecting and configuring packages, saving them to the library,
  downloading them, and launching the configured cached bundle.
- Chrome users can select an installed game folder or a GOG installer folder. Files are
  read in chunks by the worker; matching BIN parts are selected automatically.
- Added embedded InstallShield 5 cabinet headers and early descriptors without MD5.
  Loose media files are resolved by path, size and stored checksum, avoiding collisions
  between equally named language files. Truncated cabinet reads fail explicitly.

### Games, graphics and sound

- WGB manifests can select a complete virtual graphics-adapter identity. DirectDraw 4/7
  and Direct3D 8/9 report the same vendor, device, driver and version.
- The Far Cry Research demo includes stored PAK entries and its compiled shader cache,
  reducing the measured cold level load from about 196 to 93 seconds while preserving fog.

- Fixed retained splash images on 8-bit DirectDraw surfaces, including Worms Armageddon.
- Palette presentation releases its temporary GPU buffers after submission, preventing
  continuous GPU memory growth. Owned topmost dialogs now receive menu clicks correctly.
- Repacked the Serious Sam: The First Encounter demo with its original English text and audio.
- Expanded the compatibility list with the builds reported working in the current game
  collection, including Far Cry, Mafia, GTA: Vice City, NFS Underground 2, XIII, Painkiller,
  KKND2, Serious Sam, Deponia and Chains of Satinav. Demo-only coverage is stated explicitly.
- Direct3D 9 rendering runs in a separate worker by default. Graphics coverage includes
  additional D3DX effects/shader constants, texture and surface formats, fog and render states.
- Improved DirectSound cursor handling, Miles/OpenAL coverage, video playback and child-process
  display/input routing.
- Added touch controls, configurable virtual gamepad layouts and an on-screen keyboard.

### Runtime and maintenance

- Broadened Win32 and CRT coverage, exception handling and static library recognition.
- Improved CPU scheduling/JIT paths and code-cache tooling, with validation of guest memory,
  generated code publication and render ownership.
- Removed stale release-independent plans/handoffs and a closed A/B probe from tracked files.
  Touch templates and readback diagnostics no longer run as regression scenarios. Regression
  scripts now fail when their assertions or worker steps fail.
- Fixed Linux CI failures caused by video-plane and GDI canvas mocks leaking into EDIT
  control tests. Fixtures restore the original globals, including absent properties.
- Removed engine-specific first-run file creation, runtime INI overrides and fabricated
  renderer-probe processes. Missing files report the normal error, and child programs
  execute guest code with real waitable lifetimes and shared filesystem effects.
- Hidden child windows retain the parent's display. Exiting a visible child restores
  the live parent's display, input and audio registrations.
- The GOG CLI uses the project's installer reader without external unpacker fallbacks.

See [compatibility](docs/compatibility.md) for edition limits and [GOG import](docs/gog-import.md)
for storage requirements.
