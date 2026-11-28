import { expect, test } from "bun:test";
import { createRenderTarget, createTextureSurface } from "../../src/worker/backends/webgpu/shared/surface-factory";
import type { D3D8DeviceAdapter } from "../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { createDeviceExports } from "../../src/worker/modules/d3d8/device";
import { createResourcesExports } from "../../src/worker/modules/d3d8/resources";
import {
    createComObject,
    deviceBackBufferSurfaces,
    deviceBoundDepthStencil,
    devices,
    forgetComObject,
    getComRefCount,
    implicitDepthStencils,
    resourceToDevice,
    surfaceInfo,
} from "../../src/worker/modules/d3d8/shared-state";

for (const isBackBuffer of [true, false]) {
    const getterName = isBackBuffer ? "GetBackBuffer" : "GetDepthStencilSurface";

    test(`D3D8 ${getterName} reacquires a device-owned surface after Release returns zero`, () => {
        const system = System.getInstance();
        const previousProcess = system.process;
        const previousMemory = (Mem as unknown as { memoryGetter: () => Uint8Array }).memoryGetter;
        const mem = new Uint8Array(0x4000);
        const devicePtr = 0x200;
        const outPtr = 0x300;
        const format = isBackBuffer ? 22 : 75;
        const surface = isBackBuffer ? createRenderTarget(8, 8, format) : createTextureSurface(8, 8, format);
        const device = { depthStencilSurfacePtr: 0 } as D3D8DeviceAdapter;
        const getter = createDeviceExports()[`IDirect3DDevice8_${getterName}`]!;
        const release = createResourcesExports().IDirect3DSurface8_Release!;
        const ctx = {} as Parameters<typeof getter>[0];
        let surfacePtr = 0;

        Mem.bind(() => mem);
        system.process = {
            getCurrentMemory: () => mem,
            memory: { allocSystemBlock: () => 0x1000 },
        } as typeof system.process;

        try {
            surfacePtr = createComObject(0x2000, 0);
            devices.set(devicePtr, device);
            resourceToDevice.set(surfacePtr, device);
            surfaceInfo.set(surfacePtr, {
                texturePtr: 0, level: 0, surface, d3dFormat: format,
                role: isBackBuffer ? "backbuffer" : undefined,
            });
            if (isBackBuffer) {
                deviceBackBufferSurfaces.set(devicePtr, surfacePtr);
            } else {
                device.depthStencilSurfacePtr = surfacePtr;
                deviceBoundDepthStencil.set(devicePtr, surfacePtr);
                implicitDepthStencils.add(surfacePtr);
            }

            const args = isBackBuffer ? [devicePtr, 0, 0, outPtr] : [devicePtr, outPtr];
            for (let i = 0; i < 2; i++) {
                expect(getter(ctx, mem, args)).toBe(0);
                expect(Mem.readUint32(outPtr)).toBe(surfacePtr);
                expect(getComRefCount(surfacePtr)).toBe(1);
                expect(release(ctx, mem, [surfacePtr])).toBe(0);
                expect(getComRefCount(surfacePtr)).toBe(0);
                expect(surfaceInfo.get(surfacePtr)?.surface).toBe(surface);
            }
        } finally {
            devices.delete(devicePtr);
            deviceBackBufferSurfaces.delete(devicePtr);
            deviceBoundDepthStencil.delete(devicePtr);
            implicitDepthStencils.delete(surfacePtr);
            surfaceInfo.delete(surfacePtr);
            resourceToDevice.delete(surfacePtr);
            forgetComObject(surfacePtr);
            system.process = previousProcess;
            Mem.bind(previousMemory);
        }
    });
}
