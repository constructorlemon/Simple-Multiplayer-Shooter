# Design Document: Top Down Shooter (Multiplayer Proof of Concept)

## 1. Overview

A browser-based, top-down arena shooter proof of concept (PoC). Players are colored circles that move around a shared 1024×1024 map, aim with the mouse, and shoot each other. Real-time multiplayer is handled client-side through **Ably** (pub/sub + presence), and the game is rendered and simulated with **Phaser 3** (Arcade Physics).

There is no game server. Every browser client runs its own simulation and talks to the others through a single shared Ably channel.

**Goals of the PoC**
- Prove that Phaser + Ably can deliver real-time shared movement, shooting, and damage without a custom backend.
- Provide a minimal but playable loop: join, move, aim, shoot, take damage.

**Non-goals (not yet implemented)**
- Match flow / win conditions, persistent scores
- Authoritative server, anti-cheat
- Lobbies/rooms, matchmaking, accounts

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Rendering / physics | Phaser 3.80.1 (Arcade Physics, loaded from jsDelivr CDN) |
| Realtime networking | Ably Realtime 1.2.48 (loaded from jsDelivr CDN) |
| Markup / styling | Plain HTML + CSS |
| Language | Vanilla JavaScript (no build step, no bundler) |
| Hosting | GitHub Pages (static files, no backend) |

---

## 3. File Structure

| File | Role |
|---|---|
| `index.html` | Entry point. Loads Phaser, Ably, and `main.js`. Contains the name-entry overlay (`#name-screen`), the `#game` canvas mount, and a status UI (player count, connection status, message log). |
| `main.js` | **The actual game.** Starts with the Ably key decoder (`getAblyKey()`), followed by a single Phaser scene (`GameScene`) containing all game logic and networking. |
| `style.css` | Page layout, dark background, status panel and name-entry overlay styling. Contains an unused `#add-player` rule. |
| `Design.md` | This document. |

`game.js`, an early offline two-player prototype (plain Canvas 2D), is no longer part of the project and was never loaded by `index.html`. It can be deleted from the repository.

---

## 4. Gameplay

### 4.1 Controls
| Input | Action |
|---|---|
| `W` `A` `S` `D` | Move (8-direction, diagonal speed normalized) |
| Mouse position | Aim (a bar rotates around the player toward the cursor) |
| Hold left mouse button | Fire (one shot per 250 ms) |

### 4.2 Core parameters
| Parameter | Value |
|---|---|
| Viewport | 800×600 |
| Map size | 1024×1024 |
| Player radius | 15 px |
| Player speed | 200 px/s |
| Player HP | 100 |
| Bullet speed | 400 px/s |
| Bullet radius | 3 px |
| Bullet lifetime | 2000 ms |
| Bullet damage | 10 |
| Hit radius (shooter-side check) | 18 px from player center |
| Respawn delay | 2000 ms |
| Name length | max 12 characters |
| Fire rate | 250 ms between shots |
| Rock count | 12 |

### 4.3 World
- A flat green rectangular arena.
- **12 procedurally shaped rocks** act as static obstacles. They block players and destroy bullets.
- **Screen wrap:** players and bullets that leave one edge of the map re-appear on the opposite edge.
- The camera follows the local player with smoothing (lerp 0.1) and is clamped to the map bounds.
- Players do not collide with each other.

### 4.4 HUD
- **Health bar** (top-left): green above 60%, yellow 30–60%, red below 30%, with numeric `hp/100` text. Only redrawn when HP changes.
- **Minimap** (bottom-left, 150×150): rock dots are created once; each player has one persistent dot that is repositioned every frame.
- **DOM status panel** (below canvas): players online, connection status, and a transient 3-second message log ("xxxxx joined/left").

---

## 5. Architecture

### 5.1 High-level diagram

