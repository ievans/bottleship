# Multiplayer (virtual LAN)

Games that use Winsock for LAN play can talk to each other through a **virtual LAN**: every
browser tab that joins the same *room* is a host on `192.168.77.0/24`, relayed through a small
WebSocket server. Nothing leaves the room.

## Use

In the game's top bar, click the 🌐 button to create a room and get a shareable invite link
(click again to copy it or leave the room) — it joins live, no reload. Opening that link in
another tab or browser joins the same room. Equivalently, open the game directly with a room
name in the URL:

```
https://<host>/?game=<id>&lan=<room>      # room: [A-Za-z0-9_-], 1–32 chars
```

The first tab gets `192.168.77.2`, the next `.3`, and so on (up to 32 per room). A guest sees
that address from `gethostname`/`gethostbyname` (own name or `""`), `getsockname` and as the
source of every datagram and connection it receives. Peers on the /24 resolve as `BOTTLESHIP-N`
through `gethostbyname` and `gethostbyaddr`. UDP broadcasts (`255.255.255.255` or
`192.168.77.255`) reach every other tab and loop back to the sender, as on Windows. Loopback
and own-address traffic never leaves the tab.

Without `?lan=`, Winsock behaves exactly as before (the offline stubs).

## Run the relay

- `deploy/server.ts` serves `/lan/<room>` when `deploy/lan-relay.ts` and
  `src/net/lan-protocol.ts` sit beside it (the `Dockerfile` does this).
- `bun run dev:mp` runs Vite plus `deploy/lan-dev.ts` (port 5175, proxied at `/lan`).
- Behind a reverse proxy, pass WebSocket upgrades and keep the `Host` header: the relay refuses
  an `Origin` whose host differs from `Host`.

## Behind a Cloudflare Tunnel (or any reverse proxy)

`cloudflared` forwards WebSocket upgrades as is, so `/lan/<room>` needs no special rule. Point the
tunnel at the server (`http://bottleship-stand:5173`, or `http://localhost:5173`) and:

- **Set `LAN_TRUST_PROXY=1`** (the compose file passes it through). Otherwise every Internet client
  arrives from the tunnel's address and the whole site shares one `LAN_MAX_CONN_PER_IP` allowance.
  With it the cap keys on `CF-Connecting-IP` (which Cloudflare overwrites, so a client cannot forge
  it), then the first `X-Forwarded-For` entry, then the socket address. IPv6 clients are counted per /64.
  Only enable it when the tunnel is the sole way to reach the port — do not publish it — or a direct
  client can send those headers itself.
- **Keep the `Host` header.** The relay refuses an `Origin` that differs from `Host`; do not set
  `httpHostHeader` on the tunnel's origin to something other than the public hostname.
- **Protect the site.** A room is open to whoever knows its name. The in-app button makes a 20-character
  random name (~100 bits), so an invite link is the credential. Add Cloudflare Access or
  `BS_AUTH_USER`/`BS_AUTH_PASS` if the whole stand should not be public.
- Idle sockets are pinged every 30 s, well inside the ~100 s a proxy waits before dropping a silent
  WebSocket.
- `tools/make-stand.ts` now ships `lan-relay.ts` and `lan-protocol.ts` beside `server.ts`; an older
  payload has no relay (`/lan/…` answers 404) until it is rebuilt.

Peers still talk through the relay only, so no inbound port or UDP is needed on any client.

## Relay limits and hardening

Rooms are open to anyone who knows the name, so use an unguessable room name and put the site
behind `BS_AUTH_USER`/`BS_AUTH_PASS` or your access proxy for anything public.

- At most 32 peers per room, 256 rooms, 16 connections per client address
  (`LAN_MAX_CONN_PER_IP`). Behind a reverse proxy set `LAN_TRUST_PROXY=1` so the cap uses the
  client address the proxy reports (see above).
- A peer is disconnected for exceeding ~2 MiB/s sustained (4 MiB burst); a broadcast is charged
  once per recipient. A reader that cannot keep up is disconnected rather than silently losing
  frames, because a lost TCP segment would corrupt the stream.
- The relay overwrites the source address of every frame, and the stack only accepts frames for
  a flow from the peer that flow was established with (connection ids are random).
- Connections are reset when the relay link drops or the tab's address changes.

## What is implemented

