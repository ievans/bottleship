/**
 * Shader model 4 → WGSL.
 *
 * SM4 registers are typeless 4×32-bit; each instruction decides how its sources are read.
 * Every register here is a `vec4<f32>` and integer instructions bitcast in and out, so a
 * value moved between registers keeps its bits whatever it holds.
 *
 * Bindings: one bind group per stage (`group`). Constant buffer b → binding b, texture t →
 * 16 + t, sampler s → 160 + s.
 *
 * Linkage: D3D11 matches a vertex shader's outputs to the pixel shader's inputs by semantic;
 * WebGPU matches by location. A pixel shader's inputs keep their register numbers as
 * locations, and `pixelLinkage()` turns its signature into the map a vertex shader is then
 * translated against — so the pair is linked at pipeline time, not at shader creation.
 */

import type { DxbcContainer, SignatureElement } from "./dxbc";
import { decodeProgram, type Instruction, Op, type Operand, OperandType, ProgramType, type Program } from "./decode";

export const CB_BINDING_BASE = 0;
export const TEXTURE_BINDING_BASE = 16;
export const SAMPLER_BINDING_BASE = 160;

export interface LinkSlot { location: number; interpolation: string }
/** Semantic key (`TEXCOORD0`, upper case) → where the pixel shader reads it. */
export type StageLinkage = Map<string, LinkSlot>;

export interface TextureBinding { slot: number; viewDimension: GPUTextureViewDimension; sampleType: GPUTextureSampleType; multisampled: boolean }
export interface ShaderBindings {
    /** Constant buffer slot → size in bytes the shader declares. */
    cbuffers: Map<number, number>;
    textures: TextureBinding[];
    samplers: Array<{ slot: number; comparison: boolean }>;
}

export interface TranslatedShader {
    stage: "vertex" | "fragment";
    wgsl: string;
    bindings: ShaderBindings;
    inputs: SignatureElement[];
    outputs: SignatureElement[];
}

export class UnsupportedShader extends Error {}

export const semanticKey = (e: SignatureElement): string => `${e.semantic.toUpperCase()}${e.semanticIndex}`;

const INTERPOLATION: Record<number, string> = {
    1: "@interpolate(flat)",
    2: "",
    3: "@interpolate(perspective, centroid)",
    4: "@interpolate(linear)",
    5: "@interpolate(linear, centroid)",
    6: "@interpolate(perspective, sample)",
    7: "@interpolate(linear, sample)",
};

/** The linkage a vertex shader must write to feed this pixel shader. */
export function pixelLinkage(ps: DxbcContainer): StageLinkage {
    const program = decodeProgram(ps.tokens);
    const interp = new Map<number, number>();
    for (const ins of program.instructions) {
        if (ins.op === Op.DCL_INPUT_PS || ins.op === Op.DCL_INPUT_PS_SIV || ins.op === Op.DCL_INPUT_PS_SGV) {
            interp.set(ins.operands[0]!.indices[0]!.imm, ins.interpolation ?? 2);
        }
    }
    const link: StageLinkage = new Map();
    for (const e of ps.inputs) {
        if (e.systemValue !== 0) continue;
        link.set(semanticKey(e), { location: e.register, interpolation: INTERPOLATION[interp.get(e.register) ?? 2] ?? "" });
    }
    return link;
}

const C = "xyzw";
type Kind = "f" | "i" | "u";
const scalarOf = (k: Kind) => (k === "f" ? "f32" : k === "i" ? "i32" : "u32");
const ty = (k: Kind, n: number) => (n === 1 ? scalarOf(k) : `vec${n}<${scalarOf(k)}>`);

function floatLiteral(bits: number): string {
    const f = new Float32Array(new Uint32Array([bits >>> 0]).buffer)[0]!;
    if (!Number.isFinite(f) || (f !== 0 && Math.abs(f) < 1.1754943508222875e-38)) return `bits_f32(${bits >>> 0}u)`;
    if (Object.is(f, -0)) return "-0.0";
    const s = String(f);
    return /[.eE]/.test(s) ? s : `${s}.0`;
}

function maskLanes(mask: number): number[] {
    const out: number[] = [];
    for (let c = 0; c < 4; c++) if (mask & (1 << c)) out.push(c);
    return out;
}

/** Map a resource dimension (D3D10_SB_RESOURCE_DIMENSION) to WGSL. */
function textureShape(dim: number): { view: GPUTextureViewDimension; wgsl: string; coords: number; array: boolean; ms: boolean } {
    switch (dim) {
        case 2: return { view: "1d", wgsl: "texture_1d", coords: 1, array: false, ms: false };
        case 3: return { view: "2d", wgsl: "texture_2d", coords: 2, array: false, ms: false };
        case 4: return { view: "2d", wgsl: "texture_multisampled_2d", coords: 2, array: false, ms: true };
        case 5: return { view: "3d", wgsl: "texture_3d", coords: 3, array: false, ms: false };
        case 6: return { view: "cube", wgsl: "texture_cube", coords: 3, array: false, ms: false };
        case 8: return { view: "2d-array", wgsl: "texture_2d_array", coords: 2, array: true, ms: false };
        case 10: return { view: "cube-array", wgsl: "texture_cube_array", coords: 3, array: true, ms: false };
        default: throw new UnsupportedShader(`resource dimension ${dim}`);
    }
}

