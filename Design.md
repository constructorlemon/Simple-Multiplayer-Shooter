# Design Document: Top Down Shooter (Multiplayer Proof of Concept)

## 1. Overview

A browser-based, top-down arena shooter proof of concept (PoC). Players are colored circles that move around a shared 1024×1024 map, aim with the mouse, and shoot each other. Real-time multiplayer is handled client-side through **Ably** (pub/sub + presence), and the game itself is rendered and simulated with **Phaser 3** (Arcade Physics).

There is no game server. Every browser client runs its own simulation and talks to the others through a single shared Ably channel.

**Goals of the PoC**
- Prove that Phaser + Ably can deliver real-time shared movement, shooting, and damage without a custom backend.
- Provide a minimal but playable loop: join, move, aim, shoot, take damage.

**Non-goals (not yet implemented)**
- Death/respawn, scoring, win conditions
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
| Hosting | Any static file host (no backend required) |

---

## 3. File Structure

| File | Role |
|---|---|
| `index.html` | Entry point. Loads Phaser, Ably, and `main.js`. Contains the `#game` canvas mount and a status UI (player count, connection status, message log). |
| `main.js` | **The actual game.** A single Phaser scene (`GameScene`) containing all game logic and networking. |
| `style.css` | Page layout, dark background, status panel styling. |
| `game.js` | **Legacy / unused.** An earlier offline 2-player local prototype (WASD + Arrow keys on one keyboard, plain Canvas 2D). Not referenced by `index.html`. It expects DOM elements (`gameCanvas`, `p1-hp`, `game-over`, etc.) that no longer exist. Safe to delete or archive. |

---

## 4. Gameplay

### 4.1 Controls
| Input | Action |
|---|---|
| `W` `A` `S` `D` | Move (8-direction, diagonal speed normalized) |
| Mouse position | Aim (a bar rotates around the player toward the cursor) |
| Hold left mouse button | Fire (rate limited to one shot per 250 ms) |

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
| Fire rate | 250 ms between shots |
| Rock count | 12 |

### 4.3 World
- A flat green rectangular arena.
- **12 procedurally shaped rocks** act as static obstacles. They block players and destroy bullets.
- **Screen wrap:** players and bullets that leave one edge of the map re-appear on the opposite edge (`player.x < 0` becomes `mapSize`, etc.).
- The camera follows the local player with smoothing (lerp 0.1) and is clamped to the map bounds.

### 4.4 HUD
- **Health bar** (top-left): green above 60%, yellow 30–60%, red below 30%, with numeric `hp/100` text.
- **Minimap** (bottom-left, 150×150): shows rocks (grey) and all players (their color).
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
| Combat | `shootBullet()`, `createRemoteBullet()` |
| Game loop | `update(time)` (input, interpolation, send updates, hit detection, HUD refresh) |

### 5.3 Player representation
Each player is a Phaser `Arc` (circle) with an Arcade body, plus a separate `Rectangle` (`aimRect`) acting as the aim indicator. The local player additionally has `controls`, `speed`, `shootRate`, and `lastShot`. Remote players carry `targetX/targetY/targetRotation` for interpolation.

---

## 6. Networking Design

### 6.1 Connection and identity
- On start, the client creates an Ably Realtime connection with a random `clientId` (`player_` + 11 random base-36 characters).
- All clients join one hardcoded channel: **`game-room`**.
- Color is derived deterministically from the `clientId` via a djb2-style hash into a 10-color palette, and also broadcast so peers agree.
- The local player spawns at a random position at least 200 px from the map edges, after the connection reports `connected`.

### 6.2 Messages

| Channel event | Sender | Payload | Receiver behavior |
|---|---|---|---|
| `player-update` | Each client, on movement/rotation change | `{ clientId, x, y, hp, rotation, color }` | Ignore if self. Otherwise set interpolation targets, HP, rotation, color. Creates the remote player if unknown. |
| `bullet` | Shooter, on fire | `{ shooterId, x, y, vx, vy }` | Ignore if self. Spawn a local bullet with the same velocity. |
| `hit` | Whoever detects a hit | `{ targetId, damage, shooterId }` | If `targetId` is self, subtract `damage` from local HP (floored at 0). |
| Presence `enter` | Ably | `{ x, y, hp, color, rotation }` | Create the remote player; log "joined"; refresh count. |
| Presence `leave` | Ably | member | Remove the player; log "left"; refresh count. |

Presence is also used to hydrate state on join (`presence.get`) and is updated alongside each `player-update`.

### 6.3 Update throttling
A position update is sent only when **both** are true:
1. At least `updateInterval` (60 ms, about 16 Hz) has passed since the last send, and
2. The player moved more than `moveThreshold` (1 px) **or** rotated more than 0.05 rad since the last send.

### 6.4 Smoothing remote players
Each frame, remote players lerp toward their latest received target position (factor up to 0.3) and shortest-arc lerp their rotation (factor 0.25). This hides the 16 Hz update rate.

