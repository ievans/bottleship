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
