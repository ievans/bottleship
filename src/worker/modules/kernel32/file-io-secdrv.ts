/**
 * kernel32 device handle for Macrovision SafeDisc's "SecDrv" pseudo-device
 * (\\.\Global\SecDrv, falling back to \\.\SecDrv). secdrv.sys is a Ring-0 driver
 * with no analogue here — Macrovision discontinued SafeDisc around 2009 and
 * Microsoft itself blocked the driver from loading on Windows in 2015, so a
 * legitimately-owned SafeDisc title has no way to satisfy this check on any
 * current OS either. This recreates the driver's documented DeviceIoControl
 * contract at the device-handle level (the same way file-io-console.ts
 * recreates CON/NUL rather than a real character device), derived directly
 * from decompiling the real secdrv.sys shipped on the game's own disc —
 * every constant below is read off that binary, not guessed or borrowed.
 *
 * The loader issues CTL_CODE(0xEF00, 0x901, METHOD_NEITHER, FILE_ANY_ACCESS)
 * = 0xEF002407 with a fixed-size 1300-byte input and a 1552- or 3096-byte
 * output buffer (both sizes the driver itself checks exactly). Byte offset
 * 0xc of the input selects a sub-command in [0x3c, 0x43] via a jump table;
 * only 0x3e ("SetupVerification") is exercised during Generals/Zero Hour
 * bring-up. Its handler requires a zero-length sub-payload (input dword at
 * 0x410 == 0) and then just writes one fixed magic word — no real
 * cryptographic challenge is involved for this sub-command.
 *
 * A second, command-independent step (secdrv.sys's own epilogue) always
 * echoes a {3, 0x12, 0} header into the response and fills a 16-byte region
 * with values from a driver-internal PRNG (a 32-bit LCG reseeded from a
 * fixed constant every call, so its output is deterministic and reproduced
 * exactly here) XORed with the live tick count — this looks like an
 * anti-replay/liveness field, not something the loader diffs against a
 * known value, but it costs nothing to recreate exactly rather than guess
 * it's unchecked.
 */
import { Logger, LogCategory } from '../../core/logger';
import { TimeService } from '../../runtime/time';

const SECDRV_DEVICE_MARKER = Symbol('SecdrvDeviceHandle');

/** True for `\\.\SecDrv` or `\\.\Global\SecDrv`, case-insensitive. */
export function isSecdrvDevicePath(path: string): boolean {
    const withoutPrefix = path.toUpperCase().replace(/^\\\\\.\\/, '').replace(/\\+/g, '\\');
    return withoutPrefix === 'SECDRV' || withoutPrefix === 'GLOBAL\\SECDRV';
}

export class SecdrvDeviceHandle {
    readonly [SECDRV_DEVICE_MARKER] = true;
}

export function isSecdrvDeviceHandle(handle: unknown): handle is SecdrvDeviceHandle {
    return !!handle && (handle instanceof SecdrvDeviceHandle || (handle as any)[SECDRV_DEVICE_MARKER] === true);
}

/** CTL_CODE(0xEF00, 0x901, METHOD_NEITHER, FILE_ANY_ACCESS), read off secdrv.sys's dispatch routine. */
export const SECDRV_IOCTL_MAIN = 0xef002407;
const SECDRV_IN_SIZE = 0x514; // 1300 — checked for exact equality by the driver
// @transient(constant set of valid sizes, never mutated)
const SECDRV_OUT_SIZES = new Set([0x610, 0xc18]); // 1552, 3096 — the two sizes Generals/ZH request

const SUBCOMMAND_OFFSET = 0xc;
const PAYLOAD_SIZE_OFFSET = 0x410; // input dword: length of the per-subcommand payload that follows
const RESPONSE_PAYLOAD_OFFSET = 0x410; // output dword: where the 0x3e handler's magic lands
const RESPONSE_COUNT_OFFSET = 0x40c;

const SETUP_VERIFICATION_SUBCOMMAND = 0x3e;
const SETUP_VERIFICATION_MAGIC = 0x5278d11b;

// secdrv.sys's internal LCG: seed = seed * MULT + ADD (mod 2^32), reseeded from LCG_SEED on
// every call — so, unlike a real PRNG, its three outputs are the same every time.
const LCG_SEED = 0xf367ac7f;
const LCG_MULT = (0xf2241004 | 0x008124e1) >>> 0;
const LCG_ADD = (0xbfbd6eeb & 0x765bf3fd) >>> 0;

function lcgSequence(): [number, number, number] {
    let seed = LCG_SEED;
    const out: number[] = [];
    for (let i = 0; i < 3; i++) {
        seed = (Math.imul(seed, LCG_MULT) + LCG_ADD) >>> 0;
        out.push(seed);
    }
    return out as [number, number, number];
}

/**
 * Faithfully answers one secdrv.sys DeviceIoControl call. Returns the number of bytes to
 * report back through lpBytesReturned, or null when the request doesn't match what the real
 * driver accepts (caller should fail the call exactly as an absent/foreign driver would).
 */
export function answerSecdrvIoctl(ioctl: number, inBuf: Uint8Array, outBuf: Uint8Array): number | null {
    if (ioctl !== SECDRV_IOCTL_MAIN) return null;
    if (inBuf.length !== SECDRV_IN_SIZE || !SECDRV_OUT_SIZES.has(outBuf.length)) return null;

    const inView = new DataView(inBuf.buffer, inBuf.byteOffset, inBuf.byteLength);
    const subcommand = inView.getUint32(SUBCOMMAND_OFFSET, true);
    if (subcommand !== SETUP_VERIFICATION_SUBCOMMAND) {
        Logger.warn(LogCategory.KERNEL32, `SecDrv: unimplemented sub-command 0x${subcommand.toString(16)}`);
        return null;
    }
    if (inView.getUint32(PAYLOAD_SIZE_OFFSET, true) !== 0) return null;

    const outView = new DataView(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength);
    outView.setUint32(0, 3, true);
    outView.setUint32(4, 0x12, true);
    outView.setUint32(8, 0, true);
    const [v1, v2, v3] = lcgSequence();
    const tick = TimeService.getInstance().guestTickMs() | 0;
    outView.setUint32(0xc, (tick ^ v1 ^ v2 ^ v3) >>> 0, true);
    outView.setUint32(0x10, v1, true);
    outView.setUint32(0x14, v2, true);
    outView.setUint32(0x18, v3, true);
    outView.setUint32(RESPONSE_PAYLOAD_OFFSET, SETUP_VERIFICATION_MAGIC, true);
    outView.setUint32(RESPONSE_COUNT_OFFSET, 4, true);

    return outBuf.length;
}
