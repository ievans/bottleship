/**
 * IDirectPlay8Address data model: an ordered set of typed, named components plus opaque user
 * data, with the `x-directplay:/` URL form. Pure — no guest memory — so the format is testable
 * on its own.
 */

export const DPNA_DATATYPE_STRING = 1;
export const DPNA_DATATYPE_DWORD = 2;
export const DPNA_DATATYPE_GUID = 3;
export const DPNA_DATATYPE_BINARY = 4;

export const DPNA_KEY_PROVIDER = "provider";
export const DPNA_KEY_DEVICE = "device";
export const DPNA_KEY_HOSTNAME = "hostname";
export const DPNA_KEY_PORT = "port";

export const CLSID_DP8SP_TCPIP = "ebfe7ba0-628d-11d2-ae0f-006097b01411";
export const CLSID_DP8SP_IPX = "53934290-628d-11d2-ae0f-006097b01411";
export const CLSID_DP8SP_MODEM = "6d4a3650-628d-11d2-ae0f-006097b01411";
export const CLSID_DP8SP_SERIAL = "743b5d60-628d-11d2-ae0f-006097b01411";

export const DPN_DEFAULT_PORT = 6073;

export type AddressValue =
    | { type: typeof DPNA_DATATYPE_STRING; value: string }
    | { type: typeof DPNA_DATATYPE_DWORD; value: number }
    | { type: typeof DPNA_DATATYPE_GUID; value: string }
    | { type: typeof DPNA_DATATYPE_BINARY; value: Uint8Array };

const SCHEME = "x-directplay:/";
const DWORD_KEYS = new Set(["port", "baud", "stopbits", "parity", "flowcontrol", "localport"]);
const GUID_KEYS = new Set([DPNA_KEY_PROVIDER, DPNA_KEY_DEVICE]);
const GUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const normalizeGuid = (g: string): string => g.replace(/[{}]/g, "").toLowerCase();

/** Bytes for a GUID in its canonical text form; the wire form of every GUID this module sends. */
export function guidToBytes(guid: string): Uint8Array {
    const hex = normalizeGuid(guid).replace(/-/g, "");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    return out;
}

