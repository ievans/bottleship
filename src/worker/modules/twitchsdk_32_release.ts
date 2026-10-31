/**
 * twitchsdk_32_release.dll — the Twitch broadcasting SDK rise.exe's Steam v1.10 branch
 * statically links. All 30 imports are by ORDINAL (no names in the import table), so there
 * is nothing to transcribe a real signature from; they are also a purely optional feature
 * by design — every title that ships this SDK has to run correctly on a PC with no Twitch
 * service reachable, which is the overwhelming common case. The real DLL's own init call
 * reports "unavailable" in that case and the game skips the rest of the surface entirely.
 *
 * Every ordinal stub answers 0 (false/null/success-as-no-op, whichever this SDK's own
 * "unavailable" convention needs) for exactly that reason — it's the one answer already
 * proven to make this SDK's calling code go quiet, since it's what happens on every PC
 * that doesn't have Twitch's broadcaster running.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

const ORDINALS = [1, 3, 5, 10, 11, 12, 13, 14, 15, 18, 19, 20, 25, 32, 33, 34, 36, 39, 40, 43, 44, 45, 46, 47, 71, 72, 73, 75, 77, 85];

export class TwitchSdk implements IModule {
    name = "twitchsdk_32_release";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        for (const ord of ORDINALS) {
            this.exports[`ord_${ord}`] = () => 0;
        }
    }
}
