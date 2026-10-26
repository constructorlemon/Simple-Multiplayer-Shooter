// NOTE: this is obfuscation, not security. See README/notes: restrict the key's
// capabilities in the Ably dashboard (or move to token auth) for real protection.
const _AP = ["29", "54592c08", "59140349", "36133157", "3e0b2f48", "0321384e", "321f2608", "12226470", "6a014e3b", "5d402e10", "36023730", "030c0d02", "1c363334", "19254b46", "1e612419"];
const _AS = 'u8jzPde0IgxLd6GncfBAepf';
function getAblyKey() {
    const hex = _AP.slice().reverse().join('');
    let out = '';
    for (let i = 0; i < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ _AS.charCodeAt((i / 2) % _AS.length));
    }
    return out;
}

class GameScene extends Phaser.Scene {
    constructor() {
        super({ key: 'GameScene' });
        this.players = {};
        this.localPlayer = null;
        this.rocks = [];
        this.ably = null;
        this.channel = null;
        this.clientId = null;
        this.rockSeed = 12345;
        this.lastSentX = 0;
        this.lastSentY = 0;
        this.lastSentRot = 0;
        this.moveThreshold = 1;
        this.updateInterval = 60;
        this.heartbeatInterval = 1000;
        this.lastUpdateSent = 0;
        this.bulletLifetime = 2000;
        this.minimapPlayerDots = {};
        this.lastHpShown = null;
        this.bulletCounter = 0;
        this.remoteBulletsById = {};
        this.isHost = false;
        this.hostId = null;
        this.scores = {};
        this.lastLeaderboardText = '';
        this.respawnDelay = 2000;
        this.killFeed = [];
    }

    create() {
        this.baseMapSize = 1024;
        this.mapSize = this.baseMapSize;
        this.rockSeed = 12345;
        this.rockRng = this.seededRandom(this.rockSeed);
        
        this.physics.world.setBounds(0, 0, this.mapSize, this.mapSize);
        this.cameras.main.setBounds(0, 0, this.mapSize, this.mapSize);
        
        this.add.rectangle(this.mapSize/2, this.mapSize/2, this.mapSize, this.mapSize, 0x2d5a27).setDepth(-1);
        
        this.rocksGroup = this.physics.add.staticGroup();
        
        // One group + one collider per bullet type (instead of one per bullet)
        this.bulletGroup = this.physics.add.group();
        this.remoteBulletGroup = this.physics.add.group();
        const destroyBullet = (a, b) => (a.shooterId !== undefined ? a : b).destroy();
        this.physics.add.collider(this.bulletGroup, this.rocksGroup, destroyBullet);
        this.physics.add.collider(this.remoteBulletGroup, this.rocksGroup, destroyBullet);
        
        this.createRocks();
        this.createMinimap();
        this.createHealthBar();
        
        this.playerName = window.PLAYER_NAME || 'Player';
        this.createLeaderboard();
        // Host re-broadcasts the board every 5 s so late joiners and new hosts converge
        this.time.addEvent({ delay: 5000, loop: true, callback: () => { if (this.isHost) this.publishLeaderboard(); } });
        this.connectToAbly();
    }

    seededRandom(seed) {
        let s = seed;
        return function() {
            s = (s * 9301 + 49297) % 233280;
            return s / 233280;
        };
    }

    logMessage(msg) {
        const logEl = document.getElementById('message-log');
        if (!logEl) return;
        logEl.textContent = msg;
        setTimeout(() => {
            if (logEl.textContent === msg) {
                logEl.textContent = '';
            }
        }, 3000);
    }