```
 ┌─────────────┐        Ably channel "game-room"         ┌─────────────┐
 │  Client A   │  ◄──── player-update / bullet / hit ───►  │  Client B   │
 │ Phaser game │  ◄──────────── presence ───────────────►  │ Phaser game │
 └─────────────┘                    ▲                      └─────────────┘
                                    │
                              ┌─────┴─────┐
                              │ Ably cloud │
                              └───────────┘
```

Every client is a **peer** running its own simulation. Ably relays messages; it does not run game logic.

### 5.2 `GameScene` responsibilities

| Area | Key methods |
|---|---|
| Scene setup | `create()`, `seededRandom()` |
| Networking | `connectToAbly()`, `enterGame()` |
| Players | `createRemotePlayer()`, `updateRemotePlayer()`, `removePlayer()`, `updatePlayerCount()`, `getColorForClientId()` |
| World | `createRocks()`, `addRockSeeded()`, `addRockAt()` |
| HUD | `createMinimap()`, `updateMinimap()`, `createHealthBar()`, `updateHealthBar()`, `logMessage()` |
| Combat | `shootBullet()`, `createRemoteBullet()`, `updateBullets()`, `takeDamage()`, `respawnLocalPlayer()` |
| Names / host / leaderboard | `electHost()`, `nameOf()`, `addNameLabel()`, `setPlayerName()`, `applyAlive()`, `processKill()`, `publishLeaderboard()`, `createLeaderboard()`, `renderLeaderboard()` |
| Game loop | `update(time)` |

### 5.3 Player representation
Each player is a Phaser `Arc` (circle) with an Arcade body, plus a separate `Rectangle` (`aimRect`) acting as the aim indicator. The local player additionally has `controls`, `keys` (created once on join), `speed`, `shootRate`, and `lastShot`. Remote players carry `targetX/targetY/targetRotation` for interpolation.

### 5.4 Bullet representation
Bullets are small yellow circles held in two Arcade physics groups:
- `bulletGroup`: bullets fired by the local player.
- `remoteBulletGroup`: bullets fired by other players, recreated locally from `bullet` messages.

Each group has a **single collider with the rocks group** (bullets are destroyed on contact). Every bullet carries `shooterId`, `bulletId` (`<clientId>:<counter>`), and `expireAt`. Lifetime expiry and screen wrap are handled for all bullets by one loop (`updateBullets()`), with no per-bullet timers. Remote bullets are also indexed by `bulletId` in `remoteBulletsById` so they can be removed when a hit is announced.

---

## 6. Networking Design

### 6.1 Connection and identity
- On start, the client creates an Ably Realtime connection with a random `clientId` (`player_` + 11 random base-36 characters) and `echoMessages: false`, so a client does not receive its own messages back.
- All clients join one hardcoded channel: **`game-room`**.
- Color is derived deterministically from the `clientId` via a djb2-style hash into a 10-color palette, and is also sent via presence.
- The local player spawns at a random position at least 200 px from the map edges once the connection reports `connected`. `enterGame()` is guarded so a reconnect does not spawn a second player.

### 6.2 Messages

| Channel event | Sender | Payload | Receiver behavior |
|---|---|---|---|
| `player-update` | Each client, on movement/rotation change, plus a 1 s heartbeat | `{ clientId, x, y, hp, rotation }` (x/y rounded to 0.1, rotation to 0.01) | Set interpolation targets, HP, rotation. Creates the remote player if unknown. |
| `kill` | Victim, when its HP reaches 0 | `{ killerId, victimId }` | The current host adds one kill to `killerId`. Everyone else ignores it. |
| `leaderboard` | Host only (on every kill, when a player joins, when a new host takes over, and every 5 s) | `{ scores: { <clientId>: { name, kills } } }` (top 20) | Non-host clients replace their local copy and redraw the board. |
| `bullet` | Shooter, on fire | `{ shooterId, bulletId, x, y, vx, vy }` | Spawn a local copy of the bullet in `remoteBulletGroup`. |
| `hit` | **Shooter only** | `{ targetId, damage, shooterId, bulletId }` | Every client destroys the bullet with that `bulletId`. If `targetId` is the local player, subtract `damage` from HP (floored at 0). |
| Presence `enter` | Ably | `{ x, y, hp, color, rotation, name }` | Create the remote player; log "joined"; refresh count. |
| Presence `leave` | Ably | member | Remove the player and their minimap dot; log "left"; refresh count. |

