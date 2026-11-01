/** DirectPlay 8 result codes, flags and callback message ids (dplay8.h). */

const err = (c: number): number => (0x80158000 | c) >>> 0;

export const Hr = {
    OK: 0,
    PENDING: 0x0015800e,
    E_FAIL: 0x80004005,
    E_POINTER: 0x80004003,
    E_NOINTERFACE: 0x80004002,
    E_INVALIDARG: 0x80070057,
    E_OUTOFMEMORY: 0x8007000e,
    ABORTED: err(0x30),
    ADDRESSING: err(0x40),
    ALREADYCONNECTED: err(0x50),
    ALREADYINITIALIZED: err(0x70),
    BUFFERTOOSMALL: err(0x100),
    CANNOTCANCEL: err(0x110),
    CANTCREATEGROUP: err(0x120),
    CANTCREATEPLAYER: err(0x130),
    CONNECTIONLOST: err(0x160),
    DOESNOTEXIST: err(0x180),
    HOSTREJECTEDCONNECTION: err(0x260),
    HOSTTERMINATEDSESSION: err(0x270),
    INCOMPLETEADDRESS: err(0x280),
    INVALIDAPPLICATION: err(0x300),
    INVALIDDEVICEADDRESS: err(0x320),
    INVALIDFLAGS: err(0x340),
    INVALIDGROUP: err(0x350),
    INVALIDHANDLE: err(0x360),
    INVALIDHOSTADDRESS: err(0x370),
    INVALIDINSTANCE: err(0x380),
    INVALIDOBJECT: err(0x400),
    INVALIDPASSWORD: err(0x410),
    INVALIDPLAYER: err(0x420),
    INVALIDSTRING: err(0x440),
    INVALIDURL: err(0x450),
    NOCAPS: err(0x460),
    NOCONNECTION: err(0x470),
    NORESPONSE: err(0x500),
    NOTHOST: err(0x520),
    NOTREADY: err(0x530),
    SENDTOOLARGE: err(0x560),
    SESSIONFULL: err(0x570),
    TIMEDOUT: err(0x590),
    UNINITIALIZED: err(0x600),
    USERCANCEL: err(0x610),
} as const;

export const Msgid = {
    ADD_PLAYER_TO_GROUP: 0xffff0001,
    APPLICATION_DESC: 0xffff0002,
    ASYNC_OP_COMPLETE: 0xffff0003,
    CONNECT_COMPLETE: 0xffff0005,
    CREATE_GROUP: 0xffff0006,
    CREATE_PLAYER: 0xffff0007,
    DESTROY_GROUP: 0xffff0008,
    DESTROY_PLAYER: 0xffff0009,
    ENUM_HOSTS_QUERY: 0xffff000a,
    ENUM_HOSTS_RESPONSE: 0xffff000b,
    GROUP_INFO: 0xffff000c,
    HOST_MIGRATE: 0xffff000d,
    INDICATE_CONNECT: 0xffff000e,
    INDICATED_CONNECT_ABORTED: 0xffff000f,
    PEER_INFO: 0xffff0010,
    RECEIVE: 0xffff0011,
    REMOVE_PLAYER_FROM_GROUP: 0xffff0012,
    RETURN_BUFFER: 0xffff0013,
    SEND_COMPLETE: 0xffff0014,
    TERMINATE_SESSION: 0xffff0016,
} as const;

export const SendFlag = {
    NOCOPY: 0x1,
    NOCOMPLETE: 0x2,
    COMPLETEONPROCESS: 0x4,
    GUARANTEED: 0x8,
    NONSEQUENTIAL: 0x10,
    NOLOOPBACK: 0x20,
} as const;

export const OP_SYNC = 0x80000000;
export const PLAYER_LOCAL = 0x2;
export const PLAYER_HOST = 0x4;
export const SESSION_MIGRATE_HOST = 0x1;
export const INFINITE = 0xffffffff;

export const CancelFlag = { CONNECT: 0x1, ENUM: 0x2, SEND: 0x4, ALL_OPERATIONS: 0x8000 } as const;

export const DestroyReason = { NORMAL: 1, CONNECTIONLOST: 2, SESSIONTERMINATED: 3, HOSTDESTROYEDPLAYER: 4 } as const;
