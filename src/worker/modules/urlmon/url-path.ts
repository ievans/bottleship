/**
 * The file-system half of a URL moniker: which guest path a moniker's URL names, and the
 * canonical display name urlmon gives it. Pure, so the URL forms are testable on their own.
 */

/** A drive-absolute path, `C:\…` or `C:/…`. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]+):/;

function unescapePercent(s: string): string {
    return s.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The guest path a URL names, or null for a scheme that is not a file. Forms accepted:
 * `file:///C:/a/b`, `file://C:\a\b`, `file:C:/a`, `C:\a\b` and a relative path (`data\x.xml`),
 * which is joined to `baseDir` when one is given (a context moniker's directory).
 */
export function urlToPath(url: string, baseDir?: string | null): string | null {
    let s = url.trim();
    const scheme = SCHEME.exec(s);
    // A one-letter "scheme" is a drive letter, not a URL scheme.
    if (scheme && scheme[1]!.length > 1) {
        if (scheme[1]!.toLowerCase() !== "file") return null;
        s = unescapePercent(s.slice(scheme[0].length)).replace(/^[\\/]+/, "");
        if (!DRIVE_PATH.test(s) && /^[A-Za-z]:$/.test(s.slice(0, 2))) s = `${s.slice(0, 2)}\\${s.slice(2)}`;
    }
    s = s.replace(/\//g, "\\");
    if (DRIVE_PATH.test(s) || !baseDir) return s;
    const base = baseDir.replace(/\//g, "\\").replace(/\\+$/, "");
    return `${base}\\${s.replace(/^\.\\/, "")}`;
}

/** The directory part of a path, for resolving URLs relative to it. */
export function pathDirectory(path: string): string {
    const i = path.lastIndexOf("\\");
    return i < 0 ? "" : path.slice(0, i);
}

/** urlmon's display name for a file: `file:///C:/a/b.xml`. */
export function pathToFileUrl(path: string): string {
    const forward = path.replace(/\\/g, "/");
    return DRIVE_PATH.test(path) ? `file:///${forward}` : forward;
}
