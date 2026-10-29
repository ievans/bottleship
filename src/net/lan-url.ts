import { ROOM_NAME } from "./lan-protocol";

/** `?lan=<room>` -> the relay WebSocket URL on this origin, or null when absent/invalid. */
export function lanRelayUrl(loc: Pick<Location, "protocol" | "host" | "search">): string | null {
    const room = new URLSearchParams(loc.search).get("lan");
    if (!room || !ROOM_NAME.test(room)) return null;
    return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/lan/${room}`;
}

const ROOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** An unguessable room name (~103 bits): a room is open to anyone who knows it, so it is the secret. */
export function newLanRoom(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
    let room = "";
    // Rejection sampling keeps every letter equally likely (256 is not a multiple of 36).
    while (room.length < 20) for (const b of rand(32)) if (b < 252 && room.length < 20) room += ROOM_ALPHABET[b % 36];
    return room;
}
