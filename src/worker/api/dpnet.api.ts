/**
 * DirectPlay 8 (dpnet.dll) API descriptor: the peer session object, the address object and the
 * lobbied-application object. Vtable SLOT ORDER is the contract (dplay8.h / dpaddr.h /
 * dplobby8.h declaration order); argCount INCLUDES `this`.
 */

import { FunctionDescriptor, InterfaceDescriptor, IUnknown, ModuleDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: i === 0 ? "this" : `arg${i}`, type: i === 0 ? "ptr" : "u32" });
    }
    return params;
};

const m = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
});

const unknown = () => IUnknown.methods.map(x => ({ ...x }));

export const IDirectPlay8Peer: InterfaceDescriptor = {
    name: "IDirectPlay8Peer",
    inherits: "IUnknown",
    iid: "5102dacf-241b-11d3-aea7-006097b01411",
    methods: [
        ...unknown(),
        m("Initialize", 4),
        m("EnumServiceProviders", 7),
        m("CancelAsyncOperation", 3),
        m("Connect", 12),
        m("SendTo", 8),
        m("GetSendQueueInfo", 5),
        m("Host", 8),
        m("GetApplicationDesc", 4),
        m("SetApplicationDesc", 3),
        m("CreateGroup", 6),
        m("DestroyGroup", 5),
        m("AddPlayerToGroup", 6),
        m("RemovePlayerFromGroup", 6),
        m("SetGroupInfo", 6),
        m("GetGroupInfo", 5),
        m("EnumPlayersAndGroups", 4),
        m("EnumGroupMembers", 5),
        m("SetPeerInfo", 5),
        m("GetPeerInfo", 5),
        m("GetPeerAddress", 4),
        m("GetLocalHostAddresses", 4),
        m("Close", 2),
        m("EnumHosts", 12),
        m("DestroyPeer", 5),
        m("ReturnBuffer", 3),
        m("GetPlayerContext", 4),
        m("GetGroupContext", 4),
        m("GetCaps", 3),
        m("SetCaps", 3),
        m("SetSPCaps", 4),
        m("GetSPCaps", 4),
        m("GetConnectionInfo", 4),
        m("RegisterLobby", 4),
        m("TerminateSession", 4),
    ],
};

export const IDirectPlay8Address: InterfaceDescriptor = {
    name: "IDirectPlay8Address",
    inherits: "IUnknown",
    iid: "83783300-4063-4c8a-9db3-82830a7feb31",
    methods: [
        ...unknown(),
        m("BuildFromURLW", 2),
        m("BuildFromURLA", 2),
        m("Duplicate", 2),
        m("SetEqual", 2),
        m("IsEqual", 2),
        m("Clear", 1),
        m("GetURLW", 3),
        m("GetURLA", 3),
        m("GetSP", 2),
        m("GetUserData", 3),
        m("SetSP", 2),
        m("SetUserData", 3),
        m("GetNumComponents", 2),
        m("GetComponentByName", 5),
        m("GetComponentByIndex", 7),
        m("AddComponent", 5),
        m("SetDevice", 2),
        m("GetDevice", 2),
        m("BuildFromDirectPlay4Address", 3),
    ],
};

export const IDirectPlay8LobbiedApplication: InterfaceDescriptor = {
    name: "IDirectPlay8LobbiedApplication",
    inherits: "IUnknown",
    iid: "819074a3-016c-11d3-ae14-006097b01411",
    methods: [
        ...unknown(),
        m("Initialize", 5),
        m("RegisterProgram", 3),
        m("UnRegisterProgram", 3),
        m("SetAppAvailable", 3),
        m("UpdateStatus", 4),
        m("Send", 5),
        m("Close", 2),
        m("GetConnectionSettings", 5),
        m("SetConnectionSettings", 4),
    ],
};

export const dpnetModule: ModuleDescriptor = {
    name: "dpnet",
    version: "8.0",
    description: "DirectPlay 8 peer-to-peer sessions over the virtual LAN",
    functions: [],
    interfaces: [IDirectPlay8Peer, IDirectPlay8Address, IDirectPlay8LobbiedApplication],
};
