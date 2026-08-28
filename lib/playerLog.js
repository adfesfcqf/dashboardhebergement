'use strict';

// lib/playerLog.js
//
// Journal des actions des joueurs sur un serveur Minecraft (pas à
// confondre avec lib/auditLog.js, qui trace les actions des ADMINS du
// dashboard). Alimenté en live par lib/minecraftManager.js en parsant les
// logs du process (voir `_logPlayerActivity`), persisté en base pour
// survivre à un redémarrage et permettre une recherche/filtre côté API
// plutôt que de tout renvoyer au front à chaque fois.

const { pool: db } = require('./db');

const EVENT_TYPES = ['join', 'leave', 'chat', 'death', 'command'];

async function logEvent(tenantId, { playerName, eventType, detail = null }) {
  if (!tenantId || !playerName || !EVENT_TYPES.includes(eventType)) return;
  try {
    await db.query(
      'INSERT INTO minecraft_player_log (tenant_id, player_name, event_type, detail) VALUES (?, ?, ?, ?)',
      [tenantId, String(playerName).slice(0, 191), eventType, detail ? String(detail).slice(0, 2000) : null]
    );
  } catch (err) {
    console.error('Erreur lib/playerLog logEvent:', err.message);
  }
}

/**
 * Recherche paginée dans le journal, filtrable par type d'événement et par
 * texte libre (pseudo du joueur OU contenu du détail — un message de chat,
 * une commande, une cause de mort…).
 */
async function search(tenantId, { query = '', eventType = '', limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const conditions = ['tenant_id = ?'];
  const params = [tenantId];

  if (eventType && EVENT_TYPES.includes(eventType)) {
    conditions.push('event_type = ?');
    params.push(eventType);
  }
  const trimmedQuery = String(query || '').trim();
  if (trimmedQuery) {
    conditions.push('(player_name LIKE ? OR detail LIKE ?)');
    params.push(`%${trimmedQuery}%`, `%${trimmedQuery}%`);
  }

  const where = conditions.join(' AND ');
  const [rows] = await db.query(
    `SELECT id, player_name, event_type, detail, created_at
     FROM minecraft_player_log WHERE ${where}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  );
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM minecraft_player_log WHERE ${where}`,
    params
  );

  return {
    entries: rows.map((r) => ({
      id: r.id,
      playerName: r.player_name,
      eventType: r.event_type,
      detail: r.detail,
      createdAt: r.created_at,
    })),
    total: countRows[0]?.total || 0,
    limit: safeLimit,
    offset: safeOffset,
  };
}

module.exports = { logEvent, search, EVENT_TYPES };