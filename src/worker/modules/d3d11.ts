/**
 * D3D11.DLL - Direct3D 11.
 *
 * D3D11CreateDevice hands out a device on the shared WebGPU backend (see
 * modules/d3d11/device.ts and backends/webgpu/d3d11/). Shader model 4 bytecode is translated
 * to WGSL, so the highest feature level offered is 11_0; a caller that lists only levels
 * above that, or a host without WebGPU, gets DXGI_ERROR_UNSUPPORTED.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { WebGPUBackend } from "../backends/webgpu/webgpu-backend";
import { D3D11Renderer } from "../backends/webgpu/d3d11/renderer";
import { D3D11Device } from "./d3d11/device";

const S_OK = 0;
const DXGI_ERROR_UNSUPPORTED = 0x887a0004;
const MAX_FEATURE_LEVEL = 0xb000;

/** The first requested level we can claim, or 11_0 for the default list (NULL). */
function pickFeatureLevel(pLevels: number, count: number): number {
    if (!pLevels || !count) return MAX_FEATURE_LEVEL;
    for (let i = 0; i < count; i++) {
        const level = Mem.readUint32(pLevels + i * 4) ?? 0;
        if (level <= MAX_FEATURE_LEVEL) return level;
    }
    return 0;
}

async function webgpuBackend(process: Process): Promise<WebGPUBackend | null> {
    const render = System.getInstance().services.render;
    let backend = render.getBackend() as WebGPUBackend | null;
    if (backend && backend.kind === "webgpu") return backend;
    if (!process.canvas) return null;
    backend = new WebGPUBackend();
    await backend.initialize(process.canvas);
    render.setBackend(backend);
    return backend;
}

export class D3D11 implements IModule {
    name = "d3d11";
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // HRESULT D3D11CreateDevice(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE Software, UINT Flags,
        //     const D3D_FEATURE_LEVEL*, UINT FeatureLevels, UINT SDKVersion, ID3D11Device**,
        //     D3D_FEATURE_LEVEL*, ID3D11DeviceContext**)
        this.exports["D3D11CreateDevice"] = async (_ctx, _mem, args) => {
            for (const i of [7, 8, 9]) if (args[i]) Mem.writeUint32(args[i]! >>> 0, 0);
            const level = pickFeatureLevel(args[4]! >>> 0, args[5]! >>> 0);
            if (!level) return DXGI_ERROR_UNSUPPORTED;
            let backend: WebGPUBackend | null = null;
            try {
                backend = await webgpuBackend(process);
            } catch (e) {
                Logger.error(LogCategory.D3D9, `[D3D11] WebGPU backend unavailable: ${e}`);
            }
            if (!backend?.getDevice()) return DXGI_ERROR_UNSUPPORTED;
            const device = new D3D11Device(process, level, new D3D11Renderer(backend));
            device.init();
            // A NULL ppDevice asks only whether creation would succeed.
            if (args[7]) Mem.writeUint32(args[7]! >>> 0, device.device);
            if (args[8]) Mem.writeUint32(args[8]! >>> 0, level);
            if (args[9]) Mem.writeUint32(args[9]! >>> 0, device.immediateContext);
            Logger.log(LogCategory.D3D9, `[D3D11] D3D11CreateDevice -> feature level 0x${level.toString(16)}`);
            return S_OK;
        };
        this.exports["D3D11CreateDeviceAndSwapChain"] = (_ctx, _mem, args) => {
            for (const i of [8, 9, 10, 11]) if (args[i]) Mem.writeUint32(args[i]! >>> 0, 0);
            Logger.warn(LogCategory.D3D9, "[D3D11] D3D11CreateDeviceAndSwapChain is not implemented yet");
            return DXGI_ERROR_UNSUPPORTED;
        };
    }
}
