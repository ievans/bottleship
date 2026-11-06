/**
 * DXBC containers: the chunked format D3DCompile emits and ID3D11Device::Create*Shader takes.
 *
 * Header: "DXBC", a 16-byte checksum, version (1), total size, chunk count, then one offset
 * per chunk. Each chunk is a FourCC, a byte size, and its data. Only the chunks a translator
 * needs are read here: the input/output signatures (ISGN/OSGN, or the SM5 forms ISG1/OSG1
 * are not produced for shader model 4) and the token stream (SHDR, or SHEX for SM5).
 */

export interface SignatureElement {
    semantic: string;
    semanticIndex: number;
    /** D3D_NAME: 0 undefined, 1 POSITION, 6 VERTEX_ID, 8 INSTANCE_ID, 9 IS_FRONT_FACE, 64 TARGET, 65 DEPTH, … */
    systemValue: number;
    /** D3D_REGISTER_COMPONENT_TYPE: 1 uint32, 2 sint32, 3 float32. */
    componentType: number;
    register: number;
    /** Components the register carries. */
    mask: number;
    /** Components the shader reads (input) or never writes (output). */
    rwMask: number;
}

export interface DxbcContainer {
    chunks: Map<string, Uint8Array>;
    inputs: SignatureElement[];
    outputs: SignatureElement[];
    /** The SHDR/SHEX token stream, as dwords. */
    tokens: Uint32Array;
}

const fourCC = (b: Uint8Array, o: number): string =>
    String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

export function parseSignature(chunk: Uint8Array | undefined): SignatureElement[] {
    if (!chunk || chunk.length < 8) return [];
    const v = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const count = v.getUint32(0, true);
    const out: SignatureElement[] = [];
    for (let i = 0; i < count; i++) {
        const e = 8 + i * 24;
        if (e + 24 > chunk.length) break;
        const nameOffset = v.getUint32(e, true);
        let semantic = "";
        for (let p = nameOffset; p < chunk.length && chunk[p] !== 0; p++) semantic += String.fromCharCode(chunk[p]!);
        out.push({
            semantic,
            semanticIndex: v.getUint32(e + 4, true),
            systemValue: v.getUint32(e + 8, true),
            componentType: v.getUint32(e + 12, true),
            register: v.getUint32(e + 16, true),
            mask: chunk[e + 20]!,
            rwMask: chunk[e + 21]!,
        });
    }
    return out;
}

export function parseDxbc(bytes: Uint8Array): DxbcContainer {
    if (bytes.length < 32 || fourCC(bytes, 0) !== "DXBC") throw new Error("not a DXBC container");
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = v.getUint32(28, true);
    const chunks = new Map<string, Uint8Array>();
    for (let i = 0; i < count; i++) {
        const off = v.getUint32(32 + i * 4, true);
        if (off + 8 > bytes.length) throw new Error(`DXBC chunk ${i} out of range`);
        const size = v.getUint32(off + 4, true);
        chunks.set(fourCC(bytes, off), bytes.subarray(off + 8, Math.min(off + 8 + size, bytes.length)));
    }
    const code = chunks.get("SHDR") ?? chunks.get("SHEX");
    if (!code) throw new Error("DXBC has no SHDR/SHEX chunk");
    const tokens = new Uint32Array(code.byteLength >>> 2);
    const cv = new DataView(code.buffer, code.byteOffset, code.byteLength);
    for (let i = 0; i < tokens.length; i++) tokens[i] = cv.getUint32(i * 4, true);
    return { chunks, inputs: parseSignature(chunks.get("ISGN")), outputs: parseSignature(chunks.get("OSGN")), tokens };
}