    async connectToAbly() {
        const statusEl = document.getElementById('connection-status');
        
        try {
            this.clientId = 'player_' + Math.random().toString(36).substr(2, 11);
            this.ably = new Ably.Realtime({ 
                key: getAblyKey(), 
                clientId: this.clientId,
                echoMessages: false
            });
            this.channel = this.ably.channels.get('game-room');
            
            statusEl.textContent = 'Connecting...';
            
            this.ably.connection.on('connected', () => {
                statusEl.textContent = 'Connected';
                this.enterGame();
            });
            
            this.ably.connection.on('failed', (err) => {
                statusEl.textContent = 'Failed to connect';
                console.error(err);
            });
            
            this.channel.subscribe('player-update', (message) => {
                const data = message.data;
                if (data.clientId === this.clientId) return;
                this.updateRemotePlayer(data);
            });
            
            this.channel.subscribe('bullet', (message) => {
                const data = message.data;
                if (data.shooterId === this.clientId) return;
                this.createRemoteBullet(data);
            });
            
            this.channel.subscribe('hit', (message) => {
                const data = message.data;
                // The shooter decided this bullet hit someone: remove it everywhere
                const spent = this.remoteBulletsById[data.bulletId];
                if (spent) spent.destroy();
                if (data.targetId === this.clientId) this.takeDamage(data.damage, data.shooterId);
            });
            
            this.channel.subscribe('kill', (message) => {
                this.showKillFeed(message.data); // everyone sees who killed who
                if (this.isHost) this.processKill(message.data);
            });
            
            this.channel.subscribe('leaderboard', (message) => {
                if (this.isHost) return; // the host's own copy is the source of truth
                this.scores = message.data.scores || {};
                this.renderLeaderboard();
            });
            
            this.channel.presence.subscribe('enter', (member) => {
                if (member.clientId !== this.clientId) {
                    this.createRemotePlayer(member);
                    this.logMessage(this.nameOf(member.clientId) + ' joined');
                    if (this.isHost) this.publishLeaderboard();
                }
                this.updatePlayerCount();
            });
            
            this.channel.presence.subscribe('leave', (member) => {
                if (this.players[member.clientId]) {
                    this.logMessage(this.nameOf(member.clientId) + ' left');
                    this.removePlayer(member.clientId);
                }
                this.updatePlayerCount();
            });
            
        } catch (err) {
            console.error('Ably error:', err);
            statusEl.textContent = 'Error';
        }
    }

    getColorForClientId(id) {
        const colors = [0xff4444, 0x4444ff, 0x44ff44, 0xffff44, 0xff44ff, 0x44ffff, 0xff8800, 0x8800ff, 0x88ff00, 0xff0088];
        let hash = 5381;
        for (let i = 0; i < id.length; i++) {
            hash = ((hash << 5) + hash) + id.charCodeAt(i);
        }
        return colors[Math.abs(hash) % colors.length];
    }

    enterGame() {
        if (this.localPlayer) return; // 'connected' also fires on reconnect
        const color = this.getColorForClientId(this.clientId);
        
        const x = Phaser.Math.Between(200, this.mapSize - 200);
        const y = Phaser.Math.Between(200, this.mapSize - 200);
        
        const player = this.add.circle(x, y, 15, color);
        this.physics.add.existing(player);
        player.body.setCollideWorldBounds(false);
        player.body.setCircle(15);
        player.speed = 200;
        player.hp = 100;
        player.maxHp = 100;
        player.controls = { up: 'W', down: 'S', left: 'A', right: 'D' };
        player.keys = this.input.keyboard.addKeys(player.controls); // created once
        player.clientId = this.clientId;
        player.playerName = this.playerName;
        player.dead = false;
        this.addNameLabel(player);
        player.fillColor = color;
        player.targetX = x;
        player.targetY = y;
        player.targetRotation = 0;
        player.rotation = 0;
        player.lastUpdateTime = Date.now();
        
        this.cameras.main.startFollow(player, true, 0.1, 0.1);
        
        player.aimRect = this.add.rectangle(x, y, 4, 30, color);
        player.aimRect.setOrigin(0.5, 1);
        
        this.physics.add.collider(player, this.rocksGroup);
        
        player.lastShot = 0;
        player.shootRate = 250;
        
        this.localPlayer = player;
        this.players[this.clientId] = player;
        
        this.lastSentX = x;
        this.lastSentY = y;
        this.lastSentRot = 0;
        
        this.channel.presence.enter({
            x: player.x,
            y: player.y,
            hp: player.hp,
            color: color,
            rotation: 0,
            name: this.playerName
        }, (err) => {
            if (err) { console.error(err); return; }
            this.channel.presence.get((err2, members) => {
                if (!err2) {
                    members.forEach(member => {
                        if (member.clientId !== this.clientId) {
                            this.createRemotePlayer(member);
                        }
                    });
                }
                this.updatePlayerCount();
            });
        });
    }

