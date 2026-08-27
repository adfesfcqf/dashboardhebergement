'use strict';

// scripts/open-dashboard-access.js
//
// Ouvre l'accès au dashboard depuis l'extérieur de ton réseau local :
//   1. Redirige le port du dashboard sur ta box internet via UPnP (le même
//      mécanisme déjà utilisé pour le port du serveur Minecraft, voir
//      lib/upnp.js) — nécessite que l'UPnP soit activé sur la box.
//   2. Affiche ton IP publique + l'adresse complète à donner à quelqu'un
//      d'autre pour qu'il accède au dashboard.
//
// Ce script NE MODIFIE AUCUN CODE DE SÉCURITÉ/AUTHENTIFICATION du
// dashboard : il ouvre juste le chemin réseau. Le dashboard écoute déjà
// par défaut sur 0.0.0.0 (toutes les interfaces, cf index.js) — ce n'est
// donc pas le code Node qui bloquait l'accès depuis l'extérieur, mais très
// probablement : (a) le pare-feu Windows, et/ou (b) l'absence de
// redirection de port sur la box. Ce script règle le point (b) ; pour le
// point (a), lance en plus scripts/open-firewall-windows.ps1.
//
// Usage :
//   node scripts/open-dashboard-access.js [port]
// (par défaut : le port du dashboard, PORT ou DASHBOARD_PORT, sinon 3000)

const upnp = require('../lib/upnp');
const https = require('https');

const PORT = Number(process.argv[2]) || Number(process.env.PORT) || Number(process.env.DASHBOARD_PORT) || 3000;

function getPublicIp() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org', { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data.trim() || null));
    }).on('error', () => resolve(null))
      .on('timeout', function () { this.destroy(); resolve(null); });
  });
}

(async () => {
  console.log(`🔌 Ouverture du port ${PORT} (TCP) sur la box via UPnP...`);
  const result = await upnp.openPort(PORT, {
    protocol: 'TCP',
    description: 'Dashboard',
  });

  if (!result.success) {
    console.error(`❌ Échec UPnP : ${result.error}`);
    console.error('   → Vérifie que l\'UPnP est activé dans les paramètres de ta box internet,');
    console.error('     ou redirige le port manuellement dans l\'interface de la box.');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ Port ${PORT}/TCP redirigé avec succès vers cette machine.`);

  const publicIp = await getPublicIp();
  if (publicIp) {
    console.log(`\n🌍 Adresse à donner à quelqu'un d'autre : http://${publicIp}:${PORT}`);
  } else {
    console.log('\n⚠️  Impossible de récupérer ton IP publique automatiquement (pas de connexion sortante ?).');
    console.log('    Cherche "quelle est mon ip" sur le web depuis ce PC pour la trouver.');
  }

  console.log('\nℹ️  Si ça ne marche toujours pas depuis l\'extérieur, le pare-feu Windows');
  console.log('   bloque probablement encore le port : lance en plus (en administrateur)');
  console.log('   scripts/open-firewall-windows.ps1');
})();