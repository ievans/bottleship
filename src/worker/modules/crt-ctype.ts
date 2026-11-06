/**
 * The classic "C" locale's character classification masks (the values in MSVC's
 * _pctype table and ctype<char>'s _Table): _UPPER 0x1, _LOWER 0x2, _DIGIT 0x4,
 * _SPACE 0x8, _PUNCT 0x10, _CONTROL 0x20, _BLANK 0x40, _HEX 0x80, _ALPHA 0x100.
 * Bytes above 0x7f have no class.
 */
const C_UPPER = 0x0001;
const C_LOWER = 0x0002;
const C_DIGIT = 0x0004;
const C_SPACE = 0x0008;
const C_PUNCT = 0x0010;
const C_CONTROL = 0x0020;
const C_BLANK = 0x0040;
const C_HEX = 0x0080;
const C_ALPHA = 0x0100;

export function classicCtypeFlags(ch: number): number {
    let flags = 0;
    if (ch >= 0x41 && ch <= 0x5a) {
        flags |= C_UPPER | C_ALPHA;
    } else if (ch >= 0x61 && ch <= 0x7a) {
        flags |= C_LOWER | C_ALPHA;
    }
    if (ch >= 0x30 && ch <= 0x39) {
        flags |= C_DIGIT | C_HEX;
    }
    if (ch === 0x20 || ch === 0x09) flags |= C_SPACE | C_BLANK;
    if (ch === 0x0a || ch === 0x0d || ch === 0x0b || ch === 0x0c) flags |= C_SPACE;
    if (ch < 0x20 || ch === 0x7f) flags |= C_CONTROL;
    if (ch >= 0x21 && ch <= 0x7e && (flags & (C_ALPHA | C_DIGIT)) === 0) flags |= C_PUNCT;
    if (ch >= 0x41 && ch <= 0x46) flags |= C_HEX;
    if (ch >= 0x61 && ch <= 0x66) flags |= C_HEX;
    return flags;
}
