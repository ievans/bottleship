/** IDirectMusicSegment8's DX8 methods sit where dmusici.h declares them, after the DX7 ones. */
import { expect, test } from "bun:test";
import { IDirectMusicSegment8 } from "../../src/worker/api/dmusic.api";

test("IDirectMusicSegment8: SetTrackConfig, GetAudioPathConfig, Compose, Download, Unload at slots 26-30", () => {
    const slot = (name: string) => IDirectMusicSegment8.methods.findIndex((m) => m.name === name);
    expect(["SetTrackConfig", "GetAudioPathConfig", "Compose", "Download", "Unload"].map(slot)).toEqual([26, 27, 28, 29, 30]);
    expect(IDirectMusicSegment8.methods.length).toBe(31);
});
