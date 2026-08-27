'use strict';

// ── Client Nitrado Web API ────────────────────────────────────────────
// Sert à lier le compte Nitrado d'un client (via un token API personnel,
// généré sur https://server.nitrado.net dans "Mon compte > API Access
// Tokens") pour aller chercher automatiquement les infos de connexion
// du serveur DayZ (host/port/mot de passe RCon, dossier des logs ADM)
// SANS que le client ait à les saisir à la main. C'est ce lien qui
// débloque la config PS4/PS5 : sur console il n'y a de toute façon pas
// d'accès FTP/RCon direct, tout passe par le compte Nitrado.
//
// ⚠️ Best-effort : Nitrado ne documente pas publiquement un format figé
// pour l'objet "settings/config" d'un gameserver, et il peut varier
// selon le jeu/la version. Le mapping ci-dessous (RCON_KEY_CANDIDATES,
// LOG_DIR_CANDIDATES) couvre les clés observées le plus couramment pour
// DayZ ; si un compte réel renvoie une structure différente, il suffit
// d'ajuster ces listes avec un extrait réel de la réponse API (dis-le
// moi et je corrige avec un exemple concret).

const API_BASE = 'https://api.nitrado.net';

class NitradoApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'NitradoApiError';
    this.status = status || null;
  }
}

async function request(token, path, options = {}) {
  if (!token) throw new NitradoApiError('Token API Nitrado manquant.');
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* réponse non-JSON (rare, ex: erreur proxy) */
  }

  if (!res.ok || body?.status === 'error') {
    const msg = body?.message || `Erreur API Nitrado (HTTP ${res.status}).`;
    throw new NitradoApiError(msg, res.status);
  }
  return body?.data ?? body;
}

// Vérifie le token et liste les services Nitrado du compte (tous jeux
// confondus) — sert à laisser le client choisir SON serveur DayZ s'il en
// a plusieurs.
async function listServices(token) {
  const data = await request(token, '/services');
  const services = data?.services || [];
  return services.map((s) => ({
    id: s.id,
    status: s.status,
    // Ces deux champs permettent d'afficher un nom lisible même si le
    // service n'est pas (encore) un gameserver DayZ initialisé.
    game: s.details?.game_human || s.details?.game || null,
    address: s.details?.address || null,
    suspendUntil: s.suspend_date || null,
  }));
}

// Détails d'un service précis (confirme qu'il s'agit bien d'un serveur
// DayZ avant de tenter d'en tirer des infos RCon).
async function getGameserver(token, serviceId) {
  const data = await request(token, `/services/${serviceId}/gameservers`);
  return data?.gameserver || null;
}

// Best-effort : essaie de récupérer host/port/mot de passe RCon (BattlEye)
// et le dossier contenant les logs ADM depuis la config Nitrado du jeu.
// Nitrado expose ça via /services/{id}/gameservers/settings (catégories
// dépendant du jeu, ex. "general", "network", "battleye"...).
async function fetchRconAndLogConfig(token, serviceId) {
  let settingsData;
  try {
    settingsData = await request(token, `/services/${serviceId}/gameservers/settings`);
  } catch (err) {
    throw new NitradoApiError(
      `Impossible de lire la config Nitrado du serveur (${err.message}). ` +
        `Le mot de passe RCon devra être renseigné manuellement.`,
      err.status
    );
  }

  const gameserver = await getGameserver(token, serviceId);
  const flat = {};
  // La réponse "settings" est généralement { category: { key: value } } ;
  // on l'aplatit pour chercher les clés candidates sans dépendre d'une
  // structure figée.
  const categories = settingsData?.settings || settingsData || {};
  for (const catKey of Object.keys(categories)) {
    const cat = categories[catKey];
    if (cat && typeof cat === 'object') {
      for (const [k, v] of Object.entries(cat)) flat[k.toLowerCase()] = v;
    }
  }

  const RCON_PASSWORD_KEYS = ['rconpassword', 'rcon_password', 'beserver_rconpassword'];
  const RCON_PORT_KEYS = ['rconport', 'rcon_port', 'query_port'];
  const LOG_DIR_KEYS = ['adm_log_dir', 'log_dir', 'profiles_path'];

  const pick = (keys) => {
    for (const k of keys) if (flat[k] != null && flat[k] !== '') return flat[k];
    return null;
  };

  const host = gameserver?.ip || gameserver?.query?.ip || null;
  const rconPassword = pick(RCON_PASSWORD_KEYS);
  const rconPort = pick(RCON_PORT_KEYS) || gameserver?.query?.port || 2302;
  const admLogDir = pick(LOG_DIR_KEYS);

  return {
    host,
    port: Number(rconPort) || 2302,
    password: rconPassword,
    admLogDir,
    // Ce que Nitrado n'a pas su fournir automatiquement -> à compléter
    // manuellement dans le dashboard.
    missing: [
      !host && 'host',
      !rconPassword && 'password RCon',
      !admLogDir && 'dossier de logs ADM',
    ].filter(Boolean),
  };
}

module.exports = { NitradoApiError, listServices, getGameserver, fetchRconAndLogConfig };