Presence is used for joining, leaving, the player count, player names, and host election. It is **not** updated during gameplay.

### 6.3 Update throttling
A `player-update` is sent when at least 60 ms (about 16 Hz) have passed since the last one **and** either:
1. The player moved more than 1 px or rotated more than 0.05 rad, or
2. A 1 second heartbeat is due. This keeps idle players correct for late joiners, since presence data is only a snapshot from the moment they joined.

### 6.4 Smoothing remote players
Each frame, remote players lerp toward their latest received target position (factor up to 0.3) and shortest-arc lerp their rotation (factor 0.25). This hides the 16 Hz update rate.

### 6.5 Deterministic world
Rock layout is generated locally from a fixed seed (`12345`) using a simple linear congruential generator, so all clients build an identical map **without sending any map data**. Individual rock shapes are also seeded from their coordinates.

### 6.6 Hit detection model (shooter-authoritative)
The **shooter's client is the single authority** for whether its bullets hit anyone:

1. Each frame, for each of the local player's bullets, check the distance to every remote player (18 px threshold, using their interpolated positions).
2. On a hit, destroy the bullet locally and publish `hit` with the bullet's ID.
3. All other clients receive `hit`, destroy their copy of that bullet, and the target subtracts the damage.

Why this design: the `bullet` and `hit` messages come from the same sender on the same channel, so they arrive in order and with the same delay. Every client therefore sees the bullet stop at the same point of its flight, and a bullet that hits player 2 can never continue on to hit player 3 on someone else's screen. It also guarantees exactly one `hit` per bullet.

Trade-off: hits are judged from the shooter's view of the target, so a player can occasionally be hit when it looked like they had dodged.

Remote bullets still collide with rocks on every client (deterministic map, same start and velocity), but they are never tested against the local player.

---

## 6b. Names, Host and Leaderboard

**Names.** `index.html` shows a full-screen overlay asking for a name. The Phaser game and the Ably connection are only created after the player submits (button or Enter). Names are trimmed, whitespace-collapsed, and cut to 12 characters; an empty name becomes `Player###`. The name travels in the presence `enter` data, appears as a label above each player, and is used on the leaderboard and in join/leave messages. Names are rendered as canvas text, never as HTML.

**Host election.** The host is the player with the **oldest presence entry**, using Ably's server-side presence timestamp (client clocks are not trusted); `clientId` breaks ties. Every client recomputes the host from `presence.get` on each join and leave, so when the host leaves the next-oldest player takes over without any message exchange.

**Kills.** A kill is counted when a hit takes a player from above 0 HP to exactly 0. Because the victim's client applies damage, it also publishes the `kill` event. If the victim is the host, it processes the kill locally (own messages are not echoed).

**Leaderboard.** The host owns the scoreboard: it adds the kill and broadcasts the full table. Every client keeps the last table it received, so a new host starts from the previous one. The board is shown in the top-right corner of the screen (top 8). Connected players with no kills yet are listed with 0, the host is marked with a star, and the local player is marked `(you)`. Scores live only in memory: they are lost when every player has left.

**Minimal death/respawn.** To make repeated kills possible, a player at 0 HP is faded out for everyone, cannot move or shoot, and cannot be hit. After 2 seconds they respawn at a random location with full HP. There is no spectator view, invulnerability window, or death screen yet.

---

## 7. Game Loop (per frame)

