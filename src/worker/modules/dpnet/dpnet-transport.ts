/** Dp8Engine's datagram transport, carried by the virtual-LAN UDP stack. */

import { LAN_BROADCAST } from "../../../net/lan-protocol";
import type { LanStack } from "../../net/lan-stack";
import type { Transport } from "./dpnet-engine";

const LOOPBACK = 0x7f000001;
const FIRST_SOCKET_ID = 0x40000000;
const MAX_DATAGRAM = 65507;
let nextSocketId = FIRST_SOCKET_ID;

export class LanTransport implements Transport {
    onReceive: ((ip: number, port: number, data: Uint8Array) => void) | null = null;
    private sock = 0;
    private bound = 0;

    constructor(private readonly stack: LanStack) {}

    get ip(): number { return this.stack.ip ?? LOOPBACK; }
    get port(): number { return this.bound; }

    bind(port: number): number {
        this.close();
        const id = nextSocketId++;
        this.stack.create(id, 0);
        if (this.stack.bind(id, 0, port) !== 0) {
            this.stack.close(id);
            return 0;
        }
        this.sock = id;
        this.bound = this.stack.names(id)?.local.port ?? 0;
        void this.pump(id);
        return this.bound;
    }

    send(ip: number, port: number, data: Uint8Array): void {
        if (this.sock && data.length <= MAX_DATAGRAM) this.stack.sendTo(this.sock, ip, port, data);
    }

    broadcast(port: number, data: Uint8Array): void {
        this.send(LAN_BROADCAST, port, data);
    }

    close(): void {
        if (this.sock) this.stack.close(this.sock);
        this.sock = 0;
        this.bound = 0;
    }

    // A broadcast is also delivered to its own sender; the engine must not answer itself.
    private async pump(id: number): Promise<void> {
        while (this.sock === id && this.stack.has(id)) {
            for (;;) {
                const r = this.stack.recv(id, MAX_DATAGRAM, false);
                if (r.err !== 0 && r.data.length === 0) break;
                const own = r.port === this.bound && (r.ip === this.ip || r.ip === LOOPBACK);
                if (!own) this.onReceive?.(r.ip, r.port, r.data);
            }
            if (this.stack.isDown(id)) return;
            await this.stack.waitChange([id], -1);
        }
    }
}
