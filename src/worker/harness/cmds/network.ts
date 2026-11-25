import type { HarnessService } from "../service";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { getNetplayState } from "../../net/configure-netplay";
import { lanNetwork } from "../../net/lan-network";
import { processIpcState } from "../../core/process-ipc";
import { describeDirectPlay } from "../../modules/dplayx/network-api";

import { flushCensus } from "../../backends/webgpu/ddraw/geometry-upload-window";

export function registerNetworkCommands(service: HarnessService): void {
    /** GeometryUploadWindow.flush() census — real queue.writeBuffer calls across every
     *  ring, since the dynamic-import path evalWorker scripts use resolves to a SEPARATE
     *  module instance than the one the real render path holds (confirmed live: a wrapped
     *  prototype method never incremented while frames kept presenting). This command is
     *  statically imported into the harness bundle, so it reads the same instance the
     *  renderer writes to. */
    service.register("flushCensus", (args) => {
        const reset = !!(args?.[0] as { reset?: boolean } | undefined)?.reset;
        const snapshot = { ...flushCensus };
        if (reset) { flushCensus.calls = 0; flushCensus.bytes = 0; }
        return snapshot;
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
