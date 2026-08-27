'use strict';

// ── DayzManager : suivi temps réel d'un serveur DayZ via ses logs ADM ──
// Le serveur DayZ écrit un fichier "*.ADM" (Admin Log) qui contient, entre
// autres, les connexions/déconnexions et les kills avec la position (x,y,z)
// des deux joueurs au moment du kill. On "tail" ce fichier pour :
//  1) créer automatiquement un compte économie quand un joueur rejoint,
//  2) compter kills/deaths/temps de jeu,
//  3) vérifier si un kill a eu lieu dans une "safe zone" configurée et,
//     si oui, bannir automatiquement le tueur via RCon (BattlEye).
//
// ⚠️ Le format exact des lignes ADM peut varier légèrement selon la version
// DayZ et les mods installés (Expansion, VPPAdminTools, CF, etc.). Les
// regex ci-dessous couvrent le format vanilla standard ; si ton serveur a
// un format différent, il faudra ajuster PATTERNS ci-dessous (dis-le moi
// et je les corrige avec un extrait réel de ton .ADM).

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { pool } = require('./db');
const { runOnce: rconRunOnce } = require('./dayzRcon');

const POLL_INTERVAL_MS = 2000;

const PATTERNS = {
  // 18:00:05 | Player "Bob" (id=765xxxxx pos=<1234.5, 300.2, 6789.1>) is connected
  connect: /Player "([^"]+)"\s*\(id=([\w]+)[^)]*pos=<([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)>\)\s*is connected/i,
  // 18:10:00 | Player "Bob" (id=765xxxxx pos=<...>) has been disconnected
  disconnect: /Player "([^"]+)"\s*\(id=([\w]+)[^)]*\)\s*has been disconnected/i,
  // 18:05:23 | Player "Bob" (id=765... pos=<x,y,z>) has been killed by Player "Alice" (id=765... pos=<x,y,z>) ...
  kill: /Player "([^"]+)"\s*\(id=([\w]+)[^)]*pos=<([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)>\)\s*has been killed by Player "([^"]+)"\s*\(id=([\w]+)[^)]*pos=<([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)>\)/i,
};

// ── Économie / stats (SQL, scopé tenant_id) ──────────────────────────

async function ensurePlayer(tenantId, steamId, playerName) {
  await pool.query(
    `INSERT INTO dayz_players (tenant_id, steam_id, player_name)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE player_name = VALUES(player_name), last_seen = CURRENT_TIMESTAMP`,
    [tenantId, steamId, playerName || null]
  );
}

async function getPlayerBySteamId(tenantId, steamId) {
  const [rows] = await pool.query('SELECT * FROM dayz_players WHERE tenant_id = ? AND steam_id = ? LIMIT 1', [tenantId, steamId]);
  return rows[0] || null;
}

async function getPlayerByDiscordId(tenantId, discordId) {
  const [rows] = await pool.query('SELECT * FROM dayz_players WHERE tenant_id = ? AND discord_id = ? LIMIT 1', [tenantId, discordId]);
  return rows[0] || null;
}

async function getPlayerByNameOrSteamId(tenantId, needle) {
  const [rows] = await pool.query(
    'SELECT * FROM dayz_players WHERE tenant_id = ? AND (steam_id = ? OR player_name = ?) LIMIT 1',
    [tenantId, needle, needle]
  );
  return rows[0] || null;
}

// Lie un steamId à un compte Discord (réservé au staff whitelisté, cf.
// dayzCommands.js). Crée le joueur s'il n'existe pas encore (staff peut
// pré-lier un compte avant même la première connexion en jeu).
async function linkDiscord(tenantId, steamId, discordId) {
  await pool.query(
    `INSERT INTO dayz_players (tenant_id, steam_id, discord_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id)`,
    [tenantId, steamId, discordId]
  );
  return getPlayerBySteamId(tenantId, steamId);
}

// Crédite/débite le solde d'un joueur (montant négatif = retrait).
// Réservé au staff whitelisté (vérifié côté dayzCommands.js).
async function addBalance(tenantId, steamId, amount, givenByDiscordId, reason) {
  await pool.query(
    `INSERT INTO dayz_players (tenant_id, steam_id, balance) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
    [tenantId, steamId, amount]
  );
  await pool.query(
    `INSERT INTO dayz_transactions (tenant_id, target_steam_id, amount, given_by_discord_id, reason)
     VALUES (?, ?, ?, ?, ?)`,
    [tenantId, steamId, amount, givenByDiscordId, reason || null]
  );
  return getPlayerBySteamId(tenantId, steamId);
}

async function recordConnect(tenantId, steamId, playerName) {
  await ensurePlayer(tenantId, steamId, playerName);
  await pool.query(
    'UPDATE dayz_players SET last_connect_at = ?, player_name = ? WHERE tenant_id = ? AND steam_id = ?',
    [Date.now(), playerName || null, tenantId, steamId]
  );
}

async function recordDisconnect(tenantId, steamId) {
  const player = await getPlayerBySteamId(tenantId, steamId);
  if (!player || !player.last_connect_at) return;
  const deltaSec = Math.max(0, Math.round((Date.now() - Number(player.last_connect_at)) / 1000));
  await pool.query(
    'UPDATE dayz_players SET playtime_seconds = playtime_seconds + ?, last_connect_at = NULL WHERE tenant_id = ? AND steam_id = ?',
    [deltaSec, tenantId, steamId]
  );
}

async function recordKill(tenantId, killerSteamId, killerName, victimSteamId, victimName) {
  await ensurePlayer(tenantId, killerSteamId, killerName);
  await ensurePlayer(tenantId, victimSteamId, victimName);
  await pool.query('UPDATE dayz_players SET kills = kills + 1 WHERE tenant_id = ? AND steam_id = ?', [tenantId, killerSteamId]);
  await pool.query('UPDATE dayz_players SET deaths = deaths + 1 WHERE tenant_id = ? AND steam_id = ?', [tenantId, victimSteamId]);
}

// type: 'money' | 'kills' | 'ratio' (kills/deaths, deaths=0 traité comme 1)
async function getLeaderboard(tenantId, type, limit = 10) {
  const orderBy =
    type === 'kills'
      ? 'kills DESC'
      : type === 'ratio'
      ? '(kills / GREATEST(deaths, 1)) DESC, kills DESC'
      : 'balance DESC';
  const [rows] = await pool.query(
    `SELECT steam_id, player_name, discord_id, balance, kills, deaths, playtime_seconds,
            (kills / GREATEST(deaths, 1)) AS ratio
     FROM dayz_players
     WHERE tenant_id = ?
     ORDER BY ${orderBy}
     LIMIT ?`,
    [tenantId, limit]
  );
  return rows;
}

function distance2D(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

// Parse la sortie de la commande RCon "players" (format BE standard) :
//   [#] [IP Address]:[Port] [Ping] [GUID] [Name]
//   ---------------------------------------------------
//   0   1.2.3.4:2304        50   xxxxxxxxxxxxxxxx(OK) Bob
// Exporté pour être réutilisé par les commandes Discord (kick/ban par
// nom, qui doivent passer par le n° de slot côté BE RCon).
function findPlayerSlot(playersOutput, name) {
  const lines = String(playersOutput || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+[\d.:]+\s+\d+\s+\S+\s+(.+?)\s*$/);
    if (m && m[2].trim().toLowerCase() === name.trim().toLowerCase()) {
      return Number(m[1]);
    }
  }
  return null;
}

// ── DayzWatcher : UN watcher par tenant ──────────────────────────────
class DayzWatcher extends EventEmitter {
  constructor(tenantId, store) {
    super();
    this.tenantId = tenantId;
    this.store = store;
    this._timer = null;
    this._filePath = null;
    this._offset = 0;
    this._running = false;
  }

  start() {
    if (this._running) return;
    const dayz = this.store.getDayz();
    if (!dayz.enabled || !dayz.admLogDir) {
      this.emit('log', "DayZ : module désactivé ou dossier de logs ADM non configuré, watcher non démarré.");
      return;
    }
    this._running = true;
    this._poll().catch((err) => this.emit('log', `Erreur watcher DayZ : ${err.message}`));
    this._timer = setInterval(() => {
      this._poll().catch((err) => this.emit('log', `Erreur watcher DayZ : ${err.message}`));
    }, POLL_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
    this.emit('log', `📡 Watcher DayZ démarré (dossier : ${dayz.admLogDir}).`);
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _pickLatestAdmFile(dir) {
    const files = await fs.promises.readdir(dir).catch(() => []);
    const admFiles = files.filter((f) => f.toLowerCase().endsWith('.adm'));
    if (!admFiles.length) return null;
    const stats = await Promise.all(
      admFiles.map(async (f) => {
        const full = path.join(dir, f);
        try {
          const s = await fs.promises.stat(full);
          return { full, mtimeMs: s.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    const valid = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
    return valid[0]?.full || null;
  }

  async _poll() {
    const dayz = this.store.getDayz();
    if (!dayz.enabled || !dayz.admLogDir) return;

    const latest = await this._pickLatestAdmFile(dayz.admLogDir);
    if (!latest) return;

    if (latest !== this._filePath) {
      // Nouveau fichier ADM (redémarrage du serveur DayZ) : on repart de 0.
      this._filePath = latest;
      this._offset = 0;
    }

    const stat = await fs.promises.stat(this._filePath).catch(() => null);
    if (!stat || stat.size <= this._offset) return;

    const stream = fs.createReadStream(this._filePath, { start: this._offset, end: stat.size - 1, encoding: 'utf8' });
    let buffer = '';
    for await (const chunk of stream) buffer += chunk;
    this._offset = stat.size;

    const lines = buffer.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      await this._handleLine(line).catch((err) => this.emit('log', `Erreur traitement ligne ADM : ${err.message}`));
    }
  }

  async _handleLine(line) {
    const killMatch = line.match(PATTERNS.kill);
    if (killMatch) return this._handleKill(killMatch);

    const connectMatch = line.match(PATTERNS.connect);
    if (connectMatch) {
      const [, name, steamId] = connectMatch;
      await recordConnect(this.tenantId, steamId, name);
      this.emit('log', `➕ ${name} (${steamId}) a rejoint le serveur — compte DayZ prêt.`);
      return;
    }

    const disconnectMatch = line.match(PATTERNS.disconnect);
    if (disconnectMatch) {
      const [, name, steamId] = disconnectMatch;
      await recordDisconnect(this.tenantId, steamId);
      this.emit('log', `➖ ${name} (${steamId}) a quitté le serveur.`);
      return;
    }
  }

  async _handleKill(match) {
    const [, victimName, victimSteamId, vx, , vz, killerName, killerSteamId, kx, , kz] = match;

    // Suicide / mort par environnement (pas de "tueur" distinct) : pas de
    // stats de kill, pas de vérif safe zone.
    if (killerSteamId === victimSteamId) return;

    await recordKill(this.tenantId, killerSteamId, killerName, victimSteamId, victimName);
    this.emit('log', `☠️ ${killerName} a tué ${victimName}.`);

    const dayz = this.store.getDayz();
    const killerPos = { x: parseFloat(kx), z: parseFloat(kz) };
    const victimPos = { x: parseFloat(vx), z: parseFloat(vz) };

    const violatedZone = (dayz.safeZones || []).find((zone) => {
      const r = Number(zone.radius) || 0;
      return (
        distance2D(killerPos.x, killerPos.z, zone.x, zone.z) <= r ||
        distance2D(victimPos.x, victimPos.z, zone.x, zone.z) <= r
      );
    });

    if (!violatedZone) return;

    this.emit('log', `🚨 Kill de ${victimName} par ${killerName} dans la safe zone "${violatedZone.name}" → ban en cours…`);
    await this._banKiller(killerName, killerSteamId, violatedZone);
  }

  async _banKiller(killerName, killerSteamId, zone) {
    const dayz = this.store.getDayz();
    const reason = `Kill en safe zone (${zone.name})`;
    let ok = false;
    let response = '';
    try {
      if (!dayz.rcon?.host || !dayz.rcon?.password) {
        throw new Error('RCon non configuré (host/password manquants dans les paramètres DayZ).');
      }
      // BE RCon bannit par n° de slot joueur (issu de "players"), pas
      // directement par SteamID -> on liste les joueurs connectés et on
      // retrouve celui dont le nom correspond, en tant que best-effort
      // (le tueur vient de jouer, il est donc censé être encore connecté).
      const playersOutput = await rconRunOnce(dayz.rcon, 'players');
      const slot = this._findPlayerSlot(playersOutput, killerName);
      if (slot === null) {
        throw new Error(`Joueur "${killerName}" introuvable dans la liste RCon "players" (déjà déco ?).`);
      }
      response = await rconRunOnce(dayz.rcon, `ban ${slot} 0 ${reason}`);
      ok = true;
    } catch (err) {
      response = err.message;
      this.emit('log', `❌ Échec du ban automatique de ${killerName} : ${err.message}`);
    }

    await pool.query(
      `INSERT INTO dayz_ban_log (tenant_id, steam_id, player_name, zone_name, reason, rcon_ok, rcon_response)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [this.tenantId, killerSteamId, killerName, zone.name, reason, ok ? 1 : 0, response]
    );

    this.emit('banResult', { ok, killerName, killerSteamId, zone: zone.name, response });
  }

  _findPlayerSlot(playersOutput, name) {
    return findPlayerSlot(playersOutput, name);
  }
}

// ── DayzManager : Map<tenantId, DayzWatcher> ─────────────────────────
class DayzManager {
  constructor() {
    this._watchers = new Map();
  }

  get(tenantId, store) {
    if (!this._watchers.has(tenantId)) {
      if (!store) throw new Error(`dayzManager.get(${tenantId}) appelé sans store.`);
      this._watchers.set(tenantId, new DayzWatcher(tenantId, store));
    }
    return this._watchers.get(tenantId);
  }

  stopAll() {
    for (const w of this._watchers.values()) w.stop();
  }
}

module.exports = {
  dayzManager: new DayzManager(),
  DayzWatcher,
  // Économie/stats exposées directement pour les commandes Discord.
  ensurePlayer,
  getPlayerBySteamId,
  getPlayerByDiscordId,
  getPlayerByNameOrSteamId,
  linkDiscord,
  addBalance,
  getLeaderboard,
  findPlayerSlot,
};
