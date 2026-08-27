// ── keepAlive.js ───────────────────────────────────────────
// Sur le plan gratuit de Render, un web service s'endort après ~15 min
// sans requête entrante, puis reprend plusieurs dizaines de secondes à
// redémarrer à la prochaine visite. Ce module envoie une requête à sa
// propre route /healthz toutes les X minutes pour que Render considère
// le service comme "actif" et ne l'éteigne jamais.
//
// Aucune configuration nécessaire : Render fournit automatiquement la
// variable d'environnement RENDER_EXTERNAL_URL avec l'URL publique du
// service. En local (RENDER_EXTERNAL_URL absent), le ping est simplement
// désactivé — inutile de garder un process local éveillé.

const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function startKeepAlive() {
  const baseUrl = process.env.RENDER_EXTERNAL_URL;

  if (!baseUrl) {
    console.log('ℹ️  Keep-alive désactivé (pas sur Render / RENDER_EXTERNAL_URL absent).');
    return;
  }

  const url = `${baseUrl.replace(/\/$/, '')}/healthz`;

  const ping = async () => {
    try {
      const res = await fetch(url, { method: 'GET' });
      console.log(`💓 Keep-alive ping → ${res.status}`);
    } catch (err) {
      console.error('⚠️  Keep-alive ping échoué :', err.message);
    }
  };

  console.log(`💓 Keep-alive activé : ping de ${url} toutes les ${PING_INTERVAL_MS / 60000} min.`);
  setInterval(ping, PING_INTERVAL_MS);
  // Premier ping après 1 min (le temps que le serveur soit bien up).
  setTimeout(ping, 60 * 1000);
}

module.exports = { startKeepAlive };
