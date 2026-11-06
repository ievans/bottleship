/**
 * Direct3D 11 and DXGI interface layouts: every vtable slot in d3d11.h / dxgi.h order, as
 * [method, argument count including `this`]. All are __stdcall with 4-byte arguments, so a
 * slot pops argCount * 4 bytes.
 *
 * An interface's table is its base's slots followed by its own, so a vtable can be built
 * for any interface by name and a method keeps the same slot in every derived interface.
 */

export type MethodSpec = readonly [name: string, argCount: number];

const IUNKNOWN: MethodSpec[] = [["QueryInterface", 3], ["AddRef", 1], ["Release", 1]];

const D3D11_DEVICE_CHILD: MethodSpec[] = [
    ["GetDevice", 2], ["GetPrivateData", 4], ["SetPrivateData", 4], ["SetPrivateDataInterface", 3],
];

const D3D11_DEVICE: MethodSpec[] = [
    ["CreateBuffer", 4], ["CreateTexture1D", 4], ["CreateTexture2D", 4], ["CreateTexture3D", 4],
    ["CreateShaderResourceView", 4], ["CreateUnorderedAccessView", 4], ["CreateRenderTargetView", 4],
    ["CreateDepthStencilView", 4], ["CreateInputLayout", 6], ["CreateVertexShader", 5],
    ["CreateGeometryShader", 5], ["CreateGeometryShaderWithStreamOutput", 10], ["CreatePixelShader", 5],
    ["CreateHullShader", 5], ["CreateDomainShader", 5], ["CreateComputeShader", 5],
    ["CreateClassLinkage", 2], ["CreateBlendState", 3], ["CreateDepthStencilState", 3],
    ["CreateRasterizerState", 3], ["CreateSamplerState", 3], ["CreateQuery", 3], ["CreatePredicate", 3],
    ["CreateCounter", 3], ["CreateDeferredContext", 3], ["OpenSharedResource", 4],
    ["CheckFormatSupport", 3], ["CheckMultisampleQualityLevels", 4], ["CheckCounterInfo", 2],
    ["CheckCounter", 10], ["CheckFeatureSupport", 4], ["GetPrivateData", 4], ["SetPrivateData", 4],
    ["SetPrivateDataInterface", 3], ["GetFeatureLevel", 1], ["GetCreationFlags", 1],
    ["GetDeviceRemovedReason", 1], ["GetImmediateContext", 2], ["SetExceptionMode", 2],
    ["GetExceptionMode", 1],
];

/** The xSSet/xSGet families share one shape: (this, StartSlot, NumX, ppX). */
const stage = (verb: "Set" | "Get", stages: string[], what: string): MethodSpec[] =>
    stages.map((s) => [`${s}${verb}${what}`, 4] as const);