    createRemotePlayer(member) {
        if (this.players[member.clientId]) {
            const p = this.players[member.clientId];
            const data = member.data || {};
            if (data.name) this.setPlayerName(p, data.name);
            const color = data.color !== undefined ? data.color : p.fillColor;
            if (color !== p.fillColor) {
                p.fillColor = color;
                p.setFillStyle(color);
                if (p.aimRect) p.aimRect.setFillStyle(color);
            }
            return;
        }
        
        const data = member.data || {};
        const x = data.x !== undefined ? data.x : Phaser.Math.Between(200, this.mapSize - 200);
        const y = data.y !== undefined ? data.y : Phaser.Math.Between(200, this.mapSize - 200);
        const color = data.color !== undefined ? data.color : this.getColorForClientId(member.clientId);
        
        const player = this.add.circle(x, y, 15, color);
        this.physics.add.existing(player);
        player.body.setCollideWorldBounds(false);
        player.body.setCircle(15);
        player.clientId = member.clientId;
        player.fillColor = color;
        player.hp = data.hp !== undefined ? data.hp : 100;
        player.maxHp = 100;
        player.targetX = x;
        player.targetY = y;
        player.targetRotation = data.rotation || 0;
        player.rotation = data.rotation || 0;
        player.lastUpdateTime = Date.now();
        
        player.aimRect = this.add.rectangle(x, y, 4, 30, color);
        player.aimRect.setOrigin(0.5, 1);
        player.aimRect.setRotation((data.rotation || 0) + Math.PI / 2);
        
        player.playerName = data.name || member.clientId.substr(7, 5);
        this.addNameLabel(player);
        this.applyAlive(player);
        this.players[member.clientId] = player;
    }

    updateRemotePlayer(data) {
        if (!this.players[data.clientId]) {
            this.createRemotePlayer({ clientId: data.clientId, data: data });
            return;
        }
        
        const player = this.players[data.clientId];
        if (player === this.localPlayer) return;
        
        const now = Date.now();
        player.targetX = data.x;
        player.targetY = data.y;
        player.hp = data.hp;
        this.applyAlive(player);
        player.lastUpdateTime = now;
        
        if (data.color !== undefined && data.color !== player.fillColor) {
            player.fillColor = data.color;
            player.setFillStyle(data.color);
            if (player.aimRect) player.aimRect.setFillStyle(data.color);
        }
        
        if (data.rotation !== undefined) {
            player.targetRotation = data.rotation;
        }
    }

    removePlayer(clientId) {
        if (this.players[clientId]) {
            if (this.players[clientId].aimRect) {
                this.players[clientId].aimRect.destroy();
            }
            if (this.players[clientId].nameText) this.players[clientId].nameText.destroy();
            this.players[clientId].destroy();
            delete this.players[clientId];
        }
        if (this.minimapPlayerDots[clientId]) {
            this.minimapPlayerDots[clientId].destroy();
            delete this.minimapPlayerDots[clientId];
        }
    }

    updatePlayerCount() {
        const playerCountEl = document.getElementById('player-count');
        if (!this.channel) return;
        this.channel.presence.get((err, members) => {
            if (err) return;
            playerCountEl.textContent = members.length;
            this.electHost(members);
        });
    }