### 6.5 Deterministic world
Rock layout is generated locally from a fixed seed (`12345`) using a simple linear congruential generator, so all clients build an identical map **without sending any map data**. Individual rock shapes are also seeded from their coordinates.

### 6.6 Hit detection model
Damage is **client-reported, not server-validated**. There are two detection paths:
- **Shooter-side:** in `update()`, for each of the local player's bullets, if it is within 18 px of any remote player, publish `hit`.
- **Victim-side:** each remote bullet has an overlap check against the local player; on overlap, publish `hit`.

The victim applies the damage when it receives a `hit` addressed to it.

---

## 7. Game Loop (per frame)

1. Read WASD, set velocity, normalize for diagonals.
2. Wrap player position at map edges.
3. Interpolate all remote players toward their targets.
4. Compute aim angle from the mouse (screen to world coordinates), update the aim bar.
5. If throttle conditions are met, publish `player-update` and update presence.
6. If the mouse is held and the cooldown has elapsed, spawn and broadcast a bullet.
7. Check local bullets against remote players, publishing `hit` on contact.
8. Redraw the minimap and the health bar.

---

## 8. Known Issues and Risks

### Security
- **The Ably API key is hardcoded in `main.js` and visible to anyone who loads the page.** This is a full key with whatever capabilities were configured in the Ably dashboard, so anyone can use it to publish arbitrary messages, impersonate players, or consume the account's message quota. Because it was shared in plain text, treat it as compromised: **rotate it**.
  - For anything beyond local testing, switch to **Ably token authentication**, where a small backend endpoint (or serverless function) issues short-lived tokens. Restrict capabilities to the `game-room` channel with only `publish`, `subscribe`, and `presence`.
- **Clients are fully trusted.** Any peer can publish `hit` events against anyone, or fake its own position and HP. This is acceptable for a PoC, but not for a public game.

### Gameplay and logic
- **Possible double damage.** Both the shooter's and the victim's clients may detect the same hit and each publish a `hit` event. The bullet is destroyed locally on each side, but the other client's copy may still register the hit. Pick one authority (for example the victim only, or the shooter only).
- **No death state.** HP is floored at 0, but nothing happens: there is no respawn, kill count, or game over. HP also is not restored.
- **Rock layout depends on the constant seed only.** Collisions between players are not implemented (players overlap freely).
- **Bullet wrap-around** means shots can cross the map edge and hit players on the other side, which may or may not be intended.

### Performance and cost
- **Message volume.** Each active player sends up to about 16 `player-update` messages per second, plus a presence update with the same cadence, doubling the traffic. This will burn through Ably's free-tier message quota quickly with more than a few players. Consider dropping the presence update from the hot path (use presence only on join/leave) and sending deltas.
- **Minimap is rebuilt every frame**: all dots are destroyed and recreated each `update()`. Reuse the objects and move them instead.
- **`addKey()` is called every frame** for each movement key. Create the keys once in `create()`.
- **Bullet timers leak.** Each bullet creates a looping 50 ms time event for wrap-around that is never removed when the bullet is destroyed. Over a long session this accumulates.
- **Colliders per bullet.** A new `physics.add.collider`/`overlap` is created for every bullet and never cleaned up. Prefer a single physics group with one collider.
- `this.bullets` and `this.remoteBullets` arrays are never pruned of destroyed bullets.

### Structure
- One monolithic scene file (about 675 lines) mixes networking, rendering, input, and game rules.
- Single hardcoded room, no way to separate groups of players.
- `game.js` is dead code and `style.css` has an unused `#add-player` rule.

---

## 9. Suggested Roadmap

1. **Secure the connection:** rotate the key, add token auth.
2. **Fix hit authority** to avoid double damage; add death and respawn with a brief invulnerability window.
3. **Add scoring:** kills/deaths, scoreboard, round or match flow.
4. **Optimize networking:** drop presence updates from the hot path, send deltas, consider client-side prediction/reconciliation as needed.
5. **Clean up performance leaks:** pooled bullets, a single collider, persistent minimap objects.
6. **Refactor** into modules (`network.js`, `player.js`, `world.js`, `hud.js`).
7. **Rooms/lobbies:** dynamic channel names (`room-<id>`), with a join/create UI.
8. **Longer term:** an authoritative server (for example Node + a WebSocket or Ably-backed server process) if cheating or fairness becomes a concern.
9. Content: weapons, pickups, player names, sound effects, mobile or touch controls.

---

## 10. Running Locally

1. Put `index.html`, `main.js`, and `style.css` in one folder.
2. Serve them over HTTP (for example `python3 -m http.server 8000`) and open `http://localhost:8000`.
3. Open the page in two or more browser tabs or windows. The status panel should show "Connected" and the player count should update.
4. Use WASD to move and the mouse to aim and fire.

An internet connection is required (CDN scripts and Ably).
