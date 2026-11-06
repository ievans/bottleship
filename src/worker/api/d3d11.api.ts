import { FunctionDescriptor, ModuleDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] =>
    Array.from({ length: count }, (_, i) => ({ name: `arg${i}`, type: "u32" as const }));

const makeFunc = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
    onUnimplemented: "zero",
});

/**
 * Direct3D 11 (d3d11.dll). Rise of Nations: Extended Edition's renderer, d3dgl.dll, imports
 * only D3D11CreateDevice; declaring the entry points lets it load.
 */
export const d3d11Module: ModuleDescriptor = {
    name: "d3d11",
    description: "Direct3D 11",
    functions: [
        // HRESULT D3D11CreateDevice(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE Software, UINT Flags,
        //     const D3D_FEATURE_LEVEL*, UINT FeatureLevels, UINT SDKVersion, ID3D11Device**,
        //     D3D_FEATURE_LEVEL*, ID3D11DeviceContext**)
        { ...makeFunc("D3D11CreateDevice", 10), async: true },
        // ... plus const DXGI_SWAP_CHAIN_DESC*, IDXGISwapChain** after SDKVersion
        makeFunc("D3D11CreateDeviceAndSwapChain", 12),
    ],
};
