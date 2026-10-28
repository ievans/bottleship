# Multiplayer (virtual LAN)

Games that use Winsock for LAN play can talk to each other through a **virtual LAN**: every
browser tab that joins the same *room* is a host on `192.168.77.0/24`, relayed through a small
WebSocket server. Nothing leaves the room.

## Use

Open the game in each tab with the same room name:

```
https://<host>/?game=<id>&lan=<room>      # room: [A-Za-z0-9_-], 1–32 chars
```

The first tab gets `192.168.77.2`, the next `.3`, and so on (up to 32 per room). A guest sees
that address from `gethostname`/`gethostbyname` (own name or `""`), `getsockname` and as the
source of every datagram and connection it receives. UDP broadcasts (`255.255.255.255` or
`192.168.77.255`) reach every other tab and loop back to the sender, as on Windows. Loopback
and own-address traffic never leaves the tab.

Without `?lan=`, Winsock behaves exactly as before (the offline stubs).

## Run the relay

- `deploy/server.ts` serves `/lan/<room>` when `deploy/lan-relay.ts` and
  `src/net/lan-protocol.ts` sit beside it (the `Dockerfile` does this).
- `bun run dev:mp` runs Vite plus `deploy/lan-dev.ts` (port 5175, proxied at `/lan`).
- Behind a reverse proxy, pass WebSocket upgrades and keep the `Host` header: the relay refuses
  an `Origin` whose host differs from `Host`.

## What is implemented

`src/worker/net/lan-stack.ts` is the socket state machine (UDP, TCP, bind/ephemeral ports,
`SO_REUSEADDR`, `SO_ERROR`, `FIONREAD`, `MSG_PEEK`, truncation, backlog, graceful close,
reset on peer loss, connect timeout). `lan-exports.ts` adapts it to `wsock32`/`ws2_32`:
blocking and non-blocking `connect/accept/recv/recvfrom/send/sendto`, `select`,
`WSAAsyncSelect`, `WSAEventSelect` + `WSAEnumNetworkEvents`, and non-overlapped
`WSASend/WSARecv(From)/SendTo`. The wire format is `src/net/lan-protocol.ts`.

## Not implemented

- **DirectPlay** (`dplayx`) is still local-only; a title that uses it instead of Winsock will not
  see other tabs.
- Overlapped Winsock I/O, IPv6, `iphlpapi` adapter enumeration, `SO_RCVTIMEO`/`SO_SNDTIMEO`.
- Internet matchmaking services (e.g. GameSpy) — rooms replace them.
- TCP has no flow control or congestion model; a stalled reader buffers up to 4 MiB then drops.
- Titles have not been verified end to end; see [compatibility](compatibility.md).

## Tests

`tools/tests/lan-stack.test.ts` (relay + stack), `tools/tests/lan-exports.test.ts` (thunks
against a fake guest address space).