const D3D11_DEVICE_CONTEXT: MethodSpec[] = [
    ["VSSetConstantBuffers", 4], ["PSSetShaderResources", 4], ["PSSetShader", 4], ["PSSetSamplers", 4],
    ["VSSetShader", 4], ["DrawIndexed", 4], ["Draw", 3], ["Map", 6], ["Unmap", 3],
    ["PSSetConstantBuffers", 4], ["IASetInputLayout", 2], ["IASetVertexBuffers", 6],
    ["IASetIndexBuffer", 4], ["DrawIndexedInstanced", 6], ["DrawInstanced", 5],
    ["GSSetConstantBuffers", 4], ["GSSetShader", 4], ["IASetPrimitiveTopology", 2],
    ["VSSetShaderResources", 4], ["VSSetSamplers", 4], ["Begin", 2], ["End", 2], ["GetData", 5],
    ["SetPredication", 3], ["GSSetShaderResources", 4], ["GSSetSamplers", 4],
    ["OMSetRenderTargets", 4], ["OMSetRenderTargetsAndUnorderedAccessViews", 8],
    ["OMSetBlendState", 4], ["OMSetDepthStencilState", 3], ["SOSetTargets", 4], ["DrawAuto", 1],
    ["DrawIndexedInstancedIndirect", 3], ["DrawInstancedIndirect", 3], ["Dispatch", 4],
    ["DispatchIndirect", 3], ["RSSetState", 2], ["RSSetViewports", 3], ["RSSetScissorRects", 3],
    ["CopySubresourceRegion", 9], ["CopyResource", 3], ["UpdateSubresource", 7],
    ["CopyStructureCount", 4], ["ClearRenderTargetView", 3], ["ClearUnorderedAccessViewUint", 3],
    ["ClearUnorderedAccessViewFloat", 3], ["ClearDepthStencilView", 5], ["GenerateMips", 2],
    ["SetResourceMinLOD", 3], ["GetResourceMinLOD", 2], ["ResolveSubresource", 6],
    ["ExecuteCommandList", 3],
    ["HSSetShaderResources", 4], ["HSSetShader", 4], ["HSSetSamplers", 4], ["HSSetConstantBuffers", 4],
    ["DSSetShaderResources", 4], ["DSSetShader", 4], ["DSSetSamplers", 4], ["DSSetConstantBuffers", 4],
    ["CSSetShaderResources", 4], ["CSSetUnorderedAccessViews", 5], ["CSSetShader", 4],
    ["CSSetSamplers", 4], ["CSSetConstantBuffers", 4],
    ["VSGetConstantBuffers", 4], ["PSGetShaderResources", 4], ["PSGetShader", 4], ["PSGetSamplers", 4],
    ["VSGetShader", 4], ["PSGetConstantBuffers", 4], ["IAGetInputLayout", 2], ["IAGetVertexBuffers", 6],
    ["IAGetIndexBuffer", 4], ["GSGetConstantBuffers", 4], ["GSGetShader", 4],
    ["IAGetPrimitiveTopology", 2], ["VSGetShaderResources", 4], ["VSGetSamplers", 4],
    ["GetPredication", 3], ["GSGetShaderResources", 4], ["GSGetSamplers", 4],
    ["OMGetRenderTargets", 4], ["OMGetRenderTargetsAndUnorderedAccessViews", 7],
    ["OMGetBlendState", 4], ["OMGetDepthStencilState", 3], ["SOGetTargets", 3], ["RSGetState", 2],
    ["RSGetViewports", 3], ["RSGetScissorRects", 3],
    ...stage("Get", ["HS"], "ShaderResources"), ["HSGetShader", 4], ...stage("Get", ["HS"], "Samplers"),
    ...stage("Get", ["HS"], "ConstantBuffers"),
    ...stage("Get", ["DS"], "ShaderResources"), ["DSGetShader", 4], ...stage("Get", ["DS"], "Samplers"),
    ...stage("Get", ["DS"], "ConstantBuffers"),
    ["CSGetShaderResources", 4], ["CSGetUnorderedAccessViews", 4], ["CSGetShader", 4],
    ["CSGetSamplers", 4], ["CSGetConstantBuffers", 4],
    ["ClearState", 1], ["Flush", 1], ["GetType", 1], ["GetContextFlags", 1], ["FinishCommandList", 3],
];

const D3D11_RESOURCE: MethodSpec[] = [["GetType", 2], ["SetEvictionPriority", 2], ["GetEvictionPriority", 1]];

const DXGI_OBJECT: MethodSpec[] = [
    ["SetPrivateData", 4], ["SetPrivateDataInterface", 3], ["GetPrivateData", 4], ["GetParent", 3],
];

