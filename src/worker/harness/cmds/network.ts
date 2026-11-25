import type { HarnessService } from "../service";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { getNetplayState } from "../../net/configure-netplay";
import { lanNetwork } from "../../net/lan-network";
import { processIpcState } from "../../core/process-ipc";
import { describeDirectPlay } from "../../modules/dplayx/network-api";
import { socketCallCensus, sendCallCensus } from "../../modules/wsa-network-api";
import { sendBroadcastCensus } from "../../modules/wsa-network";
import { getProcessNetworkNamespace } from "../../core/process-network";
import type { RootNetworkNamespace } from "../../core/network-namespace";

export function registerNetworkCommands(service: HarnessService): void {
    /** Real calls into socket()/WSASocket*, since breakpoint tooling against these
     *  call sites has been unreliable — answers "does guest code reach this at all". */
    service.register("socketCallCensus", () => ({ ...socketCallCensus }));
    service.register("sendCallCensus", () => ({ ...sendCallCensus }));
    service.register("sendBroadcastCensus", () => ({ ...sendBroadcastCensus }));
    /** The socket actor worker owns its OWN LanNetwork instance, invisible to `networkState`'s
     *  `lanNetwork.stats` (a different realm entirely — see wsa-actor-worker.ts). This asks
     *  that worker directly instead of reading stats from the wrong object. */
    service.register("actorNetworkStats", async () => {
        const ns = getProcessNetworkNamespace() as RootNetworkNamespace & { queryActorStats?: () => Promise<{ sent: number; received: number; dropped: number }> };
        if (typeof ns.queryActorStats !== "function") return { available: false, reason: "not a RootNetworkNamespace or no actor worker started" };
        try { return { available: true, stats: await ns.queryActorStats() }; }
        catch (error) { return { available: false, reason: error instanceof Error ? error.message : String(error) }; }
    });
    service.register("processIpcState", () => processIpcState());
    /** DirectPlay 1-4 sessions of this process: roster (players, groups, members, owner) and queue. */
    service.register("dplayState", () => ({ objects: describeDirectPlay() }));
    service.register("networkState", () => {
        const state = getNetplayState();
        return {
            config: EmulatorConfig.getInstance().network,
            connected: state.connected,
            address: state.ipv4.join("."),
            node: Array.from(state.node),
            generation: state.generation,
            reason: state.reason,
            packets: { ...lanNetwork.stats },
        };
    });
}