    // The oldest presence entry (Ably server timestamp) is the host; clientId breaks ties.
    // When the host leaves, the next-oldest player takes over automatically.
    electHost(members) {
        if (!members.length) return;
        const sorted = members.slice().sort((a, b) =>
            (a.timestamp - b.timestamp) || (a.clientId < b.clientId ? -1 : 1));
        const wasHost = this.isHost;
        this.hostId = sorted[0].clientId;
        this.isHost = this.hostId === this.clientId;
        if (this.isHost && !wasHost) {
            this.logMessage('You are the host');
            this.publishLeaderboard();
        }
        this.renderLeaderboard();
    }

    nameOf(clientId) {
        const p = this.players[clientId];
        return (p && p.playerName) || clientId.substr(7, 5);
    }

    addNameLabel(player) {
        player.nameText = this.add.text(player.x, player.y - 22, player.playerName, {
            fontSize: '12px',
            color: '#ffffff',
            stroke: '#000000',
            strokeThickness: 3
        });
        player.nameText.setOrigin(0.5, 1);
        player.nameText.setDepth(10);
    }

    setPlayerName(player, name) {
        if (player.playerName === name) return;
        player.playerName = name;
        if (player.nameText) player.nameText.setText(name);
        this.renderLeaderboard();
    }

    // Dead players are drawn faded for everyone (HP 0 is already synced in player-update)
    applyAlive(player) {
        const a = player.hp > 0 ? 1 : 0.3;
        if (player.alpha === a) return;
        player.setAlpha(a);
        if (player.aimRect) player.aimRect.setAlpha(a);
        if (player.nameText) player.nameText.setAlpha(a);
    }

    // Runs on the victim's client. Reaching 0 HP counts as one kill for the shooter.
    takeDamage(damage, shooterId) {
        const p = this.localPlayer;
        if (!p || p.dead) return;
        p.hp = Math.max(0, p.hp - damage);
        if (p.hp > 0) return;
        p.dead = true;
        p.body.setVelocity(0);
        this.applyAlive(p);
        this.lastUpdateSent = 0; // push HP 0 to everyone on the next frame
        const kill = {
            killerId: shooterId,
            killerName: this.nameOf(shooterId),
            victimId: this.clientId,
            victimName: this.playerName
        };
        this.channel.publish('kill', kill);
        this.showKillFeed(kill); // own messages are not echoed back
        if (this.isHost) this.processKill(kill); // own messages are not echoed back
        this.time.delayedCall(this.respawnDelay, () => this.respawnLocalPlayer());
    }

    respawnLocalPlayer() {
        const p = this.localPlayer;
        if (!p) return;
        const x = Phaser.Math.Between(200, this.mapSize - 200);
        const y = Phaser.Math.Between(200, this.mapSize - 200);
        p.setPosition(x, y);
        p.body.reset(x, y);
        p.hp = p.maxHp;
        p.dead = false;
        this.applyAlive(p);
        this.lastUpdateSent = 0;
    }

    // Kill notifications: stacked at the top-center, fade after ~4 s, max 4 at once.
    // Yellow when you are the killer or the victim.
    showKillFeed(kill) {
        const killer = kill.killerName || this.nameOf(kill.killerId);
        const victim = kill.victimName || this.nameOf(kill.victimId);
        const mine = kill.killerId === this.clientId || kill.victimId === this.clientId;
        const t = this.add.text(400, 0, killer + ' killed ' + victim, {
            fontSize: '14px',
            color: mine ? '#ffff00' : '#ffffff',
            stroke: '#000000',
            strokeThickness: 3
        });
        t.setOrigin(0.5, 0);
        t.setScrollFactor(0);
        t.setDepth(100);
        this.killFeed.push(t);
        if (this.killFeed.length > 4) {
            const oldest = this.killFeed.shift();
            this.tweens.killTweensOf(oldest);
            oldest.destroy();
        }
        this.layoutKillFeed();
        this.tweens.add({
            targets: t,
            alpha: 0,
            delay: 3500,
            duration: 500,
            onComplete: () => {
                const i = this.killFeed.indexOf(t);
                if (i !== -1) this.killFeed.splice(i, 1);
                t.destroy();
                this.layoutKillFeed();
            }
        });
    }

