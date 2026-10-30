import fs from "fs";
import path from "path";

/** The relay imports the wire format from the repo tree; a flat stand ships both files side by side. */
export function standRelaySource(src: string): string {
    const specifier = '"../src/net/lan-protocol"';
    if (!src.includes(specifier)) throw new Error(`lan-relay.ts no longer imports ${specifier}; update tools/stand-relay.ts`);
    return src.split(specifier).join('"./lan-protocol"');
}

export function writeStandRelay(repo: string, out: string): void {
    fs.writeFileSync(path.join(out, "lan-relay.ts"), standRelaySource(fs.readFileSync(path.join(repo, "deploy", "lan-relay.ts"), "utf8")));
    fs.copyFileSync(path.join(repo, "src", "net", "lan-protocol.ts"), path.join(out, "lan-protocol.ts"));
}
