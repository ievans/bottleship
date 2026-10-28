import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { lanActive, lanStack } from "../net/lan";

const ERROR_SUCCESS = 0;
const ERROR_BUFFER_OVERFLOW = 111;
const ERROR_NO_DATA = 232;
const ERROR_INVALID_PARAMETER = 87;
const MIB_IF_TYPE_ETHERNET = 6;

// IP_ADDR_STRING (iptypes.h): Next(4) + IpAddress(char[16]) + IpMask(char[16]) + Context(4) = 40.
const IP_ADDR_STRING_SIZE = 40;
const IP_ADDR_STRING_IPADDR_OFF = 4;
const IP_ADDR_STRING_IPMASK_OFF = 20;
const IP_ADDR_STRING_CONTEXT_OFF = 36;

// IP_ADAPTER_INFO (iptypes.h), x86 layout — one entry, no Next (single virtual adapter).
const ADAPTER_NAME_OFF = 8, ADAPTER_NAME_LEN = 260;
const DESCRIPTION_OFF = 268, DESCRIPTION_LEN = 132;
const ADDRESS_LENGTH_OFF = 400;
const ADDRESS_OFF = 404; // BYTE[8]
const INDEX_OFF = 412;
const TYPE_OFF = 416;
const DHCP_ENABLED_OFF = 420;
const CURRENT_IP_ADDRESS_OFF = 424;
const IP_ADDRESS_LIST_OFF = 428;
const GATEWAY_LIST_OFF = IP_ADDRESS_LIST_OFF + IP_ADDR_STRING_SIZE; // 468
const DHCP_SERVER_OFF = GATEWAY_LIST_OFF + IP_ADDR_STRING_SIZE; // 508
const HAVE_WINS_OFF = DHCP_SERVER_OFF + IP_ADDR_STRING_SIZE; // 548
const PRIMARY_WINS_OFF = HAVE_WINS_OFF + 4; // 552
const SECONDARY_WINS_OFF = PRIMARY_WINS_OFF + IP_ADDR_STRING_SIZE; // 592
const LEASE_OBTAINED_OFF = SECONDARY_WINS_OFF + IP_ADDR_STRING_SIZE; // 632
const LEASE_EXPIRES_OFF = LEASE_OBTAINED_OFF + 4; // 636
const IP_ADAPTER_INFO_SIZE = LEASE_EXPIRES_OFF + 4; // 640

function ipToDotted(ip: number): string {
    return `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`;
}

function writeAnsiField(mem: Uint8Array, addr: number, maxLen: number, text: string): void {
    const bytes = new TextEncoder().encode(text);
    const n = Math.min(bytes.length, maxLen - 1);
    mem.set(bytes.subarray(0, n), addr);
    mem[addr + n] = 0;
}

function writeU32(mem: Uint8Array, addr: number, value: number): void {
    mem[addr] = value & 0xff;
    mem[addr + 1] = (value >>> 8) & 0xff;
    mem[addr + 2] = (value >>> 16) & 0xff;
    mem[addr + 3] = (value >>> 24) & 0xff;
}

function writeIpAddrString(mem: Uint8Array, addr: number, ipDotted: string, maskDotted: string, context: number): void {
    writeU32(mem, addr, 0); // Next
    writeAnsiField(mem, addr + IP_ADDR_STRING_IPADDR_OFF, 16, ipDotted);
    writeAnsiField(mem, addr + IP_ADDR_STRING_IPMASK_OFF, 16, maskDotted);
    writeU32(mem, addr + IP_ADDR_STRING_CONTEXT_OFF, context);
}

/** Our virtual LAN's assumed gateway: the relay (never handed out to a peer — see lan.ts). */
const LAN_GATEWAY_DOTTED = "192.168.77.1";
const LAN_NETMASK_DOTTED = "255.255.255.0";

