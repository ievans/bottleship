/**
 * Shader model 4 token-stream decoder (d3d10tokenizedprogramformat.hpp).
 *
 * The stream opens with a version token (program type in bits 16-31, major/minor in bits
 * 4-7 / 0-3) and a length token, then instructions. An instruction's first token carries the
 * opcode (bits 0-10), its length in dwords (bits 24-30) and, in bit 31, whether extended
 * opcode tokens follow. Operands follow: a token describing type, component selection and
 * index layout, an optional extended token (source modifiers), then the indices and, for
 * immediates, the values.
 */

export const enum ProgramType { Pixel = 0, Vertex = 1, Geometry = 2 }

export const enum Op {
    ADD = 0, AND = 1, BREAK = 2, BREAKC = 3, CALL = 4, CALLC = 5, CASE = 6, CONTINUE = 7, CONTINUEC = 8,
    CUT = 9, DEFAULT = 10, DERIV_RTX = 11, DERIV_RTY = 12, DISCARD = 13, DIV = 14, DP2 = 15, DP3 = 16,
    DP4 = 17, ELSE = 18, EMIT = 19, EMITTHENCUT = 20, ENDIF = 21, ENDLOOP = 22, ENDSWITCH = 23, EQ = 24,
    EXP = 25, FRC = 26, FTOI = 27, FTOU = 28, GE = 29, IADD = 30, IF = 31, IEQ = 32, IGE = 33, ILT = 34,
    IMAD = 35, IMAX = 36, IMIN = 37, IMUL = 38, INE = 39, INEG = 40, ISHL = 41, ISHR = 42, ITOF = 43,
    LABEL = 44, LD = 45, LD_MS = 46, LOG = 47, LOOP = 48, LT = 49, MAD = 50, MIN = 51, MAX = 52,
    CUSTOMDATA = 53, MOV = 54, MOVC = 55, MUL = 56, NE = 57, NOP = 58, NOT = 59, OR = 60, RESINFO = 61,
    RET = 62, RETC = 63, ROUND_NE = 64, ROUND_NI = 65, ROUND_PI = 66, ROUND_Z = 67, RSQ = 68, SAMPLE = 69,
    SAMPLE_C = 70, SAMPLE_C_LZ = 71, SAMPLE_L = 72, SAMPLE_D = 73, SAMPLE_B = 74, SQRT = 75, SWITCH = 76,
    SINCOS = 77, UDIV = 78, ULT = 79, UGE = 80, UMUL = 81, UMAD = 82, UMAX = 83, UMIN = 84, USHR = 85,
    UTOF = 86, XOR = 87,
    DCL_RESOURCE = 88, DCL_CONSTANT_BUFFER = 89, DCL_SAMPLER = 90, DCL_INDEX_RANGE = 91,
    DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY = 92, DCL_GS_INPUT_PRIMITIVE = 93, DCL_MAX_OUTPUT_VERTEX_COUNT = 94,
    DCL_INPUT = 95, DCL_INPUT_SGV = 96, DCL_INPUT_SIV = 97, DCL_INPUT_PS = 98, DCL_INPUT_PS_SGV = 99,
    DCL_INPUT_PS_SIV = 100, DCL_OUTPUT = 101, DCL_OUTPUT_SGV = 102, DCL_OUTPUT_SIV = 103, DCL_TEMPS = 104,
    DCL_INDEXABLE_TEMP = 105, DCL_GLOBAL_FLAGS = 106,
}

export const enum OperandType {
    Temp = 0, Input = 1, Output = 2, IndexableTemp = 3, Imm32 = 4, Imm64 = 5, Sampler = 6, Resource = 7,
    ConstantBuffer = 8, ImmediateConstantBuffer = 9, Label = 10, InputPrimitiveId = 11, OutputDepth = 12,
    Null = 13,
}

export interface OperandIndex {
    imm: number;
    rel?: Operand;
}

export interface Operand {
    type: number;
    /** 0, 1 or 4 components. */
    components: number;
    /** Write mask (dest) — bit i = component i. */
    mask: number;
    /** Component each lane reads (source). For select1 all four are the same. */
    swizzle: [number, number, number, number];
    indices: OperandIndex[];
    neg: boolean;
    abs: boolean;
    /** Raw 32-bit immediate values. */
    imm?: number[];
}

export interface Instruction {
    op: number;
    saturate: boolean;
    /** The conditional's test: true = non-zero. */
    testNonZero: boolean;
    operands: Operand[];
    /** sample_* texel offsets (extended opcode token, type 1). */
    offset?: [number, number, number];
    /** Declaration payloads. */
    resourceDimension?: number;
    resourceReturnType?: number;
    systemValue?: number;
    interpolation?: number;
    count?: number;
    /** dcl_indexable_temp: register, size, components. */
    indexable?: { reg: number; size: number; components: number };
    /** Immediate constant buffer data (customdata class 3). */
    icb?: number[];
    /** GS topology / primitive (opcode-token field). */
    primitive?: number;
    /** Opcode-specific controls, bits 11-23 of the opcode token (dcl_sampler mode, resinfo return type, …). */
    controls: number;
}

export interface Program {
    type: ProgramType;
    major: number;
    minor: number;
    instructions: Instruction[];
}

const IDENTITY: [number, number, number, number] = [0, 1, 2, 3];

