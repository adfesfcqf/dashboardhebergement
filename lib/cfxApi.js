// ── cfxApi.js ──────────────────────────────────────────────
// Récupère le statut d'un serveur FiveM (joueurs en ligne, nom, etc.).
//
// Deux modes d'entrée sont acceptés :
//  1) Code / URL CFX ("abcd12" ou "cfx.re/join/abcd12") → passe par l'API
//     publique cfx.re. Cette API est protégée par Cloudflare, qui bloque les
//     requêtes "trop bot" en se basant non seulement sur les headers mais
//     aussi sur l'empreinte TLS/HTTP2 de la connexion — un fetch() Node.js
//     classique, même avec de bons headers, a une empreinte différente d'un
//     vrai navigateur et se fait donc filtrer. On utilise ici `got-scraping`
//     (lib Apify) qui imite aussi cette empreinte, avec retries.
//  2) Adresse directe du serveur ("ip:port" ou "domaine:port") → interroge
//     directement le serveur FiveM via ses endpoints HTTP natifs
//     (info.json / dynamic.json). Ne passe pas par cfx.re, jamais bloqué.
//     Solution de secours garantie si le mode 1 échoue quand même.

const CFX_API_BASE = 'https://servers-frontend.fivem.net/api/servers/single';

let gotScrapingPromise = null;
async function getGotScraping() {
  // Import dynamique : got-scraping est en ESM pur.
  if (!gotScrapingPromise) {
    gotScrapingPromise = import('got-scraping').then((mod) => mod.gotScraping);
  }
  return gotScrapingPromise;
}

// Accepte soit le code brut ("abcd12"), soit l'URL complète
// ("https://cfx.re/join/abcd12" ou "cfx.re/join/abcd12").
function extractCfxCode(input) {
  if (!input) return null;
  const trimmed = input.trim();
  const match = trimmed.match(/cfx\.re\/join\/([A-Za-z0-9]+)/i);
  if (match) return match[1];
  return /^[A-Za-z0-9]{3,12}$/.test(trimmed) ? trimmed : null;
}

// Détecte une adresse directe "ip:port", "domaine:port" ou une URL
// "http(s)://hote:port". Retourne { host, port } ou null.
function extractDirectAddress(input) {
  if (!input) return null;
  let trimmed = input.trim();
  trimmed = trimmed.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const match = trimmed.match(
    /^((?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::(\d{2,5}))$/
  );
  if (!match) return null;
  return { host: match[1], port: match[2] || '30120' };
}

// Retire les codes couleur FiveM (^0 à ^9) d'un hostname.
function stripColorCodes(str) {
  return (str || '').replace(/\^[0-9]/g, '').trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Mode 1 : code CFX via l'API cfx.re, avec empreinte "navigateur" ────────
async function fetchByCfxCode(code) {
  const gotScraping = await getGotScraping();
  const url = `${CFX_API_BASE}/${code}`;

  let lastErr;
  // 3 tentatives : la protection Cloudflare de cfx.re est parfois inconstante
  // (score anti-bot variable selon le trafic récent depuis la même IP),
  // un deuxième ou troisième essai passe souvent là où le premier échoue.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await gotScraping({
        url,
        responseType: 'text',
        http2: true,
        timeout: { request: 8000 },
        throwHttpErrors: false,
        headerGeneratorOptions: {
          browsers: ['chrome'],
          devices: ['desktop'],
          locales: ['fr-FR'],
        },
      });

      const rawBody = res.body || '';
      let json = null;
      if (rawBody.trim().startsWith('{')) {
        try {
          json = JSON.parse(rawBody);
        } catch {
          json = null;
        }
      }

      if (json) {
        const data = json.Data;
        if (!data) {
          const errCode = json.error || json.status;
          throw new Error(
            errCode === 'input_not_found'
              ? 'Aucun serveur trouvé avec ce code CFX. Vérifie que le code est bien à jour (il peut changer à chaque redémarrage du serveur).'
              : 'Serveur introuvable ou actuellement hors ligne.'
          );
        }
        return {
          online: true,
          code,
          hostname: stripColorCodes(data.hostname || data.vars?.sv_projectName) || 'Serveur FiveM',
          players: Array.isArray(data.players) ? data.players.length : 0,
          maxPlayers: Number(data.svMaxclients || data.vars?.sv_maxClients || 0) || 0,
          resourcesCount: Array.isArray(data.resources) ? data.resources.length : null,
        };
      }

      // Pas de JSON exploitable (page de blocage Cloudflare) → on retente.
      lastErr = new Error(`blocage cfx.re (HTTP ${res.statusCode})`);
    } catch (err) {
      lastErr = err;
      if (/Aucun serveur trouvé|Serveur introuvable/.test(err.message)) throw err;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt));
  }

  const err = new Error(
    `Cfx.re a bloqué la requête après plusieurs tentatives (${lastErr?.message || 'inconnue'}). ` +
      "Ce n'est pas lié à ton code CFX — c'est une protection anti-bot côté cfx.re. " +
      "Solution fiable : renseigne directement l'adresse IP:PORT de ton serveur FiveM à la place du code, ça ne passe pas par cfx.re et n'est jamais bloqué."
  );
  err.blocked = true;
  throw err;
}

// ── Mode 2 : adresse directe IP:PORT, via les endpoints natifs du serveur ──
async function fetchDirectJson(baseUrl, path) {
  const res = await fetchWithTimeout(`${baseUrl}/${path}`, {
    headers: { Accept: 'application/json' },
  }, 5000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return JSON.parse(text);
}

async function fetchByDirectAddress({ host, port }) {
  const address = `${host}:${port}`;
  const attempts = [`http://${address}`, `https://${address}`];

  let lastErr;
  for (const baseUrl of attempts) {
    try {
      const [dynamic, info] = await Promise.all([
        fetchDirectJson(baseUrl, 'dynamic.json'),
        fetchDirectJson(baseUrl, 'info.json').catch(() => null),
      ]);

      return {
        online: true,
        code: address,
        hostname: stripColorCodes(dynamic.hostname) || 'Serveur FiveM',
        players: Number(dynamic.clients || 0) || 0,
        maxPlayers: Number(dynamic.sv_maxclients || 0) || 0,
        resourcesCount: Array.isArray(info?.resources) ? info.resources.length : null,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    `Impossible de joindre le serveur à l'adresse ${address} (${lastErr?.message || 'connexion échouée'}). ` +
      "Vérifie l'IP et le port, et que le pare-feu du serveur autorise les requêtes HTTP entrantes sur ce port."
  );
}

// ── Point d'entrée unique ───────────────────────────────────
async function fetchServerStatus(rawInput) {
  const direct = extractDirectAddress(rawInput);
  if (direct) {
    return fetchByDirectAddress(direct);
  }

  const code = extractCfxCode(rawInput);
  if (!code) {
    throw new Error(
      "Entrée invalide. Colle le code après cfx.re/join/, l'URL complète, ou l'IP:PORT direct du serveur."
    );
  }
  return fetchByCfxCode(code);
}

module.exports = { fetchServerStatus, extractCfxCode, extractDirectAddress };