class Emitter {
    private readonly lines: string[] = [];
    private depth = 1;
    private tmp = 0;
    private readonly textures = new Map<number, { dim: number; ret: number; depth: boolean }>();
    private readonly samplers = new Map<number, boolean>();
    private readonly cbuffers = new Map<number, number>();
    private temps = 0;
    private readonly indexables = new Map<number, number>();
    private icb: number[] | null = null;
    private readonly inputRegs = new Set<number>();
    private readonly outputRegs = new Set<number>();
    private outputDepth = false;

    constructor(private readonly program: Program, private readonly c: DxbcContainer) {}

    private line(s: string): void { this.lines.push("    ".repeat(this.depth) + s); }

    // ---- operands ----

    private regRef(o: Operand): string {
        const idx = (n: number) => this.indexExpr(o, n);
        switch (o.type) {
            case OperandType.Temp: return `r${o.indices[0]!.imm}`;
            case OperandType.Input: this.inputRegs.add(o.indices[0]!.imm); return `v${o.indices[0]!.imm}`;
            case OperandType.Output: this.outputRegs.add(o.indices[0]!.imm); return `o${o.indices[0]!.imm}`;
            case OperandType.IndexableTemp: return `x${o.indices[0]!.imm}[${idx(1)}]`;
            case OperandType.ConstantBuffer: return `cb${o.indices[0]!.imm}.v[${idx(1)}]`;
            case OperandType.ImmediateConstantBuffer: return `bitcast<vec4<f32>>(icb[${idx(0)}])`;
            case OperandType.OutputDepth: this.outputDepth = true; return "oDepth";
            default: throw new UnsupportedShader(`operand type ${o.type}`);
        }
    }

    private indexExpr(o: Operand, n: number): string {
        const ix = o.indices[n]!;
        if (!ix.rel) return `${ix.imm}`;
        const r = this.source(ix.rel, [ix.rel.swizzle[0]!], "u");
        return ix.imm ? `(${r} + ${ix.imm}u)` : r;
    }

    /** A source read as `kind`, one lane per entry of `lanes` (dest components). */
    private source(o: Operand, lanes: number[], kind: Kind): string {
        const n = lanes.length;
        let e: string;
        if (o.type === OperandType.Imm32) {
            const vals = lanes.map((l) => o.imm![o.components === 1 ? 0 : o.swizzle[l]!]! >>> 0);
            const lit = (v: number) => (kind === "f" ? floatLiteral(v) : kind === "i" ? `${v | 0}i` : `${v}u`);
            e = n === 1 ? lit(vals[0]!) : `${ty(kind, n)}(${vals.map(lit).join(", ")})`;
        } else {
            const base = this.regRef(o);
            const sw = lanes.map((l) => C[o.swizzle[l]!]).join("");
            const sel = o.components === 1 ? (n === 1 ? `${base}.x` : `vec${n}<f32>(${base}.x)`) : `${base}.${sw}`;
            e = kind === "f" ? sel : `bitcast<${ty(kind, n)}>(${sel})`;
        }
        if (o.abs) e = `abs(${e})`;
        if (o.neg) e = kind === "u" ? `(${ty("u", n)}(0u) - ${e})` : `-(${e})`;
        return e;
    }

    /** A raw (bit-preserving) source, as vecN<f32>. */
    private raw(o: Operand, lanes: number[]): string {
        if (o.type === OperandType.Imm32 && !o.abs && !o.neg) {
            const vals = lanes.map((l) => `${o.imm![o.components === 1 ? 0 : o.swizzle[l]!]! >>> 0}u`);
            return lanes.length === 1 ? `bits_f32(${vals[0]})` : `vec${lanes.length}<f32>(${vals.map((v) => `bits_f32(${v})`).join(", ")})`;
        }
        return this.source(o, lanes, "f");
    }

    private cond(o: Operand, nz: boolean): string {
        return `(bitcast<u32>(${this.source(o, [o.swizzle[0]!], "f")}) ${nz ? "!=" : "=="} 0u)`;
    }

