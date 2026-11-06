/**
 * URL Moniker Services (urlmon.dll): enough of the moniker/bind machinery for a client such as
 * MSXML to read a local file through CreateURLMoniker + IMoniker::BindToStorage. Vtable SLOT
 * ORDER is the contract (objidl.h / urlmon.h declaration order); argCount INCLUDES `this`.
 *
 * IBindCtx and IStream are ole32 interfaces; they live here because the bind context and the
 * stream a bind produces are this module's objects (ole32's CreateBindCtx forwards to it).
 */

import { FunctionDescriptor, InterfaceDescriptor, IUnknown, ModuleDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number, self: boolean): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: self && i === 0 ? "this" : `arg${i}`, type: self && i === 0 ? "ptr" : "u32" });
    }
    return params;
};

const m = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount, true),
    returnType: "u32",
    callingConvention: "stdcall",
});

const f = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount, false),
    returnType: "u32",
    callingConvention: "stdcall",
});

const unknown = () => IUnknown.methods.map(x => ({ ...x }));

export const IBindCtx: InterfaceDescriptor = {
    name: "IBindCtx",
    inherits: "IUnknown",
    iid: "0000000e-0000-0000-c000-000000000046",
    methods: [
        ...unknown(),
        m("RegisterObjectBound", 2),
        m("RevokeObjectBound", 2),
        m("ReleaseBoundObjects", 1),
        m("SetBindOptions", 2),
        m("GetBindOptions", 2),
        m("GetRunningObjectTable", 2),
        m("RegisterObjectParam", 3),
        m("GetObjectParam", 3),
        m("EnumObjectParam", 2),
        m("RevokeObjectParam", 2),
    ],
};

/** IStream, which begins with ISequentialStream; 64-bit (U)LARGE_INTEGER args take two slots. */
export const IStream: InterfaceDescriptor = {
    name: "IStream",
    inherits: "IUnknown",
    iid: "0000000c-0000-0000-c000-000000000046",
    methods: [
        ...unknown(),
        m("Read", 4),
        m("Write", 4),
        m("Seek", 5),
        m("SetSize", 3),
        m("CopyTo", 6),
        m("Commit", 2),
        m("Revert", 1),
        m("LockRegion", 6),
        m("UnlockRegion", 6),
        m("Stat", 3),
        m("Clone", 2),
    ],
};

/** IMoniker, which begins with IPersist and IPersistStream. */
export const IMoniker: InterfaceDescriptor = {
    name: "IMoniker",
    inherits: "IUnknown",
    iid: "0000000f-0000-0000-c000-000000000046",
    methods: [
        ...unknown(),
        m("GetClassID", 2),
        m("IsDirty", 1),
        m("Load", 2),
        m("Save", 3),
        m("GetSizeMax", 2),
        m("BindToObject", 5),
        m("BindToStorage", 5),
        m("Reduce", 5),
        m("ComposeWith", 4),
        m("Enum", 3),
        m("IsEqual", 2),
        m("Hash", 2),
        m("IsRunning", 4),
        m("GetTimeOfLastChange", 4),
        m("Inverse", 2),
        m("CommonPrefixWith", 3),
        m("RelativePathTo", 3),
        m("GetDisplayName", 4),
        m("ParseDisplayName", 6),
        m("IsSystemMoniker", 2),
    ],
};

export const IBinding: InterfaceDescriptor = {
    name: "IBinding",
    inherits: "IUnknown",
    iid: "79eac9c0-baf9-11ce-8c82-00aa004ba90b",
    methods: [
        ...unknown(),
        m("Abort", 1),
        m("Suspend", 1),
        m("Resume", 1),
        m("SetPriority", 2),
        m("GetPriority", 2),
        m("GetBindResult", 5),
    ],
};

export const urlmonModule: ModuleDescriptor = {
    name: "urlmon",
    description: "URL Moniker Services",
    functions: [
        f("CreateURLMoniker", 3),
        f("CreateURLMonikerEx", 4),
        f("CreateAsyncBindCtx", 4),
        f("RegisterBindStatusCallback", 4),
        f("RevokeBindStatusCallback", 2),
        f("CoInternetGetSession", 3),
        f("IsAsyncMoniker", 1),
    ],
    interfaces: [IBindCtx, IStream, IMoniker, IBinding],
};