`src/worker/net/lan-stack.ts` is the socket state machine (UDP, TCP, bind/ephemeral ports,
`SO_REUSEADDR`, `SO_ERROR`, `FIONREAD`, `MSG_PEEK`, truncation, backlog, graceful close,
reset on peer loss, connect timeout). `lan-exports.ts` adapts it to `wsock32`/`ws2_32`:
blocking and non-blocking `connect/accept/recv/recvfrom/send/sendto`, `select`,
`WSAAsyncSelect`, `WSAEventSelect` + `WSAEnumNetworkEvents`, and non-overlapped
`WSASend/WSARecv(From)/SendTo`, `WSAAccept`/`WSAConnect`, `SO_RCVTIMEO` on blocking receives, `gethostbyname`/`gethostbyaddr` for room peers,
and async/event selection inherited by accepted sockets. The wire format is `src/net/lan-protocol.ts`.
`iphlpapi:GetAdaptersInfo` (`src/worker/modules/iphlpapi.ts`) reports one synthetic adapter for
the virtual LAN once a room is joined — titles that enumerate adapters before offering
multiplayer (e.g. Empire Earth's `TCP Protocol.dll`) see a real one, not zero. Offline, it still
answers `ERROR_NO_DATA` as before.

## Not implemented

- **DirectPlay** (`dplayx`) is still local-only; a title that uses it instead of Winsock will not
  see other tabs.
- Overlapped Winsock I/O, IPv6, other `iphlpapi` adapter queries (`GetAdaptersAddresses`,
  `GetNetworkParams`, …), `SO_SNDTIMEO`, `WSAAsyncGetHostBy*` for the local name.
- Internet matchmaking services (e.g. GameSpy) — rooms replace them.
- TCP has no flow control: a reader that falls 4 MiB behind has its connection reset (never a silent gap).
- Relay-side `SO_BROADCAST` is not enforced, and UDP sockets bound to a specific address still see broadcasts.
- `gethostname`/`gethostbyname` answer with the offline stub's name until the relay has welcomed the tab.
- Only one title has been verified end to end (below).

## Driving and debugging a title

A second real guest costs gigabytes (two Empire Earth guests do not fit an 8 GB machine), so
`tools/lan-peer.ts` joins a room as a synthetic peer — the real `LanStack` and wire protocol,
a few MB — and can listen, send, sniff and replay UDP/TCP:

```
bun tools/lan-peer.ts listen-tcp 33336 --room R --relay ws://localhost:5174 \
    --announce-hex <udp reply> --reply-hex <1st reply>,<2nd reply>
bun tools/lan-peer.ts connect-tcp 192.168.77.2 33336 <hex> --room R --relay ws://localhost:5174
```

`--reply-hex` takes a comma-separated list: the Nth segment on a connection gets the Nth reply
(one value answers every segment). On the guest side, `harness lanState` and `lanTrace` show
the sockets and the last frames each way, and `lanJoin`/`lanLeave` join a room from a script. With tracing on, `lanTrace`
also records the guest's Winsock lifecycle calls and results (`dir:"api"`: socket/bind/connect/send payloads, name
lookups; failed `recv`/`accept` polls are skipped) — the way to see what a title does with its sockets after a message.

## Verified: Empire Earth lobby and launch

Empire Earth's "TCP Protocol" (NPIM) lobby runs over plain Winsock + `GetAdaptersInfo`, not
DirectPlay. `tools/harness/regression/empire-earth-lan.harness.ts` drives a real guest through
both directions against a synthetic peer: hosting (a peer's hello is answered with the roster and
game settings) and joining (the guest lists a UDP-announced game, joins it and reaches the game
lobby). Observed wire format:

- UDP 8585: a client's Refresh broadcasts the 1-byte query `04`; a host answers each query with a
  unicast announce (`01 …`, game name as UTF-16) and broadcasts `02 3882` keepalives (~15 s).
- TCP 33336: `[len16 LE, includes itself][type][body]`. Client hello: type `01`, a `len16`-prefixed
  UTF-16 player name, then a `len16`-prefixed second string (empty). Host reply: type `02`, the
  assigned player id and a roster of `(id, name)` pairs. The client then sends its version
  (`08 01 …`, e.g. `v2.00.2974`) and the host answers the game settings (`08 02 …`) and a closing
  `08 03` frame.
- Launch: the host broadcasts an encrypted 67-byte datagram to UDP 33334 and sends TCP `08 07`; the client then
  resolves the host with `gethostbyname("<dotted ip>")` and sends its session request to that address on 33334. A
  lookup that answers loopback for a dotted-decimal name (the offline stub used to) sends it nowhere, and the client
  times out after 10 s.

## Tests

`tools/tests/lan-stack.test.ts` (relay + stack), `tools/tests/lan-exports.test.ts` (thunks
against a fake guest address space), `tools/tests/lan-hardening.test.ts` (forged frames, limits,
reconnect, origin/upgrade handling), `tools/tests/lan-hostent.test.ts` (peer name resolution), `tools/tests/lan-tunnel.test.ts` (proxy client address, room names, stand payload),
`tools/tests/iphlpapi.test.ts` (adapter enumeration), `tools/tests/lan-peer.test.ts` (the
synthetic peer).
