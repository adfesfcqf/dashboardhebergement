'use strict';

// ── Client RCon BattlEye (BE RCon) ───────────────────────────────────
// Protocole utilisé par les serveurs DayZ (et Arma) pour l'administration
// à distance : UDP, paquets préfixés "BE", CRC32, login par mot de passe.
// Implémentation volontairement minimale (login + envoi de commande +
// réponse simple) : suffisant pour "players", "ban", "say", "kick", etc.
// Référence du protocole : https://www.battleye.com/downloads/BERConProtocol.txt
//
// Best-effort : toute erreur réseau/protocole rejette la Promise avec un
// message clair plutôt que de faire planter le process appelant — c'est
// à l'appelant (dayzManager.js) de décider quoi faire d'un échec RCon.

const dgram = require('dgram');

const KEEPALIVE_INTERVAL_MS = 30_000; // BE exige un paquet < 45s pour ne pas timeout
const COMMAND_TIMEOUT_MS = 5_000;

// ── CRC32 (table-based, pas de dépendance externe) ───────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildPacket(typeByte, payload = Buffer.alloc(0)) {
  // corps = 0xFF + type + payload -> CRC32 calculé sur ça, puis préfixé
  // de "BE" + crc (little-endian 4 octets).
  const body = Buffer.concat([Buffer.from([0xff, typeByte]), payload]);
  const crc = crc32(body);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32LE(crc, 0);
  return Buffer.concat([Buffer.from('BE', 'ascii'), crcBuf, body]);
}

class BattlEyeRcon {
  constructor({ host, port = 2302, password }) {
    if (!host || !password) throw new Error('RCon DayZ non configuré (host/password manquants).');
    this.host = host;
    this.port = Number(port) || 2302;
    this.password = password;
    this.socket = null;
    this.seq = 0;
    this._loginPromise = null;
    this._pending = new Map(); // seq -> { resolve, reject, timer, chunks }
    this._keepAliveTimer = null;
    this._connected = false;
  }

  connect() {
    if (this._loginPromise) return this._loginPromise;

    this._loginPromise = new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        this._cleanup();
        reject(new Error(`Erreur socket RCon : ${err.message}`));
      });

      this.socket.on('message', (msg) => this._handleMessage(msg, resolve, reject));

      this.socket.bind(() => {
        const loginPacket = buildPacket(0x00, Buffer.from(this.password, 'ascii'));
        this.socket.send(loginPacket, this.port, this.host, (err) => {
          if (err) reject(new Error(`Impossible d'envoyer le login RCon : ${err.message}`));
        });
      });

      setTimeout(() => {
        if (!this._connected) reject(new Error('Timeout de connexion RCon (serveur injoignable ou mauvais host/port).'));
      }, COMMAND_TIMEOUT_MS);
    });

    return this._loginPromise;
  }

  _handleMessage(msg, loginResolve, loginReject) {
    if (msg.length < 8 || msg.toString('ascii', 0, 2) !== 'BE') return;
    const type = msg[7];

    if (type === 0x00) {
      // Réponse au login : payload[0] = 1 (succès) ou 0 (échec)
      const ok = msg[8] === 1;
      if (ok) {
        this._connected = true;
        this._startKeepAlive();
        loginResolve(this);
      } else {
        this._cleanup();
        loginReject(new Error('Mot de passe RCon refusé par le serveur.'));
      }
      return;
    }

    if (type === 0x01) {
      // Réponse à une commande : payload[0] = seq, éventuellement
      // suivi d'un en-tête multi-paquet (0x00 idx total idx courant)
      // qu'on ignore ici (best-effort : on assemble ce qui arrive).
      const seq = msg[8];
      const pending = this._pending.get(seq);
      if (!pending) return;

      let textStart = 9;
      if (msg[9] === 0x00) textStart = 12; // en-tête multi-paquet
      const chunk = msg.slice(textStart).toString('utf8');
      pending.chunks.push(chunk);

      // Best-effort : on considère la réponse complète dès le premier
      // paquet reçu (suffisant pour "ban"/"say"/petites commandes ; les
      // très longues réponses type "players" sur un gros serveur peuvent
      // arriver tronquées).
      clearTimeout(pending.timer);
      this._pending.delete(seq);
      pending.resolve(pending.chunks.join(''));
      return;
    }

    if (type === 0x02) {
      // Message serveur non sollicité (chat, log) : on doit accuser
      // réception avec le même seq pour ne pas perturber la connexion.
      const seq = msg[8];
      const ack = buildPacket(0x02, Buffer.from([seq]));
      this.socket.send(ack, this.port, this.host, () => {});
    }
  }

  _startKeepAlive() {
    this._keepAliveTimer = setInterval(() => {
      if (!this._connected) return;
      this.sendCommand('').catch(() => {});
    }, KEEPALIVE_INTERVAL_MS);
    // Ne bloque pas la fin du process si jamais on oublie de close().
    if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
  }

  sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (!this._connected) return reject(new Error('RCon non connecté.'));
      const seq = this.seq;
      this.seq = (this.seq + 1) % 256;

      const packet = buildPacket(0x01, Buffer.concat([Buffer.from([seq]), Buffer.from(command, 'ascii')]));
      const timer = setTimeout(() => {
        this._pending.delete(seq);
        reject(new Error(`Timeout de réponse RCon pour la commande "${command}".`));
      }, COMMAND_TIMEOUT_MS);

      this._pending.set(seq, { resolve, reject, timer, chunks: [] });
      this.socket.send(packet, this.port, this.host, (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending.delete(seq);
          reject(new Error(`Envoi commande RCon échoué : ${err.message}`));
        }
      });
    });
  }

  _cleanup() {
    this._connected = false;
    if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error('Connexion RCon fermée.'));
    }
    this._pending.clear();
    try { this.socket?.close(); } catch { /* déjà fermé */ }
  }

  close() {
    this._cleanup();
  }
}

// Ouvre une connexion RCon, exécute une seule commande, puis referme.
// Pratique pour les usages ponctuels (ban immédiat) sans garder une
// socket ouverte en permanence.
async function runOnce(rconConfig, command) {
  const client = new BattlEyeRcon(rconConfig);
  try {
    await client.connect();
    const response = await client.sendCommand(command);
    return response;
  } finally {
    client.close();
  }
}

module.exports = { BattlEyeRcon, runOnce };
