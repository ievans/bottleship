import { describe, expect, test } from "bun:test";
import { pathDirectory, pathToFileUrl, urlToPath } from "../../src/worker/modules/urlmon/url-path";

describe("urlToPath", () => {
    test("file URLs in the forms clients write them", () => {
        expect(urlToPath("file:///C:/Games/RoN/data/x.xml")).toBe("C:\\Games\\RoN\\data\\x.xml");
        expect(urlToPath("file://C:\\Games\\x.xml")).toBe("C:\\Games\\x.xml");
        expect(urlToPath("file:C:/x.xml")).toBe("C:\\x.xml");
        expect(urlToPath("FILE:///C:/My%20Games/x.xml")).toBe("C:\\My Games\\x.xml");
    });

    test("a plain drive path is its own URL", () => {
        expect(urlToPath("C:\\data\\x.xml")).toBe("C:\\data\\x.xml");
        expect(urlToPath("D:/x.xml")).toBe("D:\\x.xml");
    });

    test("a relative path joins the context moniker's directory, or stays relative", () => {
        expect(urlToPath("data\\current_version.xml", "C:\\RoN")).toBe("C:\\RoN\\data\\current_version.xml");
        expect(urlToPath("./a/b.xml", "C:\\RoN\\")).toBe("C:\\RoN\\a\\b.xml");
        expect(urlToPath("data\\current_version.xml")).toBe("data\\current_version.xml");
    });

    test("a non-file scheme names no path", () => {
        expect(urlToPath("http://example.com/x.xml")).toBeNull();
        expect(urlToPath("res://msxml4.dll/x")).toBeNull();
    });
});

describe("display names", () => {
    test("a drive path displays as a file URL", () => {
        expect(pathToFileUrl("C:\\RoN\\data\\x.xml")).toBe("file:///C:/RoN/data/x.xml");
        expect(pathDirectory("C:\\RoN\\data\\x.xml")).toBe("C:\\RoN\\data");
    });
});
