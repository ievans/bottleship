/**
 * SM4 -> WGSL translation of hand-assembled token streams (no game bytecode in the repo).
 * Operand tokens: bits 0-1 component count (1 = one, 2 = four), 2-3 selection mode
 * (0 mask, 1 swizzle), 4-11 mask/swizzle, 12-19 operand type, 20-21 index dimension.
 */
import { describe, expect, test } from "bun:test";
import { translateShader } from "../../src/worker/backends/webgpu/d3d11/sm4/wgsl";
import type { DxbcContainer } from "../../src/worker/backends/webgpu/d3d11/sm4/dxbc";

const TEMP = 0, OUTPUT = 2, IMM32 = 4, NULL = 13;
const op = (code: number, len: number) => (code | (len << 24)) >>> 0;
const masked = (type: number, mask: number, index: number) => [(2 | (mask << 4) | (type << 12) | (1 << 20)) >>> 0, index];
const swizzled = (type: number, swz: [number, number, number, number], index: number) =>
    [(2 | (1 << 2) | ((swz[0] | (swz[1] << 2) | (swz[2] << 4) | (swz[3] << 6)) << 4) | (type << 12) | (1 << 20)) >>> 0, index];
const nullDest = () => [(NULL << 12) >>> 0];
const scalar = (v: number) => [(1 | (IMM32 << 12)) >>> 0, new Uint32Array(new Float32Array([v]).buffer)[0]!];

/** ps_4_0 with one float4 SV_Target0, the given body between dcl_temps 1 and ret. */
function pixelShader(body: number[]): DxbcContainer {
    const t = [
        op(104, 2), 1,                              // dcl_temps 1
        op(101, 3), ...masked(OUTPUT, 0xf, 0),      // dcl_output o0.xyzw
        ...body,
        op(62, 1),                                  // ret
    ];
    const tokens = new Uint32Array([0x40, t.length + 2, ...t]);
    return {
        chunks: new Map(), inputs: [], tokens,
        outputs: [{ semantic: "SV_Target", semanticIndex: 0, systemValue: 64, componentType: 3, register: 0, mask: 0xf, rwMask: 0 }],
    };
}

const MOV_O0_FROM_R0 = [op(54, 5), ...masked(OUTPUT, 0xf, 0), ...swizzled(TEMP, [0, 1, 0, 0], 0)];

describe("SM4 translation: SINCOS", () => {
    test("both destinations, one source", () => {
        const sincos = [op(77, 7), ...masked(TEMP, 0x1, 0), ...masked(TEMP, 0x2, 0), ...scalar(0.5)];
        const { wgsl } = translateShader(pixelShader([...sincos, ...MOV_O0_FROM_R0]), 1);
        expect(wgsl).toContain("sin(0.5");
        expect(wgsl).toContain("cos(0.5");
    });

    test("a null destination is skipped", () => {
        const sinOnly = [op(77, 6), ...masked(TEMP, 0x1, 0), ...nullDest(), ...scalar(0.25)];
        const { wgsl } = translateShader(pixelShader([...sinOnly, ...MOV_O0_FROM_R0]), 1);
        expect(wgsl).toContain("sin(0.25");
        expect(wgsl).not.toContain("cos(");
    });
});

describe("SM4 translation: non-finite immediates", () => {
    // WGSL evaluates bitcast<f32>(literal) at compile time and rejects NaN or infinity, so a
    // shader that moves 0xffffffff (a common all-ones mask) must not become one.
    const bits = (u: number) => [(1 | (IMM32 << 12)) >>> 0, u >>> 0];

    test("a raw move of an all-ones mask keeps its bits through a runtime call", () => {
        const mov = [op(54, 5), ...masked(TEMP, 0x8, 0), ...bits(0xffffffff)];
        const { wgsl } = translateShader(pixelShader([...mov, ...MOV_O0_FROM_R0]), 1);
        expect(wgsl).toContain("fn bits_f32(b: u32) -> f32");
        expect(wgsl).toContain("bits_f32(4294967295u)");
        expect(wgsl).not.toMatch(/bitcast<f32>\(\d+u\)/);
    });

    test("NaN and infinity used as floats go through the same call", () => {
        const add = [op(0, 7), ...masked(TEMP, 0x1, 0), ...bits(0x7fc00000), ...bits(0x7f800000)];
        const { wgsl } = translateShader(pixelShader([...add, ...MOV_O0_FROM_R0]), 1);
        expect(wgsl).toContain("bits_f32(2143289344u)");
        expect(wgsl).toContain("bits_f32(2139095040u)");
        expect(wgsl).not.toMatch(/bitcast<f32>\(\d+u\)/);
    });
});
