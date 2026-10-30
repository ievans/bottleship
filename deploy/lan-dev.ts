/** Standalone virtual-LAN relay for `bun run dev` (Vite proxies /lan here). */
import { serveLan } from "./lan-relay";

const lan = serveLan();
const server = Bun.serve({
    port: parseInt(process.env.LAN_PORT ?? "5175"),
    hostname: process.env.LAN_HOST ?? "127.0.0.1",
    websocket: lan.websocket,
    fetch: (req, srv) => lan.upgrade(req, srv) ?? undefined,
});
console.log(`LAN relay on ws://${server.hostname}:${server.port}/lan/<room>`);
