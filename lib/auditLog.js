const { pool: db } = require('./db');

// Longueur max stockée pour le champ `details` (évite de saturer la table
// avec un payload JSON trop volumineux si un jour un gros objet est loggé).
const MAX_DETAILS_LENGTH = 4000;

/**
 * Enregistre une action d'administration dans le registre d'audit.
 * Ne doit JAMAIS faire planter la requête HTTP appelante : toute erreur
 * est simplement loggée en console, l'audit log est un "nice to have"
 * et ne doit pas bloquer une action métier si la table est indisponible.
 *
 * @param {object} params
 * @param {number} params.tenantId
 * @param {string|null} [params.actorDiscordId]
 * @param {string|null} [params.actorTag]
 * @param {string} params.action - identifiant court de l'action (ex: "settings.bot.update")
 * @param {string|null} [params.target] - ce qui a été modifié (ex: id d'un type de ticket)
 * @param {object|string|null} [params.details] - contexte additionnel (sera stringifié si objet)
 */
async function logAction({ tenantId, actorDiscordId = null, actorTag = null, action, target = null, details = null }) {
  try {
    if (!tenantId || !action) return;
    let detailsStr = null;
    if (details !== null && details !== undefined) {
      detailsStr = typeof details === 'string' ? details : JSON.stringify(details);
      if (detailsStr.length > MAX_DETAILS_LENGTH) {
        detailsStr = detailsStr.slice(0, MAX_DETAILS_LENGTH);
      }
    }
    await db.query(
      'INSERT INTO audit_log (tenant_id, actor_discord_id, actor_tag, action, target, details) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, actorDiscordId, actorTag, action, target, detailsStr]
    );
  } catch (err) {
    console.error('Erreur écriture audit_log:', err.message);
  }
}

/**
 * Petit helper à brancher sur une requête Express déjà passée par
 * resolveTenant (req.tenantId + req.session.discordUser dispo).
 */
function logFromRequest(req, action, target = null, details = null) {
  const actorDiscordId = req.session?.discordUser?.id || null;
  const actorTag = req.session?.discordUser?.username || req.session?.discordUser?.tag || null;
  return logAction({ tenantId: req.tenantId, actorDiscordId, actorTag, action, target, details });
}

/**
 * Lit les dernières entrées du registre d'audit pour un tenant, du plus
 * récent au plus ancien.
 *
 * @param {number} tenantId
 * @param {number} [limit=100]
 */
async function getRecent(tenantId, limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const [rows] = await db.query(
    'SELECT id, actor_discord_id, actor_tag, action, target, details, created_at FROM audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
    [tenantId, safeLimit]
  );
  return rows.map((r) => ({
    id: r.id,
    actorDiscordId: r.actor_discord_id,
    actorTag: r.actor_tag,
    action: r.action,
    target: r.target,
    details: r.details ? safeParse(r.details) : null,
    createdAt: r.created_at,
  }));
}

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

module.exports = { logAction, logFromRequest, getRecent };