1. Read WASD from the pre-created keys, set velocity, normalize for diagonals.
2. Wrap player position at map edges.
3. Interpolate all remote players toward their targets.
4. Compute aim angle from the mouse (screen to world), update the aim bar.
5. If throttle conditions are met (movement or heartbeat), publish `player-update`.
6. If the mouse is held and the cooldown has elapsed, spawn and broadcast a bullet.
7. Check the local player's bullets against remote players, publishing `hit` and destroying the bullet on contact.
8. Expire old bullets and wrap bullets that left the map (both groups).
9. Move the minimap player dots and update the health bar if HP changed.

---

## 8. Known Issues and Risks

### Security
- **The Ably key is only obfuscated, not protected.** It is XOR-encoded and split into chunks inside `main.js` (rebuilt by `getAblyKey()`), which keeps it out of casual view and out of public-repo secret scanners. Anyone who reads the code or watches network traffic can still recover it.
  - Restrict the key in the Ably dashboard: only the `game-room` channel, only `subscribe`, `publish`, and `presence`.
  - Rotate the key if the old one was ever committed in plain text, because it remains in git history.
  - The real fix is **token authentication**: a small serverless endpoint (for example a Cloudflare Worker) that issues short-lived, capability-limited tokens, while the game stays on GitHub Pages.
- **Clients are fully trusted.** Any peer can publish `hit` events against anyone or fake its position and HP. Acceptable for a PoC, not for a public game.

### Gameplay and logic
- **Death is minimal.** A fixed 2-second fade-and-respawn exists so kills can repeat; there is no death screen, spectator view, or spawn protection.
- **Kills and scores are trusted.** The victim's client reports kills and the host's client keeps the score, so any client can forge them. Scores are not persisted.
- **Shooter-favoring hits** (see 6.6): lag can cause hits that look like dodges to the victim.
- **Position lag in hit checks:** the shooter tests against remote players' interpolated positions, which trail their true positions slightly.
- **Bullet wrap-around** lets shots cross a map edge and hit players on the other side, which may or may not be intended.
- **Remote players have unused physics bodies** that are reset every frame. They are not needed now that hits are distance-based.

### Performance and cost
- Network traffic is about 16 messages per second per moving player (1 per second when idle), plus bullet and hit events. This is still the main driver of Ably quota use as player counts grow. Possible next steps: lower the update rate, or send fewer fields.
- Bullets are created and destroyed per shot rather than pooled. This is fine at the current fire rate.
- `presence.get` is called on every join and leave to refresh the player count.

### Structure
- One monolithic scene file mixes networking, rendering, input, and game rules.
- Single hardcoded room, no way to separate groups of players.

### Resolved since the first version
- Presence updates removed from the per-movement hot path.
- Minimap, key objects, and health bar no longer rebuilt every frame.
- Per-bullet timers and per-bullet colliders replaced by group-level colliders and one lifetime loop.
- Double damage and "bullet passes through one player and hits another" bugs fixed by shooter-authoritative hit detection with bullet IDs.
- Reconnect no longer spawns duplicate players.

---

## 9. Suggested Roadmap

1. **Polish death and respawn:** death screen, spawn protection, spawn points away from enemies.
2. **Scoring:** deaths and K/D, rounds or match flow, persistent scores.
3. **Secure the connection:** token auth via a serverless function, and rotate the old key.
4. **Optimize networking further:** lower send rate, delta updates, client-side prediction if needed.
5. **Refactor** into modules (`network.js`, `player.js`, `world.js`, `hud.js`).
6. **Rooms/lobbies:** dynamic channel names (`room-<id>`), with a join/create UI.
7. **Longer term:** an authoritative server if cheating or fairness becomes a concern.
8. Content: weapons, pickups, player names, sound effects, mobile or touch controls.

---

## 10. Running Locally

1. Put `index.html`, `main.js`, and `style.css` in one folder.
2. Serve them over HTTP (for example `python3 -m http.server 8000`) and open `http://localhost:8000`.
3. Open the page in two or more browser tabs or windows. The status panel should show "Connected" and the player count should update.
4. Use WASD to move and the mouse to aim and fire.

An internet connection is required (CDN scripts and Ably).