    /** Write `value` (vecN of `kind`) into the dest's masked lanes. */
    private write(dest: Operand, value: string, kind: Kind, saturate: boolean, lanes = maskLanes(dest.mask)): void {
        if (dest.type === OperandType.Null || lanes.length === 0) return;
        let v = kind === "f" ? value : `bitcast<${ty("f", lanes.length)}>(${value})`;
        if (saturate) v = `clamp(${v}, ${ty("f", lanes.length)}(0.0), ${ty("f", lanes.length)}(1.0))`;
        const target = this.regRef(dest);
        if (dest.type === OperandType.OutputDepth) { this.line(`oDepth = ${v};`); return; }
        if (lanes.length === 4) { this.line(`${target} = ${v};`); return; }
        if (lanes.length === 1) { this.line(`${target}.${C[lanes[0]!]} = ${v};`); return; }
        const t = `tmp${this.tmp++}`;
        this.line(`let ${t} = ${v};`);
        lanes.forEach((l, i) => this.line(`${target}.${C[l]} = ${t}.${C[i]};`));
    }

    // ---- instructions ----

    private unary(ins: Instruction, fn: (a: string) => string, kind: Kind = "f", out: Kind = kind): void {
        const [d, a] = ins.operands as [Operand, Operand];
        const lanes = maskLanes(d.mask);
        this.write(d, fn(this.source(a, lanes, kind)), out, ins.saturate);
    }

    private binary(ins: Instruction, fn: (a: string, b: string) => string, kind: Kind = "f", out: Kind = kind): void {
        const [d, a, b] = ins.operands as [Operand, Operand, Operand];
        const lanes = maskLanes(d.mask);
        this.write(d, fn(this.source(a, lanes, kind), this.source(b, lanes, kind)), out, ins.saturate);
    }

    private compare(ins: Instruction, op: string, kind: Kind): void {
        const [d, a, b] = ins.operands as [Operand, Operand, Operand];
        const lanes = maskLanes(d.mask);
        const n = lanes.length;
        const cmp = `(${this.source(a, lanes, kind)} ${op} ${this.source(b, lanes, kind)})`;
        this.write(d, `select(${ty("u", n)}(0u), ${ty("u", n)}(0xffffffffu), ${cmp})`, "u", false);
    }

    private dot(ins: Instruction, n: number): void {
        const [d, a, b] = ins.operands as [Operand, Operand, Operand];
        const lanes = [0, 1, 2, 3].slice(0, n);
        const dp = `dot(${this.source(a, lanes, "f")}, ${this.source(b, lanes, "f")})`;
        const out = maskLanes(d.mask);
        this.write(d, out.length === 1 ? dp : `${ty("f", out.length)}(${dp})`, "f", ins.saturate);
    }

    private textureOperands(resource: Operand): { name: string; shape: ReturnType<typeof textureShape> } {
        const slot = resource.indices[0]!.imm;
        const t = this.textures.get(slot);
        if (!t) throw new UnsupportedShader(`t${slot} used without dcl_resource`);
        return { name: `t${slot}`, shape: textureShape(t.dim) };
    }

    private coordArgs(coord: Operand, shape: ReturnType<typeof textureShape>): string {
        const lanes = [0, 1, 2].slice(0, shape.coords);
        const xy = this.source(coord, lanes, "f");
        if (!shape.array) return xy;
        const layer = this.source(coord, [shape.coords], "f");
        return `${xy}, i32(round(${layer}))`;
    }

    private offsetArg(ins: Instruction, shape: ReturnType<typeof textureShape>): string {
        if (!ins.offset || (ins.offset[0] === 0 && ins.offset[1] === 0 && ins.offset[2] === 0)) return "";
        if (shape.view === "cube" || shape.view === "cube-array") return "";
        const n = shape.view === "3d" ? 3 : shape.view === "1d" ? 1 : 2;
        const o = ins.offset.slice(0, n);
        return n === 1 ? "" : `, vec${n}<i32>(${o.join(", ")})`;
    }

    /** Swizzle a vec4 texel by the resource operand and keep the dest lanes. */
    private texelToDest(ins: Instruction, d: Operand, texel: string, resource: Operand): void {
        const lanes = maskLanes(d.mask);
        const t = `tmp${this.tmp++}`;
        this.line(`let ${t} = ${texel};`);
        const sw = lanes.map((l) => C[resource.swizzle[l]!]).join("");
        this.write(d, `${t}.${sw}`, "f", ins.saturate);
    }

    private sample(ins: Instruction): void {
        const [d, coord, res, smp] = ins.operands as [Operand, Operand, Operand, Operand];
        const { name, shape } = this.textureOperands(res);
        const s = `s${smp.indices[0]!.imm}`;
        const args = `${name}, ${s}, ${this.coordArgs(coord, shape)}`;
        const off = this.offsetArg(ins, shape);
        let call: string;
        switch (ins.op) {
            case Op.SAMPLE: call = `textureSample(${args}${off})`; break;
            case Op.SAMPLE_L: call = `textureSampleLevel(${args}, ${this.source(ins.operands[4]!, [0], "f")}${off})`; break;
            case Op.SAMPLE_B: call = `textureSampleBias(${args}, ${this.source(ins.operands[4]!, [0], "f")}${off})`; break;
            case Op.SAMPLE_D: {
                const lanes = [0, 1, 2].slice(0, shape.coords);
                call = `textureSampleGrad(${args}, ${this.source(ins.operands[4]!, lanes, "f")}, ${this.source(ins.operands[5]!, lanes, "f")}${off})`;
                break;
            }
            default: throw new UnsupportedShader(`sample opcode ${ins.op}`);
        }
        this.texelToDest(ins, d, call, res);
    }

