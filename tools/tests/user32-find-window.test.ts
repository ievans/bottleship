/**
 * FindWindow finds a window by its class name and caption, ignoring case — dssl.dll (Rise of
 * Nations' sound system) gives up on audio when FindWindowW("BigHugeClass", NULL) finds nothing.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { registerBuiltinClass, getWindowClassId, resetUser32Classes } from "../../src/worker/modules/user32/class";
import { registerWindowQueryExports } from "../../src/worker/modules/user32/window-query";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

// Strings live above 0xFFFF: a lower class-name pointer is a class atom.
const mem = new Uint8Array(0x20000);
const wide = (at: number, s: string) => { for (let i = 0; i <= s.length; i++) { const c = i < s.length ? s.charCodeAt(i) : 0; mem[at + 2 * i] = c & 0xff; mem[at + 2 * i + 1] = c >> 8; } return at; };
const ascii = (at: number, s: string) => { for (let i = 0; i <= s.length; i++) mem[at + i] = i < s.length ? s.charCodeAt(i) : 0; return at; };

describe("FindWindow", () => {
    const exports: Record<string, ThunkImplementation> = {};
    registerWindowQueryExports(exports);
    const call = (name: string, args: number[]) => exports[name]!({} as never, mem, args) as number;

    beforeEach(() => {
        (System.getInstance() as unknown as { windowManager: unknown }).windowManager ??= { registerClass: () => undefined };
        resetUser32Classes();
        windows.clear();
        registerBuiltinClass("BigHugeClass", {});
        const add = (handle: number, extra: Partial<WindowInfo>) => windows.set(handle, {
            handle, title: "", style: 0, x: 0, y: 0, width: 1, height: 1, children: [], visible: true, wndProc: 0, ...extra,
        } as WindowInfo);
        add(0x10001, { classId: getWindowClassId("bighugeclass"), title: "Rise of Nations: Extended Edition" });
        add(0x10002, { nativeClassName: "IME", title: "Default IME" });
    });

    test("matches the class name in any case, with or without a caption", () => {
        expect(call("FindWindowW", [wide(0x10100, "BigHugeClass"), 0])).toBe(0x10001);
        expect(call("FindWindowW", [wide(0x10100, "bighugeclass"), wide(0x10200, "RISE OF NATIONS: EXTENDED EDITION")])).toBe(0x10001);
        expect(call("FindWindowA", [ascii(0x10300, "BIGHUGECLASS"), 0])).toBe(0x10001);
        expect(call("FindWindowW", [wide(0x10100, "BigHugeClass"), wide(0x10200, "Another Game")])).toBe(0);
    });

    test("matches a window that carries only a native class name", () => {
        expect(call("FindWindowW", [wide(0x10100, "ime"), 0])).toBe(0x10002);
    });

    test("finds by caption alone", () => {
        expect(call("FindWindowW", [0, wide(0x10200, "default ime")])).toBe(0x10002);
    });
});
