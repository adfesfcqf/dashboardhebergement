require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { ensureSchema, pool } = require('./lib/db');
const { globalStore, tenantManager } = require('./lib/store');
const botManager = require('./lib/botManager');
const { startKeepAlive } = require('./lib/keepAlive');

const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
const HOST = process.env.DASHBOARD_HOST || '0.0.0.0';

process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException (process maintenu en vie):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 unhandledRejection (process maintenu en vie):', reason);
});

// Démarre le bot Discord de CHAQUE tenant "service=discord" qui a un
// token configuré. Les tenants "service=minecraft" n'ont pas de bot à
// démarrer ici — leur serveur de jeu se lance explicitement depuis le
// dashboard (voir /api/minecraft/start), jamais automatiquement au boot.
async function startAllTenantBots() {
  const [rows] = await pool.query("SELECT id FROM tenants WHERE service = 'discord' OR service IS NULL");
  let started = 0;
  for (const row of rows) {
    try {
      const store = await tenantManager.getStore(row.id);
      if (store.getBot().token) {
        const controller = botManager.get(row.id, store);
        await controller.start();
        started += 1;
      }
    } catch (err) {
      console.error(`❌ Échec démarrage bot du tenant ${row.id}:`, err.message);
    }
  }
  console.log(`🤖 ${started} bot(s) client démarré(s) sur ${rows.length} tenant(s) Discord au total.`);
}

async function main() {
  console.log('🔌 Connexion à MySQL et vérification du schéma…');
  await ensureSchema();

  console.log('⚙️  Chargement des settings globaux…');
  await globalStore.init();

  // Migration : rattache les tenants créés avant le système "1 appli
  // Discord par client" à l'ancienne appli globale (cf. lib/store.js).
  if (globalStore.hasAuthApp()) {
    await tenantManager.migrateLegacyTenantsWithoutApp(globalStore.getAuthConfig());
  }

  const createDashboardServer = require('./dashboard/server');

  const app = createDashboardServer();
  app.use(cors());
  app.use(express.json());

  const server = app.listen(PORT, HOST, () => {
    console.log(`🖥️  Dashboard disponible sur http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log('👉 Chaque client crée son propre espace (bot Discord ou serveur Minecraft) via /signup.');
  });

  startKeepAlive();

  await startAllTenantBots();

  // ── Watchdog : relance le bot Discord de chaque tenant tombé en erreur.
  // Ne concerne QUE les bots Discord — un serveur Minecraft qui plante
  // reste arrêté tant que l'admin ne relance pas explicitement depuis le
  // dashboard (on ne veut pas relancer un serveur de jeu tout seul en
  // pleine nuit sans supervision). ──────────────────────────────────
  let watchdogBackoffMs = 15_000;
  const scheduleWatchdog = () => {
    setTimeout(async () => {
      let anyRetried = false;
      for (const controller of botManager.allControllers()) {
        const st = controller.getStatus();
        const hasToken = !!controller.store.getBot().token;
        if (st.rateLimitedUntil) continue;
        if (hasToken && (st.status === 'offline' || st.status === 'error')) {
          console.log(`🔄 Watchdog [tenant ${controller.tenantId}] : bot ${st.status}, tentative de reconnexion…`);
          anyRetried = true;
          try {
            await controller.start();
          } catch (err) {
            console.error(`Watchdog [tenant ${controller.tenantId}]: échec de reconnexion:`, err.message);
          }
        }
      }
      watchdogBackoffMs = anyRetried ? Math.min(watchdogBackoffMs * 2, 5 * 60_000) : 15_000;
      scheduleWatchdog();
    }, watchdogBackoffMs);
  };
  scheduleWatchdog();

  const shutdown = async (signal) => {
    console.log(`\n👋 Signal ${signal} reçu, arrêt en cours…`);
    server.close();
    await botManager.stopAll();
    const minecraftManager = require('./lib/minecraftManager');
    await minecraftManager.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('❌ Échec fatal au démarrage:', err);
  process.exit(1);
});