    private sampleCompare(ins: Instruction): void {
        const [d, coord, res, smp, ref] = ins.operands as [Operand, Operand, Operand, Operand, Operand];
        const slot = res.indices[0]!.imm;
        this.textures.get(slot)!.depth = true;
        this.samplers.set(smp.indices[0]!.imm, true);
        const { name, shape } = this.textureOperands(res);
        const fn = ins.op === Op.SAMPLE_C_LZ ? "textureSampleCompareLevel" : "textureSampleCompare";
        const v = `${fn}(${name}, s${smp.indices[0]!.imm}, ${this.coordArgs(coord, shape)}, ${this.source(ref, [0], "f")}${this.offsetArg(ins, shape)})`;
        const lanes = maskLanes(d.mask);
        this.write(d, lanes.length === 1 ? v : `${ty("f", lanes.length)}(${v})`, "f", ins.saturate);
    }

    private load(ins: Instruction): void {
        const [d, coord, res] = ins.operands as [Operand, Operand, Operand];
        const { name, shape } = this.textureOperands(res);
        const n = shape.coords;
        const c = this.source(coord, [0, 1, 2].slice(0, n), "i");
        const extra = shape.array ? `, ${this.source(coord, [n], "i")}` : "";
        const mip = shape.ms ? `, ${this.source(ins.operands[3]!, [0], "i")}` : `, ${this.source(coord, [n + (shape.array ? 1 : 0)], "i")}`;
        const ret = this.textures.get(res.indices[0]!.imm)!.ret;
        let texel = `textureLoad(${name}, ${c}${extra}${mip})`;
        if (ret === 3 || ret === 4) texel = `bitcast<vec4<f32>>(${texel})`;
        this.texelToDest(ins, d, texel, res);
    }

    private resinfo(ins: Instruction, retType: number): void {
        const [d, mip, res] = ins.operands as [Operand, Operand, Operand];
        const { name, shape } = this.textureOperands(res);
        const m = this.source(mip, [0], "u");
        const size = `textureDimensions(${name}, ${m})`;
        const levels = `textureNumLevels(${name})`;
        const full = shape.coords === 1 ? `vec4<u32>(${size}, 1u, 1u, ${levels})`
            : shape.coords === 2 ? `vec4<u32>(${size}, ${shape.array ? `textureNumLayers(${name})` : "1u"}, ${levels})`
            : `vec4<u32>(${size}, ${levels})`;
        const lanes = maskLanes(d.mask);
        const t = `tmp${this.tmp++}`;
        this.line(`let ${t} = ${full};`);
        const sw = lanes.map((l) => C[res.swizzle[l]!]).join("");
        if (retType === 2) this.write(d, `${t}.${sw}`, "u", false);
        else if (retType === 1) this.write(d, `1.0 / vec4<f32>(${t}).${sw}`, "f", ins.saturate);
        else this.write(d, `vec4<f32>(${t}).${sw}`, "f", ins.saturate);
    }

    private twoDest(ins: Instruction, fn: (a: string, b: string, c: string) => [string, string] , kind: Kind): void {
        const [d0, d1, a, b, c] = ins.operands as Operand[];
        for (const [i, d] of [d0!, d1!].entries()) {
            if (d.type === OperandType.Null) continue;
            const lanes = maskLanes(d.mask);
            // SINCOS has one source; UDIV/IMUL/UMUL two.
            const pair = fn(this.source(a!, lanes, kind), b ? this.source(b, lanes, kind) : "", c ? this.source(c, lanes, kind) : "");
            this.write(d, pair[i]!, kind, false);
        }
    }