    layoutKillFeed() {
        this.killFeed.forEach((t, i) => t.setY(12 + i * 20));
    }

    // --- Host-managed global kill leaderboard ---
    processKill(data) {
        const known = this.players[data.killerId];
        const entry = this.scores[data.killerId] || { name: this.nameOf(data.killerId), kills: 0 };
        if (known) entry.name = known.playerName;
        entry.kills += 1;
        this.scores[data.killerId] = entry;
        this.publishLeaderboard();
        this.renderLeaderboard();
    }

    publishLeaderboard() {
        const top = Object.entries(this.scores).sort((a, b) => b[1].kills - a[1].kills).slice(0, 20);
        this.scores = Object.fromEntries(top);
        if (this.channel) this.channel.publish('leaderboard', { scores: this.scores });
    }

    createLeaderboard() {
        this.leaderboardText = this.add.text(790, 10, '', {
            fontSize: '13px',
            color: '#ffffff',
            align: 'right',
            backgroundColor: 'rgba(0,0,0,0.55)',
            padding: { x: 8, y: 6 },
            lineSpacing: 3
        });
        this.leaderboardText.setOrigin(1, 0);
        this.leaderboardText.setScrollFactor(0);
        this.leaderboardText.setDepth(100);
    }

    renderLeaderboard() {
        if (!this.leaderboardText) return;
        const rows = {};
        for (const id in this.scores) rows[id] = { name: this.scores[id].name, kills: this.scores[id].kills };
        for (const id in this.players) {
            if (!rows[id]) rows[id] = { name: this.players[id].playerName, kills: 0 };
            else rows[id].name = this.players[id].playerName;
        }
        const list = Object.keys(rows)
            .map((id) => ({ id: id, name: rows[id].name, kills: rows[id].kills }))
            .sort((a, b) => (b.kills - a.kills) || a.name.localeCompare(b.name))
            .slice(0, 8);
        const lines = ['LEADERBOARD'];
        list.forEach((r, i) => {
            lines.push((i + 1) + '. ' + (r.id === this.hostId ? '\u2605 ' : '') + r.name +
                (r.id === this.clientId ? ' (you)' : '') + '  ' + r.kills);
        });
        const text = lines.join('\n');
        if (text !== this.lastLeaderboardText) { // only re-render the text when it changes
            this.lastLeaderboardText = text;
            this.leaderboardText.setText(text);
        }
    }

    createMinimap() {
        const minimapSize = 150;
        const padding = 10;
        this.minimapX = padding;
        this.minimapY = 600 - minimapSize - padding;
        this.minimapScale = minimapSize / this.mapSize;
        
        this.minimapBg = this.add.rectangle(
            this.minimapX + minimapSize/2,
            this.minimapY + minimapSize/2,
            minimapSize,
            minimapSize,
            0x000000,
            0.7
        );
        this.minimapBg.setScrollFactor(0);
        this.minimapBg.setDepth(100);
        
        this.minimapBorder = this.add.rectangle(
            this.minimapX + minimapSize/2,
            this.minimapY + minimapSize/2,
            minimapSize,
            minimapSize
        );
        this.minimapBorder.setStrokeStyle(2, 0xffffff);
        this.minimapBorder.setScrollFactor(0);
        this.minimapBorder.setDepth(101);
        this.minimapBorder.setFillStyle(0x000000, 0);
        
        // Rocks never move, so their dots are created once
        for (const rock of this.rocks) {
            const dot = this.add.circle(
                this.minimapX + rock.body.x * this.minimapScale,
                this.minimapY + rock.body.y * this.minimapScale,
                2,
                0x888888
            );
            dot.setScrollFactor(0);
            dot.setDepth(102);
        }
    }

