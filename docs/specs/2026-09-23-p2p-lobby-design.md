# P2P Lobby for Bedwars — Design

## Goal

Add an online, peer-to-peer lobby in front of the existing packaged Bedwars
game so players can pick a username, see who is online, invite someone to a
match, and — if the invite is accepted — both players launch the game.

## Non-goals

- No real-time gameplay sync (positions, hits, blocks). Both players simply
  launch the same game. The networking layer is structured so sync could be
  added later.
- No accounts, persistence, ranking, or moderation.
- No TURN server. WebRTC uses public STUN only, so it works on most home
  networks but not strict/corporate NAT.

## Hosting

Static site on GitHub Pages. No backend we own. The only external service is a
free public MQTT broker used for discovery + signaling; the actual player link
is a WebRTC data channel (peer-to-peer).

## Architecture

```
index.html   (lobby, NEW)  ──┐
lobby.js     (UI + flow)     │  MQTT (public broker) : presence, invites, signaling
net.js       (MQTT + WebRTC) ┘  WebRTC (STUN)        : direct peer data channel
style.css    (pixel-art UI)
assets/lobby/*.svg (original art)
game.html    (the packaged game; was index.html)
script.js / assets/ (untouched)
vendor/mqtt.min.js  (vendored so GitHub Pages needs no CDN)
```

## Lobby flow

1. On load: prompt for a username, saved in `localStorage`. Generate a random
   client id (`crypto.randomUUID()`).
2. Connect to the public MQTT broker over WSS.
3. Publish presence on a 5s heartbeat; subscribe to the lobby topic; prune
   entries older than 15s. Players currently in a match are removed from the
   list.
4. Click a player -> send invite. Invitee sees a modal: "<name> wants to play
   Bedwars" with Accept / Decline.
5. Decline -> inviter sees "declined". Accept -> both run a WebRTC handshake
   (signaling over MQTT, Google STUN).
6. When the data channel opens, both navigate to `game.html?match=<id>&peer=<name>`.

## Topics (namespace `bedwars/v1`)

- `bedwars/v1/lobby/<id>` — retained presence `{id,name,ts}`; Last-Will clears it.
- `bedwars/v1/invite/<id>` — `{type:'invite'|'decline'|'accept', from, fromName}`
- `bedwars/v1/rtc/<id>` — `{type:'offer'|'answer'|'ice', from, sdp?, candidate?}`

## Trade-offs / risks

- The public broker is demo-grade: lobby traffic is observable by anyone.
- STUN-only WebRTC fails behind symmetric NAT.
- The lobby is only as reliable as the chosen public broker.
