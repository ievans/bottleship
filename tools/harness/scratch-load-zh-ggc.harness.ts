import { harness } from "../harness";

const bundlePath = Bun.env.BS_ZH_BUNDLE;
if (!bundlePath) throw new Error("Set BS_ZH_BUNDLE to the path of the Zero Hour WGB");

await harness()
  .openWgb(bundlePath)
  .sleep(15000)
  .shot({ save: "boot.png" })
  .run();