    updateMinimap() {
        // Player dots are persistent; just reposition them
        for (const clientId in this.players) {
            const player = this.players[clientId];
            const color = player.fillColor || 0xff0000;
            let dot = this.minimapPlayerDots[clientId];
            if (!dot) {
                dot = this.add.circle(0, 0, 3, color);
                dot.setScrollFactor(0);
                dot.setDepth(103);
                dot.cachedColor = color;
                this.minimapPlayerDots[clientId] = dot;
            } else if (dot.cachedColor !== color) {
                dot.setFillStyle(color);
                dot.cachedColor = color;
            }
            dot.setPosition(
                this.minimapX + player.x * this.minimapScale,
                this.minimapY + player.y * this.minimapScale
            );
        }
    }

    createRocks() {
        this.rockRng = this.seededRandom(this.rockSeed);
        const rockCount = 12;
        for (let i = 0; i < rockCount; i++) {
            this.addRockSeeded();
        }
    }

    addRockSeeded() {
        const x = Math.floor(this.rockRng() * (this.mapSize - 160)) + 80;
        const y = Math.floor(this.rockRng() * (this.mapSize - 160)) + 80;
        this.addRockAt(x, y);
    }

    addRockAt(x, y) {
        x = Math.max(60, Math.min(this.mapSize - 60, x));
        y = Math.max(60, Math.min(this.mapSize - 60, y));
        
        const rng = this.seededRandom(this.rockSeed + Math.floor(x) * 1000 + Math.floor(y));
        const points = [];
        const sides = Math.floor(rng() * 3) + 5;
        let maxRadius = 0;
        for (let i = 0; i < sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const radius = Math.floor(rng() * 15) + 18;
            if (radius > maxRadius) maxRadius = radius;
            points.push({
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius
            });
        }
        
        const rock = this.add.graphics();
        rock.fillStyle(0x666666);
        rock.beginPath();
        rock.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            rock.lineTo(points[i].x, points[i].y);
        }
        rock.closePath();
        rock.fillPath();
        rock.setPosition(x, y);
        
        const rockBody = this.add.circle(x, y, maxRadius * 0.7, 0x666666, 0);
        this.physics.add.existing(rockBody, true);
        rockBody.body.setCircle(maxRadius * 0.7);
        rockBody.setVisible(false);
        