/** One synthetic IP_ADAPTER_INFO describing the virtual-LAN adapter at `ip` (host-order uint32). */
function writeVirtualAdapter(mem: Uint8Array, addr: number, ip: number): void {
    writeU32(mem, addr, 0); // Next — single adapter, end of list
    writeU32(mem, addr + 4, 0); // ComboIndex
    writeAnsiField(mem, addr + ADAPTER_NAME_OFF, ADAPTER_NAME_LEN, "BottleShipLan");
    writeAnsiField(mem, addr + DESCRIPTION_OFF, DESCRIPTION_LEN, "BottleShip Virtual LAN Adapter");
    writeU32(mem, addr + ADDRESS_LENGTH_OFF, 6);
    // A deterministic locally-administered MAC derived from our virtual IP, so each room
    // peer reports a distinct, stable address rather than an all-zero one.
    const macLocal = [0x02, 0xbb, (ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff];
    mem.set(macLocal, addr + ADDRESS_OFF);
    mem[addr + ADDRESS_OFF + 6] = 0;
    mem[addr + ADDRESS_OFF + 7] = 0;
    writeU32(mem, addr + INDEX_OFF, 1);
    writeU32(mem, addr + TYPE_OFF, MIB_IF_TYPE_ETHERNET);
    writeU32(mem, addr + DHCP_ENABLED_OFF, 0); // static address, not DHCP
    writeU32(mem, addr + CURRENT_IP_ADDRESS_OFF, 0);
    writeIpAddrString(mem, addr + IP_ADDRESS_LIST_OFF, ipToDotted(ip), LAN_NETMASK_DOTTED, 1);
    writeIpAddrString(mem, addr + GATEWAY_LIST_OFF, LAN_GATEWAY_DOTTED, "255.255.255.255", 0);
    writeIpAddrString(mem, addr + DHCP_SERVER_OFF, "0.0.0.0", "255.255.255.255", 0);
    writeU32(mem, addr + HAVE_WINS_OFF, 0);
    writeIpAddrString(mem, addr + PRIMARY_WINS_OFF, "0.0.0.0", "255.255.255.255", 0);
    writeIpAddrString(mem, addr + SECONDARY_WINS_OFF, "0.0.0.0", "255.255.255.255", 0);
    writeU32(mem, addr + LEASE_OBTAINED_OFF, 0);
    writeU32(mem, addr + LEASE_EXPIRES_OFF, 0);
}

export class Iphlpapi implements IModule {
    name = "iphlpapi";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        // DWORD GetAdaptersInfo(PIP_ADAPTER_INFO pAdapterInfo, PULONG pOutBufLen)
        //
        // Offline (no `?lan=` room): ERROR_NO_DATA, as before — there is no network.
        // In a room: report one synthetic adapter for the virtual 192.168.77.x LAN, so a
        // title that gates "do I have a network adapter" before offering multiplayer (as
        // Empire Earth's TCP Protocol.dll appears to) sees one once a room is actually
        // joined. Generic — benefits every title that calls this, not a per-game branch.
        this.exports["GetAdaptersInfo"] = (_ctx, mem, args) => {
            const pAdapterInfo = args[0] >>> 0;
            const pOutBufLen = args[1] >>> 0;

            if (!lanActive() || lanStack.ip === null) {
                return { value: ERROR_NO_DATA, stackCleanup: 8 };
            }

            const available = Mem.readUint32(pOutBufLen);
            if (available === null) {
                return { value: ERROR_NO_DATA, stackCleanup: 8 };
            }
            if (available < IP_ADAPTER_INFO_SIZE || !pAdapterInfo) {
                Mem.writeUint32(pOutBufLen, IP_ADAPTER_INFO_SIZE);
                return { value: ERROR_BUFFER_OVERFLOW, stackCleanup: 8 };
            }

            if (pAdapterInfo + IP_ADAPTER_INFO_SIZE > mem.length || !isValidAddress(mem, pAdapterInfo, IP_ADAPTER_INFO_SIZE, "rw")) {
                return { value: ERROR_INVALID_PARAMETER, stackCleanup: 8 };
            }
            const adapter = new Uint8Array(IP_ADAPTER_INFO_SIZE);
            writeVirtualAdapter(adapter, 0, lanStack.ip);
            if (Mem.writeBytes(pAdapterInfo, adapter) === 0) return { value: ERROR_INVALID_PARAMETER, stackCleanup: 8 };
            Mem.writeUint32(pOutBufLen, IP_ADAPTER_INFO_SIZE);
            return { value: ERROR_SUCCESS, stackCleanup: 8 };
        };
    }
}
