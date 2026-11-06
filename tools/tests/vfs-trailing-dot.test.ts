/**
 * Win32 path normalization drops trailing dots and spaces from each component, so a
 * game that builds "<dir>.\file" (Rise of Nations writes "...\Rise of Nations.\gamelog.ini")
 * is naming a file inside <dir>.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive } from "@bottleship/formats/zip";
import { installFakeOpfs, findFakeByName } from "./fixtures/fake-opfs";

const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;

const origNavigator = (globalThis as unknown as { navigator: unknown }).navigator;
afterAll(() => { (globalThis as unknown as { navigator: unknown }).navigator = origNavigator; });

describe("VFS trailing dots", () => {
    test("a file created under \"Dir.\" lands in Dir", async () => {
        const root = installFakeOpfs();
        const vfs = new VirtualFileSystem();
        vfs.mountRom(null as unknown as ZipArchive, "rom", new Map());
        await vfs.initOverlay("test:trailing-dot");

        expect(vfs.createDirectorySync("C:\\Game Data").ok).toBe(true);
        const h = vfs.openSync("C:\\Game Data.\\gamelog.ini", GENERIC_WRITE, CREATE_ALWAYS);
        expect(h).toBeTruthy();
        vfs.writeSync(h!, new TextEncoder().encode("[log]\r\n"));
        await vfs.flushAll();

        expect(vfs.listDirectory("C:\\Game Data").map((e) => e.name.toLowerCase())).toContain("gamelog.ini");
        expect(findFakeByName(root, "gamelog.ini")).not.toBeNull();
    });
});