function decodeOperand(t: Uint32Array, p: { i: number }): Operand {
    const tok = t[p.i++]!;
    const numComp = tok & 3;
    const components = numComp === 0 ? 0 : numComp === 1 ? 1 : 4;
    const mode = (tok >>> 2) & 3;
    let mask = 0xf;
    let swizzle: [number, number, number, number] = [...IDENTITY] as [number, number, number, number];
    if (components === 4) {
        if (mode === 0) mask = (tok >>> 4) & 0xf;
        else if (mode === 1) swizzle = [(tok >>> 4) & 3, (tok >>> 6) & 3, (tok >>> 8) & 3, (tok >>> 10) & 3];
        else if (mode === 2) { const c = (tok >>> 4) & 3; swizzle = [c, c, c, c]; mask = 1 << c; }
    } else if (components === 1) {
        mask = 1;
        swizzle = [0, 0, 0, 0];
    }
    const type = (tok >>> 12) & 0xff;
    const indexDim = (tok >>> 20) & 3;
    let neg = false, abs = false;
    if (tok & 0x80000000) {
        const ext = t[p.i++]!;
        if ((ext & 0x3f) === 1) {
            const mod = (ext >>> 6) & 0xff;
            neg = mod === 1 || mod === 3;
            abs = mod === 2 || mod === 3;
        }
    }
    const indices: OperandIndex[] = [];
    for (let d = 0; d < indexDim; d++) {
        const rep = (tok >>> (22 + d * 3)) & 7;
        if (rep === 0) indices.push({ imm: t[p.i++]! });
        else if (rep === 1) { indices.push({ imm: t[p.i]! }); p.i += 2; }
        else if (rep === 2) indices.push({ imm: 0, rel: decodeOperand(t, p) });
        else if (rep === 3) { const imm = t[p.i++]!; indices.push({ imm, rel: decodeOperand(t, p) }); }
        else throw new Error(`unsupported operand index representation ${rep}`);
    }
    let imm: number[] | undefined;
    if (type === OperandType.Imm32) {
        imm = [];
        for (let c = 0; c < components; c++) imm.push(t[p.i++]!);
    } else if (type === OperandType.Imm64) {
        throw new Error("64-bit immediates are shader model 5");
    }
    return { type, components, mask, swizzle, indices, neg, abs, imm };
}

export function decodeProgram(t: Uint32Array): Program {
    const version = t[0]!;
    const length = Math.min(t[1]!, t.length);
    const program: Program = {
        type: (version >>> 16) as ProgramType,
        major: (version >>> 4) & 0xf,
        minor: version & 0xf,
        instructions: [],
    };
    let i = 2;
    while (i < length) {
        const tok = t[i]!;
        const op = tok & 0x7ff;
        if (op === Op.CUSTOMDATA) {
            const len = t[i + 1]!;
            const cls = tok >>> 11;
            if (cls === 3) program.instructions.push({ op, saturate: false, testNonZero: false, operands: [], controls: cls, icb: Array.from(t.subarray(i + 2, i + len)) });
            i += Math.max(len, 2);
            continue;
        }
        const len = (tok >>> 24) & 0x7f;
        if (len === 0) throw new Error(`zero-length instruction (opcode ${op}) at dword ${i}`);
        const end = i + len;
        const ins: Instruction = {
            op, saturate: ((tok >>> 13) & 1) === 1, testNonZero: ((tok >>> 18) & 1) === 1, operands: [],
            controls: (tok >>> 11) & 0x1fff,
        };
        const p = { i: i + 1 };
        let extended = (tok & 0x80000000) !== 0;
        while (extended) {
            const ext = t[p.i++]!;
            extended = (ext & 0x80000000) !== 0;
            if ((ext & 0x3f) === 1) {
                const s4 = (v: number) => (v & 8 ? v - 16 : v);
                ins.offset = [s4((ext >>> 9) & 0xf), s4((ext >>> 13) & 0xf), s4((ext >>> 17) & 0xf)];
            }
        }
        switch (op) {
            case Op.DCL_GLOBAL_FLAGS:
                break;
            case Op.DCL_TEMPS:
                ins.count = t[p.i]!;
                break;
            case Op.DCL_MAX_OUTPUT_VERTEX_COUNT:
                ins.count = t[p.i]!;
                break;
            case Op.DCL_INDEXABLE_TEMP:
                ins.indexable = { reg: t[p.i]!, size: t[p.i + 1]!, components: t[p.i + 2]! };
                break;
            case Op.DCL_GS_INPUT_PRIMITIVE:
            case Op.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY:
                ins.primitive = (tok >>> 11) & 0x3f;
                break;
            case Op.DCL_RESOURCE:
                ins.resourceDimension = (tok >>> 11) & 0x1f;
                ins.operands.push(decodeOperand(t, p));
                ins.resourceReturnType = t[p.i]! & 0xf;
                break;
            case Op.DCL_INPUT_SGV: case Op.DCL_INPUT_SIV:
            case Op.DCL_OUTPUT_SGV: case Op.DCL_OUTPUT_SIV:
                ins.operands.push(decodeOperand(t, p));
                ins.systemValue = t[p.i]!;
                break;
            case Op.DCL_INPUT_PS:
                ins.interpolation = (tok >>> 11) & 0xf;
                ins.operands.push(decodeOperand(t, p));
                break;
            case Op.DCL_INPUT_PS_SGV: case Op.DCL_INPUT_PS_SIV:
                ins.interpolation = (tok >>> 11) & 0xf;
                ins.operands.push(decodeOperand(t, p));
                ins.systemValue = t[p.i]!;
                break;
            case Op.DCL_INDEX_RANGE:
                ins.operands.push(decodeOperand(t, p));
                ins.count = t[p.i]!;
                break;
            default:
                while (p.i < end) ins.operands.push(decodeOperand(t, p));
        }
        program.instructions.push(ins);
        i = end;
    }
    return program;
}