export const INTERFACES: Record<string, MethodSpec[]> = {
    ID3D11Device: [...IUNKNOWN, ...D3D11_DEVICE],
    ID3D11DeviceContext: [...IUNKNOWN, ...D3D11_DEVICE_CHILD, ...D3D11_DEVICE_CONTEXT],
    ID3D11Buffer: [...IUNKNOWN, ...D3D11_DEVICE_CHILD, ...D3D11_RESOURCE, ["GetDesc", 2]],
    ID3D11Texture2D: [...IUNKNOWN, ...D3D11_DEVICE_CHILD, ...D3D11_RESOURCE, ["GetDesc", 2]],
    /** SRV, RTV and DSV: ID3D11View::GetResource, then the view's own GetDesc. */
    ID3D11View: [...IUNKNOWN, ...D3D11_DEVICE_CHILD, ["GetResource", 2], ["GetDesc", 2]],
    /** Blend, depth-stencil, rasterizer and sampler states: one GetDesc. */
    ID3D11State: [...IUNKNOWN, ...D3D11_DEVICE_CHILD, ["GetDesc", 2]],
    /** Shaders and input layouts add nothing to ID3D11DeviceChild. */
    ID3D11Shader: [...IUNKNOWN, ...D3D11_DEVICE_CHILD],
    /** ID3D11Asynchronous::GetDataSize, then ID3D11Query::GetDesc. */
    ID3D11Query: [...IUNKNOWN, ...D3D11_DEVICE_CHILD, ["GetDataSize", 1], ["GetDesc", 2]],
    IDXGIDevice: [...IUNKNOWN, ...DXGI_OBJECT,
        ["GetAdapter", 2], ["CreateSurface", 6], ["QueryResourceResidency", 4],
        ["SetGPUThreadPriority", 2], ["GetGPUThreadPriority", 2]],
    IDXGIAdapter: [...IUNKNOWN, ...DXGI_OBJECT,
        ["EnumOutputs", 3], ["GetDesc", 2], ["CheckInterfaceSupport", 3]],
    IDXGIFactory: [...IUNKNOWN, ...DXGI_OBJECT,
        ["EnumAdapters", 3], ["MakeWindowAssociation", 3], ["GetWindowAssociation", 2],
        ["CreateSwapChain", 4], ["CreateSoftwareAdapter", 3], ["EnumAdapters1", 3], ["IsCurrent", 1]],
    IDXGIOutput: [...IUNKNOWN, ...DXGI_OBJECT,
        ["GetDesc", 2], ["GetDisplayModeList", 5], ["FindClosestMatchingMode", 4], ["WaitForVBlank", 1],
        ["TakeOwnership", 3], ["ReleaseOwnership", 1], ["GetGammaControlCapabilities", 2],
        ["SetGammaControl", 2], ["GetGammaControl", 2], ["SetDisplaySurface", 2],
        ["GetDisplaySurfaceData", 2], ["GetFrameStatistics", 2]],
    IDXGISwapChain: [...IUNKNOWN, ...DXGI_OBJECT, ["GetDevice", 3],
        ["Present", 3], ["GetBuffer", 4], ["SetFullscreenState", 3], ["GetFullscreenState", 3],
        ["GetDesc", 2], ["ResizeBuffers", 6], ["ResizeTarget", 2], ["GetContainingOutput", 2],
        ["GetFrameStatistics", 2], ["GetLastPresentCount", 2]],
};

/** Interface IDs (lower case, no braces), from d3d11.h and dxgi.h. */
export const IID = {
    IUnknown: "00000000-0000-0000-c000-000000000046",
    ID3D11Device: "db6f6ddb-ac77-4e88-8253-819df9bbf140",
    ID3D11DeviceContext: "c0bfa96c-e089-44fb-8eaf-26f8796190da",
    ID3D11DeviceChild: "1841e5c8-16b0-489b-bcc8-44cfb0d5deae",
    ID3D11Resource: "dc8e63f3-d12b-4952-b47b-5e45026a862d",
    ID3D11Buffer: "48570b85-d1ee-4fcd-a250-eb350722b037",
    ID3D11Texture2D: "6f15aaf2-d208-4e89-9ab4-489535d34f9c",
    IDXGIObject: "aec22fb8-76f3-4639-9be0-28eb43a67a2e",
    IDXGIDevice: "54ec77fa-1377-44e6-8c32-88fd5f44c84c",
    IDXGIDevice1: "77db970f-6276-48ba-ba28-070143b4392c",
    IDXGIAdapter: "2411e7e1-12ac-4ccf-bd14-9798e8534dc0",
    IDXGIAdapter1: "29038f61-3839-4626-91fd-086879011a05",
    IDXGIFactory: "7b7166ec-21c7-44ae-b21a-c9ae321ae369",
    IDXGIFactory1: "770aae78-f26f-4dba-a829-253c83d1b387",
    IDXGIOutput: "ae02eedb-c735-4690-8d52-5a8dc20213aa",
    IDXGISwapChain: "310d36a0-d2e7-4c0a-aa04-6a9d23b8886a",
    IDXGISurface: "cafcb56c-6ac3-4889-bf47-9e23bbd260ec",
} as const;

/** The friendly name of a known IID, for trace lines. */
export function iidName(iid: string): string {
    for (const [name, value] of Object.entries(IID)) if (value === iid) return name;
    return `{${iid}}`;
}
