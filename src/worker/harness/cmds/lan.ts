/**
 * Virtual-LAN observability verbs: join/leave a room at run time, read the stack's state, and
 * trace the frames it exchanges with the relay. The trace tap is detached unless enabled, so the
 * send/receive path pays one null check.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { ROOM_NAME, ipToString } from "../../../net/lan-protocol";
import { configureLan, lanActive, lanStack, lanStatus } from "../../net/lan";
import { LAN_TRACE_CAPACITY, LanTrace } from "../../net/lan-trace";

let trace: LanTrace | null = null;

function ensureTrace(): LanTrace {
    return trace ??= new LanTrace(lanStack);
}

const dotted = (ip: number | null): string | null => (ip === null ? null : ipToString(ip));
const endpoint = (e: { ip: number; port: number } | null) => (e ? { ip: ipToString(e.ip), port: e.port } : null);

export function lanState() {
    const st = lanStatus();
    return {
        wanted: st.wanted !== null,
        url: st.wanted,
        connected: st.socketOpen,
        welcomed: lanStack.linked,
        ip: dotted(lanStack.ip),
        peers: [...lanStack.peers].map(ipToString),
        counters: { ...lanStack.counters },
        tracing: lanStack.tap !== null,
        sockets: lanStack.sockets().map((s) => ({ ...s, local: endpoint(s.local), remote: endpoint(s.remote) })),
    };
}

export function lanTrace(opts: { enable?: boolean; since?: number; limit?: number; reset?: boolean } = {}) {
    if (opts.enable === true) lanStack.tap = ensureTrace();
    else if (opts.enable === false) lanStack.tap = null;
    const t = trace;
    if (opts.reset) t?.clear();
    const since = opts.since ?? 0;
    return {
        enabled: lanStack.tap !== null,
        capacity: LAN_TRACE_CAPACITY,
        next: t?.nextSeq ?? 0,
        overwritten: t?.overwritten ?? 0,
        counters: { ...lanStack.counters },
        entries: t ? t.read(since, opts.limit ?? 0) : [],
    };
}

export function registerLanCommands(svc: HarnessService): void {
    /** lanJoin(room, url) — `url` is the full relay endpoint; the page side derives it from its origin. */
    svc.register("lanJoin", (args) => {
        const room = String(args[0] ?? "");
        const url = String(args[1] ?? "");
        if (!ROOM_NAME.test(room)) {
            throw new HarnessError(`lanJoin: invalid room "${room}" (A-Z a-z 0-9 _ -, 1-32 chars)`, HarnessErrorCode.BAD_ARGS);
        }
        if (!/^wss?:\/\/.+\/lan\/[^/]+$/.test(url) || !url.endsWith(`/lan/${room}`)) {
            throw new HarnessError(`lanJoin: url must be ws[s]://host/lan/${room}`, HarnessErrorCode.BAD_ARGS);
        }
        configureLan(url);
        return { joined: lanActive(), room, url };
    });

    svc.register("lanLeave", () => {
        const was = lanActive();
        configureLan(null);
        return { left: was };
    });

    svc.register("lanState", () => lanState());

    svc.register("lanTrace", (args) => lanTrace((args[0] as Parameters<typeof lanTrace>[0]) ?? {}));
}