        this.rocksGroup.add(rockBody);
        this.rocks.push({ graphics: rock, body: rockBody });
    }

    createHealthBar() {
        const barWidth = 200;
        const barHeight = 20;
        const x = 10;
        const y = 10;
        
        this.healthBarBg = this.add.rectangle(x + barWidth/2, y + barHeight/2, barWidth, barHeight, 0x000000, 0.7);
        this.healthBarBg.setScrollFactor(0);
        this.healthBarBg.setDepth(100);
        
        this.healthBarBorder = this.add.rectangle(x + barWidth/2, y + barHeight/2, barWidth, barHeight);
        this.healthBarBorder.setStrokeStyle(2, 0xffffff);
        this.healthBarBorder.setScrollFactor(0);
        this.healthBarBorder.setDepth(101);
        this.healthBarBorder.setFillStyle(0x000000, 0);
        
        this.healthBar = this.add.rectangle(x + 2, y + 2, barWidth - 4, barHeight - 4, 0x00ff00);
        this.healthBar.setOrigin(0, 0);
        this.healthBar.setScrollFactor(0);
        this.healthBar.setDepth(102);
        
        this.healthText = this.add.text(x + barWidth/2, y + barHeight/2, '100/100', {
            fontSize: '12px',
            fill: '#ffffff',
            fontStyle: 'bold'
        });
        this.healthText.setOrigin(0.5, 0.5);
        this.healthText.setScrollFactor(0);
        this.healthText.setDepth(103);
    }

    updateHealthBar() {
        if (!this.healthBar || !this.localPlayer) return;
        const player = this.localPlayer;
        const hp = Math.max(0, Math.floor(player.hp));
        if (hp === this.lastHpShown) return; // only redraw when HP changes
        this.lastHpShown = hp;
        
        const hpPercent = hp / player.maxHp;
        this.healthBar.setScale(hpPercent, 1);
        this.healthBar.setPosition(12, 12);
        
        if (hpPercent < 0.3) {
            this.healthBar.setFillStyle(0xff0000);
        } else if (hpPercent < 0.6) {
            this.healthBar.setFillStyle(0xffff00);
        } else {
            this.healthBar.setFillStyle(0x00ff00);
        }
        
        this.healthText.setText(hp + '/' + player.maxHp);
    }

    update(time) {
        if (!this.localPlayer) return;
        
        const player = this.localPlayer;
        const body = player.body;
        const keys = player.keys;
        
        body.setVelocity(0);
        if (!player.dead && keys.up.isDown) body.setVelocityY(-player.speed);
        if (!player.dead && keys.down.isDown) body.setVelocityY(player.speed);
        if (!player.dead && keys.left.isDown) body.setVelocityX(-player.speed);
        if (!player.dead && keys.right.isDown) body.setVelocityX(player.speed);
        
        body.velocity.normalize().scale(player.speed);
        
        if (player.x < 0) player.x = this.mapSize;
        if (player.x > this.mapSize) player.x = 0;
        if (player.y < 0) player.y = this.mapSize;
        if (player.y > this.mapSize) player.y = 0;
        
        const now = Date.now();
        for (let clientId in this.players) {
            if (clientId === this.clientId) continue;
            const p = this.players[clientId];
            if (p.targetX !== undefined && p.targetY !== undefined) {
                const timeSinceUpdate = now - (p.lastUpdateTime || now);
                const lerpFactor = Math.min(0.3, timeSinceUpdate / 60);
                p.x += (p.targetX - p.x) * lerpFactor;
                p.y += (p.targetY - p.y) * lerpFactor;
                if (p.body) p.body.reset(p.x, p.y);
                
                if (p.targetRotation !== undefined && p.aimRect) {
                    let rotDiff = p.targetRotation - p.rotation;
                    while (rotDiff > Math.PI) rotDiff -= 2 * Math.PI;
                    while (rotDiff < -Math.PI) rotDiff += 2 * Math.PI;
                    p.rotation += rotDiff * 0.25;
                    p.aimRect.setPosition(p.x, p.y);
                    p.aimRect.setRotation(p.rotation + Math.PI / 2);
                }
            }
        }
        
        for (const id in this.players) {
            const lp = this.players[id];
            if (lp.nameText) lp.nameText.setPosition(lp.x, lp.y - 22);
        }
        
        const pointer = this.input.activePointer;
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        
        if (player.aimRect) {
            const angle = Phaser.Math.Angle.Between(player.x, player.y, worldPoint.x, worldPoint.y);
            player.aimRect.setPosition(player.x, player.y);
            player.aimRect.setRotation(angle + Math.PI / 2);
            player.rotation = angle;
            
            const distMoved = Math.sqrt(Math.pow(player.x - this.lastSentX, 2) + Math.pow(player.y - this.lastSentY, 2));
            const rotDiff = Math.abs(angle - this.lastSentRot);
            const moved = distMoved > this.moveThreshold || rotDiff > 0.05;
            const sinceLast = now - this.lastUpdateSent;
            
            // Send on movement (max ~16/s), or a slow heartbeat so idle players
            // stay in sync for late joiners. Presence is no longer updated here.
            if (this.channel && sinceLast >= this.updateInterval && (moved || sinceLast >= this.heartbeatInterval)) {
                this.channel.publish('player-update', {
                    clientId: this.clientId,
                    x: Math.round(player.x * 10) / 10,
                    y: Math.round(player.y * 10) / 10,
                    hp: player.hp,
                    rotation: Math.round(angle * 100) / 100
                });
                this.lastSentX = player.x;
                this.lastSentY = player.y;
                this.lastSentRot = angle;
                this.lastUpdateSent = now;
            }
        }
        
        if (!player.dead && pointer.isDown && time - player.lastShot > player.shootRate) {
            this.shootBullet(player, worldPoint);
            player.lastShot = time;
        }
        
        // Hit detection for my bullets against remote players
        const shots = this.bulletGroup.getChildren();
        for (let i = shots.length - 1; i >= 0; i--) {
            const bullet = shots[i];
            if (!bullet.active) continue;
            for (let clientId in this.players) {
                if (clientId === this.clientId) continue;
                const targetPlayer = this.players[clientId];
                if (targetPlayer.hp <= 0) continue; // already dead
                const dist = Phaser.Math.Distance.Between(bullet.x, bullet.y, targetPlayer.x, targetPlayer.y);
                if (dist < 18) {
                    this.channel.publish('hit', {
                        targetId: clientId,
                        damage: 10,
                        shooterId: this.clientId,
                        bulletId: bullet.bulletId
                    });
                    bullet.destroy();
                    break;
                }
            }
        }
        
        const sceneNow = this.time.now;
        this.updateBullets(this.bulletGroup, sceneNow);
        this.updateBullets(this.remoteBulletGroup, sceneNow);
        
        this.updateMinimap();
        this.updateHealthBar();
    }

    // Lifetime expiry + screen wrap for every bullet in a group (replaces per-bullet timers)
    updateBullets(group, now) {
        const list = group.getChildren();
        for (let i = list.length - 1; i >= 0; i--) {
            const b = list[i];
            if (now >= b.expireAt) { b.destroy(); continue; }
            if (b.x < 0) b.x = this.mapSize;
            else if (b.x > this.mapSize) b.x = 0;
            if (b.y < 0) b.y = this.mapSize;
            else if (b.y > this.mapSize) b.y = 0;
        }
    }

    shootBullet(player, target) {
        const angle = Phaser.Math.Angle.Between(player.x, player.y, target.x, target.y);
        const vx = Math.cos(angle) * 400;
        const vy = Math.sin(angle) * 400;
        const bullet = this.add.circle(
            player.x + Math.cos(angle) * 25,
            player.y + Math.sin(angle) * 25,
            3,
            0xffff00
        );
        this.bulletGroup.add(bullet);
        bullet.body.setCircle(3);
        bullet.body.setVelocity(vx, vy); // after group.add (which resets velocity)
        bullet.expireAt = this.time.now + this.bulletLifetime;
        bullet.shooterId = player.clientId;
        bullet.bulletId = this.clientId + ':' + (this.bulletCounter++);
        
        if (this.channel) {
            this.channel.publish('bullet', {
                shooterId: this.clientId,
                bulletId: bullet.bulletId,
                x: Math.round(bullet.x * 10) / 10,
                y: Math.round(bullet.y * 10) / 10,
                vx: vx,
                vy: vy
            });
        }
    }

    createRemoteBullet(data) {
        const bullet = this.add.circle(data.x, data.y, 3, 0xffff00);
        this.remoteBulletGroup.add(bullet);
        bullet.body.setCircle(3);
        bullet.body.setVelocity(data.vx, data.vy);
        bullet.expireAt = this.time.now + this.bulletLifetime;
        bullet.shooterId = data.shooterId;
        bullet.bulletId = data.bulletId;
        this.remoteBulletsById[data.bulletId] = bullet;
        bullet.once('destroy', () => { delete this.remoteBulletsById[data.bulletId]; });
    }

}

const config = {
    type: Phaser.AUTO,
    width: 800,
    height: 600,
    parent: 'game',
    backgroundColor: '#1a1a1a',
    physics: {
        default: 'arcade',
        arcade: {
            gravity: { y: 0 },
            debug: false
        }
    },
    scene: [GameScene]
};

let gameStarted = false;
function startGame(name) {
    if (gameStarted) return;
    gameStarted = true;
    window.PLAYER_NAME = name;
    new Phaser.Game(config);
}

// Ask for a name before anything connects
(function setupNameScreen() {
    const screen = document.getElementById('name-screen');
    const input = document.getElementById('name-input');
    const button = document.getElementById('join-btn');
    function submit() {
        let name = input.value.replace(/\s+/g, ' ').trim().slice(0, 12);
        if (!name) name = 'Player' + Math.floor(100 + Math.random() * 900);
        screen.classList.add('hidden');
        input.blur();
        startGame(name);
    }
    button.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
})();