    private instruction(ins: Instruction): void {
        const o = ins.operands;
        switch (ins.op) {
            case Op.MOV: {
                const lanes = maskLanes(o[0]!.mask);
                this.write(o[0]!, this.raw(o[1]!, lanes), "f", ins.saturate);
                break;
            }
            case Op.MOVC: {
                const lanes = maskLanes(o[0]!.mask);
                const n = lanes.length;
                const test = `(${this.source(o[1]!, lanes, "u")} != ${ty("u", n)}(0u))`;
                this.write(o[0]!, `select(${this.raw(o[3]!, lanes)}, ${this.raw(o[2]!, lanes)}, ${test})`, "f", ins.saturate);
                break;
            }
            case Op.ADD: this.binary(ins, (a, b) => `${a} + ${b}`); break;
            case Op.MUL: this.binary(ins, (a, b) => `${a} * ${b}`); break;
            case Op.DIV: this.binary(ins, (a, b) => `${a} / ${b}`); break;
            case Op.MIN: this.binary(ins, (a, b) => `min(${a}, ${b})`); break;
            case Op.MAX: this.binary(ins, (a, b) => `max(${a}, ${b})`); break;
            case Op.MAD: {
                const [d, a, b, c] = o as [Operand, Operand, Operand, Operand];
                const lanes = maskLanes(d.mask);
                this.write(d, `fma(${this.source(a, lanes, "f")}, ${this.source(b, lanes, "f")}, ${this.source(c, lanes, "f")})`, "f", ins.saturate);
                break;
            }
            case Op.FRC: this.unary(ins, (a) => `fract(${a})`); break;
            case Op.EXP: this.unary(ins, (a) => `exp2(${a})`); break;
            case Op.LOG: this.unary(ins, (a) => `log2(${a})`); break;
            case Op.RSQ: this.unary(ins, (a) => `inverseSqrt(${a})`); break;
            case Op.SQRT: this.unary(ins, (a) => `sqrt(${a})`); break;
            case Op.ROUND_NE: this.unary(ins, (a) => `round(${a})`); break;
            case Op.ROUND_NI: this.unary(ins, (a) => `floor(${a})`); break;
            case Op.ROUND_PI: this.unary(ins, (a) => `ceil(${a})`); break;
            case Op.ROUND_Z: this.unary(ins, (a) => `trunc(${a})`); break;
            case Op.DERIV_RTX: this.unary(ins, (a) => `dpdx(${a})`); break;
            case Op.DERIV_RTY: this.unary(ins, (a) => `dpdy(${a})`); break;
            case Op.DP2: this.dot(ins, 2); break;
            case Op.DP3: this.dot(ins, 3); break;
            case Op.DP4: this.dot(ins, 4); break;
            case Op.SINCOS: this.twoDest(ins, (a) => [`sin(${a})`, `cos(${a})`], "f"); break;
            case Op.EQ: this.compare(ins, "==", "f"); break;
            case Op.NE: this.compare(ins, "!=", "f"); break;
            case Op.LT: this.compare(ins, "<", "f"); break;
            case Op.GE: this.compare(ins, ">=", "f"); break;
            case Op.IEQ: this.compare(ins, "==", "i"); break;
            case Op.INE: this.compare(ins, "!=", "i"); break;
            case Op.ILT: this.compare(ins, "<", "i"); break;
            case Op.IGE: this.compare(ins, ">=", "i"); break;
            case Op.ULT: this.compare(ins, "<", "u"); break;
            case Op.UGE: this.compare(ins, ">=", "u"); break;
            case Op.IADD: this.binary(ins, (a, b) => `${a} + ${b}`, "i"); break;
            case Op.IMAX: this.binary(ins, (a, b) => `max(${a}, ${b})`, "i"); break;
            case Op.IMIN: this.binary(ins, (a, b) => `min(${a}, ${b})`, "i"); break;
            case Op.UMAX: this.binary(ins, (a, b) => `max(${a}, ${b})`, "u"); break;
            case Op.UMIN: this.binary(ins, (a, b) => `min(${a}, ${b})`, "u"); break;
            case Op.AND: this.binary(ins, (a, b) => `${a} & ${b}`, "u"); break;
            case Op.OR: this.binary(ins, (a, b) => `${a} | ${b}`, "u"); break;
            case Op.XOR: this.binary(ins, (a, b) => `${a} ^ ${b}`, "u"); break;
            case Op.NOT: this.unary(ins, (a) => `~${a}`, "u"); break;
            case Op.INEG: this.unary(ins, (a) => `-${a}`, "i"); break;
            case Op.ISHL: {
                const [d, a, b] = o as [Operand, Operand, Operand];
                const lanes = maskLanes(d.mask);
                this.write(d, `${this.source(a, lanes, "i")} << (${this.source(b, lanes, "u")} & ${ty("u", lanes.length)}(31u))`, "i", false);
                break;
            }
            case Op.ISHR: case Op.USHR: {
                const [d, a, b] = o as [Operand, Operand, Operand];
                const lanes = maskLanes(d.mask);
                const k: Kind = ins.op === Op.ISHR ? "i" : "u";
                this.write(d, `${this.source(a, lanes, k)} >> (${this.source(b, lanes, "u")} & ${ty("u", lanes.length)}(31u))`, k, false);
                break;
            }
            case Op.IMAD: case Op.UMAD: {
                const k: Kind = ins.op === Op.IMAD ? "i" : "u";
                const [d, a, b, c] = o as [Operand, Operand, Operand, Operand];
                const lanes = maskLanes(d.mask);
                this.write(d, `${this.source(a, lanes, k)} * ${this.source(b, lanes, k)} + ${this.source(c, lanes, k)}`, k, false);
                break;
            }
            case Op.IMUL: case Op.UMUL: {
                const k: Kind = ins.op === Op.IMUL ? "i" : "u";
                if (o[0]!.type !== OperandType.Null) throw new UnsupportedShader("high half of a 32×32 multiply");
                this.twoDest(ins, (a, b) => ["", `${a} * ${b}`], k);
                break;
            }
            case Op.UDIV: this.twoDest(ins, (a, b) => [`${a} / ${b}`, `${a} % ${b}`], "u"); break;
            case Op.FTOI: case Op.FTOU: {
                const [d, a] = o as [Operand, Operand];
                const lanes = maskLanes(d.mask);
                const k: Kind = ins.op === Op.FTOI ? "i" : "u";
                this.write(d, `${ty(k, lanes.length)}(${this.source(a, lanes, "f")})`, k, false);
                break;
            }
            case Op.ITOF: case Op.UTOF: {
                const [d, a] = o as [Operand, Operand];
                const lanes = maskLanes(d.mask);
                this.write(d, `${ty("f", lanes.length)}(${this.source(a, lanes, ins.op === Op.ITOF ? "i" : "u")})`, "f", ins.saturate);
                break;
            }
            case Op.SAMPLE: case Op.SAMPLE_L: case Op.SAMPLE_B: case Op.SAMPLE_D: this.sample(ins); break;
            case Op.SAMPLE_C: case Op.SAMPLE_C_LZ: this.sampleCompare(ins); break;
            case Op.LD: case Op.LD_MS: this.load(ins); break;
            case Op.RESINFO: this.resinfo(ins, ins.controls & 3); break;
            case Op.IF: this.line(`if ${this.cond(o[0]!, ins.testNonZero)} {`); this.depth++; break;
            case Op.ELSE: this.depth--; this.line("} else {"); this.depth++; break;
            case Op.ENDIF: case Op.ENDLOOP: this.depth--; this.line("}"); break;
            case Op.LOOP: this.line("loop {"); this.depth++; break;
            case Op.BREAK: this.line("break;"); break;
            case Op.BREAKC: this.line(`if ${this.cond(o[0]!, ins.testNonZero)} { break; }`); break;
            case Op.CONTINUE: this.line("continue;"); break;
            case Op.CONTINUEC: this.line(`if ${this.cond(o[0]!, ins.testNonZero)} { continue; }`); break;
            case Op.RET: this.line("return;"); break;
            case Op.RETC: this.line(`if ${this.cond(o[0]!, ins.testNonZero)} { return; }`); break;
            case Op.DISCARD: this.line(`if ${this.cond(o[0]!, ins.testNonZero)} { discard; }`); break;
            case Op.NOP: break;
            default: throw new UnsupportedShader(`opcode ${ins.op}`);
        }
    }

