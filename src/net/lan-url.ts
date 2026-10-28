import { ROOM_NAME } from "./lan-protocol";

/** `?lan=<room>` -> the relay WebSocket URL on this origin, or null when absent/invalid. */
export function lanRelayUrl(loc: Pick<Location, "protocol" | "host" | "search">): string | null {
    const room = new URLSearchParams(loc.search).get("lan");
    if (!room || !ROOM_NAME.test(room)) return null;
    return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/lan/${room}`;
}