export function bytesToGuid(b: Uint8Array): string {
    const h = Array.from(b.subarray(0, 16), x => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const UNRESERVED = /[A-Za-z0-9\-_.!~*'()]/;

function escapeText(s: string): string {
    let out = "";
    for (const byte of new TextEncoder().encode(s)) {
        const c = String.fromCharCode(byte);
        out += byte < 0x80 && UNRESERVED.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
}

function unescapeBytes(s: string): Uint8Array | null {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "%") {
            const hex = s.slice(i + 1, i + 3);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
            out.push(parseInt(hex, 16));
            i += 2;
        } else {
            out.push(s.charCodeAt(i) & 0xff);
        }
    }
    return Uint8Array.from(out);
}

export class Dp8Address {
    readonly components = new Map<string, AddressValue>();
    userData: Uint8Array | null = null;

    clone(): Dp8Address {
        const c = new Dp8Address();
        for (const [k, v] of this.components) c.components.set(k, v.type === DPNA_DATATYPE_BINARY ? { type: v.type, value: v.value.slice() } : { ...v });
        c.userData = this.userData?.slice() ?? null;
        return c;
    }

    clear(): void {
        this.components.clear();
        this.userData = null;
    }

    string(key: string): string | null {
        const v = this.components.get(key);
        return v?.type === DPNA_DATATYPE_STRING ? v.value : null;
    }

    dword(key: string): number | null {
        const v = this.components.get(key);
        return v?.type === DPNA_DATATYPE_DWORD ? v.value : null;
    }

    guid(key: string): string | null {
        const v = this.components.get(key);
        return v?.type === DPNA_DATATYPE_GUID ? v.value : null;
    }

    setString(key: string, value: string): void { this.components.set(key, { type: DPNA_DATATYPE_STRING, value }); }
    setDword(key: string, value: number): void { this.components.set(key, { type: DPNA_DATATYPE_DWORD, value: value >>> 0 }); }
    setGuid(key: string, value: string): void { this.components.set(key, { type: DPNA_DATATYPE_GUID, value: normalizeGuid(value) }); }

    isEqual(other: Dp8Address): boolean {
        if (this.components.size !== other.components.size) return false;
        for (const [k, v] of this.components) {
            const o = other.components.get(k);
            if (!o || o.type !== v.type) return false;
            if (v.type === DPNA_DATATYPE_BINARY) {
                const ob = (o as typeof v).value;
                if (ob.length !== v.value.length || ob.some((x, i) => x !== v.value[i])) return false;
            } else if (o.value !== v.value) {
                return false;
            }
        }
        return true;
    }

    /** `x-directplay:/provider=%7B…%7D;hostname=1.2.3.4;port=6073` (provider first, as DirectPlay writes it). */
    toUrl(): string {
        const parts: string[] = [];
        const emit = (k: string, v: AddressValue): void => {
            let text: string;
            switch (v.type) {
                case DPNA_DATATYPE_DWORD: text = String(v.value >>> 0); break;
                case DPNA_DATATYPE_GUID: text = `%7B${v.value.toUpperCase()}%7D`; break;
                case DPNA_DATATYPE_BINARY: text = Array.from(v.value, b => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""); break;
                default: text = escapeText(v.value);
            }
            parts.push(`${escapeText(k)}=${text}`);
        };
        const provider = this.components.get(DPNA_KEY_PROVIDER);
        if (provider) emit(DPNA_KEY_PROVIDER, provider);
        for (const [k, v] of this.components) if (k !== DPNA_KEY_PROVIDER) emit(k, v);
        let url = SCHEME + parts.join(";");
        if (this.userData?.length) url += "#" + Array.from(this.userData, b => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
        return url;
    }

    /** null when `url` is not a DirectPlay URL. */
    static fromUrl(url: string): Dp8Address | null {
        if (url.length < SCHEME.length || url.slice(0, SCHEME.length).toLowerCase() !== SCHEME) return null;
        const addr = new Dp8Address();
        let body = url.slice(SCHEME.length);
        const hash = body.indexOf("#");
        if (hash >= 0) {
            const data = unescapeBytes(body.slice(hash + 1));
            if (!data) return null;
            addr.userData = data;
            body = body.slice(0, hash);
        }
        for (const part of body.split(";")) {
            if (!part) continue;
            const eq = part.indexOf("=");
            if (eq <= 0) return null;
            const nameBytes = unescapeBytes(part.slice(0, eq));
            const raw = part.slice(eq + 1);
            if (!nameBytes) return null;
            const name = new TextDecoder().decode(nameBytes).toLowerCase();
            if (GUID_KEYS.has(name)) {
                const guid = normalizeGuid(decodeURIComponentSafe(raw));
                if (!GUID_TEXT.test(guid)) return null;
                addr.setGuid(name, guid);
            } else if (DWORD_KEYS.has(name)) {
                if (!/^\d{1,10}$/.test(raw)) return null;
                addr.setDword(name, Number(raw));
            } else {
                const bytes = unescapeBytes(raw);
                if (!bytes) return null;
                addr.setString(name, new TextDecoder().decode(bytes));
            }
        }
        return addr;
    }

    /** The IPv4 this address names, dotted-quad or "localhost"; null when absent or not resolvable. */
    hostIp(): number | null {
        const host = this.string(DPNA_KEY_HOSTNAME);
        if (host === null) return null;
        if (host.toLowerCase() === "localhost") return 0x7f000001;
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
        if (!m) return null;
        const o = m.slice(1).map(Number);
        if (o.some(x => x > 255)) return null;
        return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
    }
}

function decodeURIComponentSafe(s: string): string {
    try { return decodeURIComponent(s); } catch { return s; }
}

/** An address naming `ip:port` through the TCP/IP provider. */
export function endpointAddress(ip: string, port: number): Dp8Address {
    const a = new Dp8Address();
    a.setGuid(DPNA_KEY_PROVIDER, CLSID_DP8SP_TCPIP);
    a.setString(DPNA_KEY_HOSTNAME, ip);
    a.setDword(DPNA_KEY_PORT, port);
    return a;
}
