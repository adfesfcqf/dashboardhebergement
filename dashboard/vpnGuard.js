// vpnGuard.js
// Middleware Express qui bloque les connexions VPN/proxy/Tor sur ton dashboard
// via l'API IPQualityScore (https://www.ipqualityscore.com/)
//
// Installation :
//   npm install node-fetch@2   (si tu es en CommonJS et Node < 18)
//
// Utilisation :
//   const vpnGuard = require('./vpnGuard');
//   app.use('/dashboard', vpnGuard({ apiKey: process.env.IPQS_API_KEY }));

const CACHE = new Map(); // ip -> { blocked: bool, expiresAt: timestamp }
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h, pour économiser tes requêtes API

// IPs locales / privées jamais bloquées (dev, réseau interne)
const DEFAULT_WHITELIST = [
  '127.0.0.1',
  '::1',
];

function isPrivateIp(ip) {
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip === '::1' ||
    ip === '127.0.0.1'
  );
}

function getClientIp(req) {
  // Si derrière un reverse proxy (nginx, Cloudflare...), pense à faire
  // app.set('trust proxy', true) côté Express, sinon req.ip sera l'IP du proxy.
  const forwarded = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip;
}

async function checkIpQualityScore(ip, apiKey) {
  const url = `https://ipqualityscore.com/api/json/ip/${apiKey}/${ip}?strictness=1&allow_public_access_points=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`IPQS HTTP ${res.status}`);
  const data = await res.json();

  if (!data.success) {
    throw new Error(`IPQS error: ${data.message || 'unknown'}`);
  }

  // proxy = VPN / proxy / datacenter détecté, tor = noeud Tor
  const blocked = Boolean(data.proxy || data.tor || data.vpn);
  return { blocked, raw: data };
}

/**
 * @param {Object} opts
 * @param {string} opts.apiKey - Ta clé API IPQualityScore
 * @param {string[]} [opts.whitelist] - IPs supplémentaires jamais bloquées
 * @param {boolean} [opts.failOpen=true] - Si l'API est down, laisse passer (true) ou bloque (false)
 * @param {(req,res)=>void} [opts.onBlocked] - Handler custom quand une IP est bloquée
 */
function vpnGuard(opts = {}) {
  const { apiKey, whitelist = [], failOpen = true, onBlocked } = opts;

  if (!apiKey) {
    throw new Error('vpnGuard: apiKey IPQualityScore manquante');
  }

  const fullWhitelist = new Set([...DEFAULT_WHITELIST, ...whitelist]);

  return async function (req, res, next) {
    const ip = getClientIp(req);

    if (!ip || fullWhitelist.has(ip) || isPrivateIp(ip)) {
      return next();
    }

    const now = Date.now();
    const cached = CACHE.get(ip);
    if (cached && cached.expiresAt > now) {
      if (cached.blocked) {
        return onBlocked
          ? onBlocked(req, res)
          : res.status(403).json({ error: 'Accès refusé : VPN/Proxy détecté.' });
      }
      return next();
    }

    try {
      const { blocked } = await checkIpQualityScore(ip, apiKey);
      CACHE.set(ip, { blocked, expiresAt: now + CACHE_TTL_MS });

      if (blocked) {
        return onBlocked
          ? onBlocked(req, res)
          : res.status(403).json({ error: 'Accès refusé : VPN/Proxy détecté.' });
      }
      return next();
    } catch (err) {
      console.error('[vpnGuard] Erreur API IPQualityScore:', err.message);
      // Si l'API tombe en panne, on choisit de laisser passer ou bloquer selon failOpen
      return failOpen ? next() : res.status(503).json({ error: 'Vérification VPN indisponible.' });
    }
  };
}

module.exports = vpnGuard;
