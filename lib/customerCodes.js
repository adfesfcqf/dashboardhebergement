const { pool, ensureSchema } = require('./db');

// Normalise ce que tape l'utilisateur (espaces, minuscules, tirets manquants...)
// pour rester tolérant sur le format saisi.
function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9-]/g, '');
}

// Vérifie si un code existe et est encore utilisable, sans le consommer.
async function checkCode(rawCode) {
  await ensureSchema();
  const code = normalizeCode(rawCode);
  if (!code) return { valid: false, reason: 'empty' };

  const [rows] = await pool.query('SELECT * FROM customer_codes WHERE code = ?', [code]);
  if (!rows.length) return { valid: false, reason: 'not_found' };
  if (rows[0].used) return { valid: false, reason: 'already_used', row: rows[0] };
  return { valid: true, row: rows[0] };
}

// Consomme un code pour un utilisateur Discord donné (atomique : le
// UPDATE ne s'applique que si le code n'est pas déjà marqué "used", ce
// qui évite qu'un même code serve deux fois en cas de double-clic/race).
async function redeemCode(rawCode, discordId, username) {
  await ensureSchema();
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'empty' };

  const [existing] = await pool.query('SELECT * FROM customer_codes WHERE code = ?', [code]);
  if (!existing.length) return { ok: false, reason: 'not_found' };
  if (existing[0].used) return { ok: false, reason: 'already_used' };

  const [result] = await pool.query(
    `UPDATE customer_codes
     SET used = 1, used_by_discord_id = ?, used_by_username = ?, used_at = NOW()
     WHERE code = ? AND used = 0`,
    [discordId, username, code]
  );

  if (result.affectedRows === 0) return { ok: false, reason: 'already_used' };
  return { ok: true, planType: existing[0].plan_type };
}

async function listCodes() {
  await ensureSchema();
  const [rows] = await pool.query('SELECT * FROM customer_codes ORDER BY created_at ASC');
  return rows;
}

module.exports = { normalizeCode, checkCode, redeemCode, listCodes };