    // ---- assembly ----

    translate(group: number, linkage?: StageLinkage): TranslatedShader {
        const p = this.program;
        if (p.type !== ProgramType.Vertex && p.type !== ProgramType.Pixel) throw new UnsupportedShader(`program type ${p.type}`);
        const vertex = p.type === ProgramType.Vertex;
        const sysInputs = new Map<number, number>(); // register → system value
        const inputInterp = new Map<number, number>();
        for (const ins of p.instructions) {
            switch (ins.op) {
                case Op.DCL_TEMPS: this.temps = ins.count!; break;
                case Op.DCL_INDEXABLE_TEMP: this.indexables.set(ins.indexable!.reg, ins.indexable!.size); break;
                case Op.DCL_CONSTANT_BUFFER: {
                    const cb = ins.operands[0]!;
                    this.cbuffers.set(cb.indices[0]!.imm, cb.indices[1]!.imm);
                    break;
                }
                case Op.DCL_SAMPLER: this.samplers.set(ins.operands[0]!.indices[0]!.imm, (ins.controls & 0xf) === 1); break;
                case Op.DCL_RESOURCE:
                    this.textures.set(ins.operands[0]!.indices[0]!.imm, { dim: ins.resourceDimension!, ret: ins.resourceReturnType!, depth: false });
                    break;
                case Op.CUSTOMDATA: if (ins.icb) this.icb = ins.icb; break;
                case Op.DCL_INPUT_SGV: case Op.DCL_INPUT_SIV: case Op.DCL_INPUT_PS_SGV: case Op.DCL_INPUT_PS_SIV:
                    sysInputs.set(ins.operands[0]!.indices[0]!.imm, ins.systemValue!);
                    if (ins.interpolation !== undefined) inputInterp.set(ins.operands[0]!.indices[0]!.imm, ins.interpolation);
                    break;
                case Op.DCL_INPUT_PS:
                    inputInterp.set(ins.operands[0]!.indices[0]!.imm, ins.interpolation ?? 2);
                    break;
            }
        }

        // Body first: it records which registers and resources are used.
        for (const ins of p.instructions) {
            if (ins.op >= Op.DCL_RESOURCE || ins.op === Op.CUSTOMDATA) continue;
            this.instruction(ins);
        }
        const body = this.lines;

        const out: string[] = [
            "diagnostic(off, derivative_uniformity);", "",
            // A constant's bits as f32 at run time: WGSL evaluates bitcast<f32>(literal) at
            // compile time and rejects a NaN or infinite result, but never a function call.
            "fn bits_f32(b: u32) -> f32 { return bitcast<f32>(b); }", "",
        ];
        // Resources.
        for (const [slot, size] of [...this.cbuffers].sort((a, b) => a[0] - b[0])) {
            out.push(`struct CB${slot} { v: array<vec4<f32>, ${Math.max(size, 1)}> }`);
            out.push(`@group(${group}) @binding(${CB_BINDING_BASE + slot}) var<uniform> cb${slot}: CB${slot};`);
        }
        const textureBindings: TextureBinding[] = [];
        for (const [slot, t] of [...this.textures].sort((a, b) => a[0] - b[0])) {
            const shape = textureShape(t.dim);
            const scalar = t.ret === 3 ? "i32" : t.ret === 4 ? "u32" : "f32";
            const wgslType = t.depth ? shape.wgsl.replace("texture_", "texture_depth_") : `${shape.wgsl}<${scalar}>`;
            out.push(`@group(${group}) @binding(${TEXTURE_BINDING_BASE + slot}) var t${slot}: ${wgslType};`);
            textureBindings.push({
                slot, viewDimension: shape.view, multisampled: shape.ms,
                sampleType: t.depth ? "depth" : t.ret === 3 ? "sint" : t.ret === 4 ? "uint" : "float",
            });
        }
        const samplerBindings: Array<{ slot: number; comparison: boolean }> = [];
        for (const [slot, comparison] of [...this.samplers].sort((a, b) => a[0] - b[0])) {
            out.push(`@group(${group}) @binding(${SAMPLER_BINDING_BASE + slot}) var s${slot}: ${comparison ? "sampler_comparison" : "sampler"};`);
            samplerBindings.push({ slot, comparison });
        }
        if (this.icb) {
            const n = this.icb.length >>> 2;
            const vals: string[] = [];
            for (let i = 0; i < n; i++) vals.push(`vec4<u32>(${this.icb.slice(i * 4, i * 4 + 4).map((v) => `${v >>> 0}u`).join(", ")})`);
            out.push(`var<private> icb: array<vec4<u32>, ${n}> = array<vec4<u32>, ${n}>(${vals.join(", ")});`);
        }

        // Registers.
        const inputs = this.c.inputs;
        const outputs = this.c.outputs;
        const inRegs = new Set<number>([...inputs.map((e) => e.register), ...this.inputRegs]);
        const outRegs = new Set<number>([...outputs.filter((e) => e.systemValue !== 65).map((e) => e.register), ...this.outputRegs]);
        for (const r of [...inRegs].sort((a, b) => a - b)) out.push(`var<private> v${r}: vec4<f32>;`);
        for (const r of [...outRegs].sort((a, b) => a - b)) out.push(`var<private> o${r}: vec4<f32>;`);
        if (this.outputDepth || outputs.some((e) => e.systemValue === 65)) out.push("var<private> oDepth: f32;");
        out.push("", "fn shader_body() {");
        for (let r = 0; r < this.temps; r++) out.push(`    var r${r}: vec4<f32>;`);
        for (const [x, size] of this.indexables) out.push(`    var x${x}: array<vec4<f32>, ${size}>;`);
        out.push(...body, "}", "");

        // Stage interface.
        const inFields: string[] = [];
        const inCopy: string[] = [];
        const seenIn = new Set<number>();
        for (const e of inputs) {
            if (seenIn.has(e.register)) continue;
            seenIn.add(e.register);
            const sv = sysInputs.get(e.register) ?? e.systemValue;
            const f = `i${e.register}`;
            if (vertex) {
                if (sv === 6) { inFields.push(`@builtin(vertex_index) ${f}: u32`); inCopy.push(`v${e.register}.x = bitcast<f32>(in.${f});`); }
                else if (sv === 8) { inFields.push(`@builtin(instance_index) ${f}: u32`); inCopy.push(`v${e.register}.x = bitcast<f32>(in.${f});`); }
                else {
                    const k: Kind = e.componentType === 1 ? "u" : e.componentType === 2 ? "i" : "f";
                    inFields.push(`@location(${e.register}) ${f}: ${ty(k, 4)}`);
                    inCopy.push(k === "f" ? `v${e.register} = in.${f};` : `v${e.register} = bitcast<vec4<f32>>(in.${f});`);
                }
            } else {
                if (sv === 1) { inFields.push(`@builtin(position) ${f}: vec4<f32>`); inCopy.push(`v${e.register} = in.${f};`); }
                else if (sv === 9) { inFields.push(`@builtin(front_facing) ${f}: bool`); inCopy.push(`v${e.register}.x = bitcast<f32>(select(0u, 0xffffffffu, in.${f}));`); }
                else if (sv === 10) { inFields.push(`@builtin(sample_index) ${f}: u32`); inCopy.push(`v${e.register}.x = bitcast<f32>(in.${f});`); }
                else if (sv === 0) {
                    const interp = INTERPOLATION[inputInterp.get(e.register) ?? 2] ?? "";
                    const k: Kind = e.componentType === 1 ? "u" : e.componentType === 2 ? "i" : "f";
                    const flat = k !== "f" ? "@interpolate(flat)" : interp;
                    inFields.push(`@location(${e.register}) ${flat} ${f}: ${ty(k, 4)}`.replace("  ", " "));
                    inCopy.push(k === "f" ? `v${e.register} = in.${f};` : `v${e.register} = bitcast<vec4<f32>>(in.${f});`);
                } else throw new UnsupportedShader(`pixel input system value ${sv}`);
            }
        }

        const outFields: string[] = [];
        const outCopy: string[] = [];
        const seenOut = new Set<string>();
        for (const e of outputs) {
            if (vertex) {
                if (e.systemValue === 1) { outFields.push(`@builtin(position) pos: vec4<f32>`); outCopy.push(`out.pos = o${e.register};`); continue; }
                if (e.systemValue !== 0) continue;
                const slot = linkage ? linkage.get(semanticKey(e)) : { location: e.register, interpolation: "" };
                if (!slot) continue;
                const field = `l${slot.location}`;
                if (seenOut.has(field)) continue;
                seenOut.add(field);
                // Elements packed into one register (TEXCOORD0.xy + TEXCOORD1.zw) read their own lanes.
                outFields.push(`@location(${slot.location}) ${slot.interpolation} ${field}: vec4<f32>`.replace("  ", " "));
                outCopy.push(`out.${field} = o${e.register};`);
            } else {
                if (e.systemValue === 65) { outFields.push("@builtin(frag_depth) depth: f32"); outCopy.push("out.depth = oDepth;"); continue; }
                if (e.semantic.toUpperCase() !== "SV_TARGET") continue;
                const k: Kind = e.componentType === 1 ? "u" : e.componentType === 2 ? "i" : "f";
                outFields.push(`@location(${e.semanticIndex}) c${e.semanticIndex}: ${ty(k, 4)}`);
                outCopy.push(k === "f" ? `out.c${e.semanticIndex} = o${e.register};` : `out.c${e.semanticIndex} = bitcast<${ty(k, 4)}>(o${e.register});`);
            }
        }

        // Every pixel input needs a vertex output at its location; one this shader never
        // writes reads as zero, as an unwritten D3D11 output register does.
        if (vertex && linkage) {
            for (const slot of linkage.values()) {
                const field = `l${slot.location}`;
                if (seenOut.has(field)) continue;
                seenOut.add(field);
                outFields.push(`@location(${slot.location}) ${slot.interpolation} ${field}: vec4<f32>`.replace("  ", " "));
                outCopy.push(`out.${field} = vec4<f32>(0.0);`);
            }
        }

        if (inFields.length) out.push(`struct StageIn {`, ...inFields.map((f) => `    ${f},`), `}`);
        if (outFields.length) out.push(`struct StageOut {`, ...outFields.map((f) => `    ${f},`), `}`);
        const params = inFields.length ? "in: StageIn" : "";
        const ret = outFields.length ? " -> StageOut" : "";
        out.push(`@${vertex ? "vertex" : "fragment"} fn main(${params})${ret} {`);
        out.push(...inCopy.map((l) => `    ${l}`), "    shader_body();");
        if (outFields.length) out.push("    var out: StageOut;", ...outCopy.map((l) => `    ${l}`), "    return out;");
        out.push("}");

        const cbSizes = new Map<number, number>();
        for (const [slot, size] of this.cbuffers) cbSizes.set(slot, Math.max(size, 1) * 16);
        return {
            stage: vertex ? "vertex" : "fragment",
            wgsl: out.join("\n") + "\n",
            bindings: { cbuffers: cbSizes, textures: textureBindings, samplers: samplerBindings },
            inputs, outputs,
        };
    }
}

/** Translate one shader. A vertex shader takes the linkage of the pixel shader it feeds. */
export function translateShader(c: DxbcContainer, group: number, linkage?: StageLinkage): TranslatedShader {
    return new Emitter(decodeProgram(c.tokens), c).translate(group, linkage);
}
