const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
} = require('discord.js');
const { EventEmitter } = require('events');

const TicketManager = require('./ticketManager');
const { getTicketTypes, createPanelEmbed, isValidEmoji } = require('./config');
const dayzCommands = require('./dayzCommands');
const { dayzManager } = require('./dayzManager');

// Évite un blocage indéfini sur "connecting" si client.login() ne résout
// ni ne rejette jamais (typique d'un pare-feu hébergeur qui laisse la
// connexion WebSocket ouverte sans jamais répondre).
const CONNECT_TIMEOUT_MS = 15000;

// Anti-spam : distance minimale entre deux restart() (bouton "Reconnecter",
// changement de token, watchdog…). Sans ça, plusieurs tentatives rapprochées
// envoient chacune une nouvelle requête à Discord et peuvent transformer un
// simple ralentissement en un vrai rate limit / ban IP temporaire.
const MIN_RESTART_INTERVAL_MS = 10_000;

// Si Discord renvoie un 429 sans Retry-After exploitable, on attend au
// moins ça avant de retenter (le temps que le compteur de rate limit se
// vide côté Discord).
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

// Essaie d'extraire un délai d'attente (en ms) à partir d'une erreur de
// connexion Discord (login() / requête REST sous-jacente). Couvre les
// différentes formes que peut prendre l'erreur selon la version de
// discord.js / undici : status HTTP 429, retry_after du corps JSON,
// header Retry-After, etc. Retourne `null` si ce n'est pas un rate limit.
function extractRetryAfterMs(err) {
  const status = err?.status ?? err?.httpStatus ?? err?.code ?? err?.rawError?.code;
  const looksLikeRateLimit =
    status === 429 ||
    err?.name === 'RateLimitError' ||
    /\b429\b|rate ?limit/i.test(err?.message || '');
  if (!looksLikeRateLimit) return null;

  const candidates = [
    err?.retryAfter,
    err?.retry_after,
    err?.rawError?.retry_after,
    err?.data?.retry_after,
    err?.timeToReset,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && c > 0) {
      // Discord donne retry_after en SECONDES (float) ; timeToReset (undici
      // rate limit manager de discord.js) est déjà en MILLISECONDES.
      return c > 1000 ? Math.round(c) : Math.round(c * 1000);
    }
  }
  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

// ── BotController : UN bot Discord pour UN tenant ────────────────────
// Chaque client fournit son propre token (cf. la décision produit :
// "Chaque client doit créer et fournir son propre bot/token Discord").
// Avant ce patch, il n'existait qu'UNE seule instance globale (bot.js),
// donc un seul bot/token pour TOUT le monde — incompatible avec cette
// décision, et une des causes de la fuite de données entre clients.
class BotController extends EventEmitter {
  constructor(tenantId, store) {
    super();
    this.tenantId = tenantId;
    this.store = store;
    this.client = null;
    this.ticketManager = null;
    this.status = 'offline'; // offline | connecting | online | error
    this.lastError = null;
    this._loggedInToken = null;
    this._connectTimer = null;
    this._loginSettled = false;
    this._restarting = null;
    this._lastRestartAt = 0;
    // Timestamp (ms epoch) jusqu'auquel Discord nous a explicitement dit
    // d'attendre (HTTP 429). Tant que Date.now() < ceci, on n'émet AUCUNE
    // nouvelle requête vers Discord (ni login manuel, ni watchdog).
    this._rateLimitedUntil = 0;

    store.on('botSettingsChanged', (bot) => this._onBotSettingsChanged(bot));
    store.on('ticketTypesChanged', () => this._refreshPanel());
    store.on('dayzSettingsChanged', () => this._onDayzSettingsChanged());
  }

  getStatus() {
    const rateLimitedUntil = this._rateLimitedUntil > Date.now() ? this._rateLimitedUntil : null;
    return {
      status: this.status,
      lastError: this.lastError,
      tag: this.client?.user?.tag || null,
      guildCount: this.client?.guilds?.cache?.size ?? 0,
      ping: this.client?.ws?.ping ?? null,
      rateLimitedUntil,
      retryAfterSeconds: rateLimitedUntil ? Math.ceil((rateLimitedUntil - Date.now()) / 1000) : null,
    };
  }

  async _onBotSettingsChanged(bot) {
    const currentToken = this._loggedInToken;
    if (bot.token && bot.token !== currentToken) {
      await this.restart();
    } else if (this.status === 'online') {
      await this._refreshPanel();
    }
  }

  async start() {
    const bot = this.store.getBot();
    if (!bot.token) {
      this.status = 'offline';
      this.lastError = 'Aucun token configuré. Renseigne-le depuis le dashboard.';
      this.emit('statusChanged', this.getStatus());
      return this.getStatus();
    }

    // On ne tente RIEN tant que Discord nous a explicitement demandé
    // d'attendre (429) — chaque tentative pendant ce délai ne fait que
    // prolonger/aggraver le blocage.
    if (this._rateLimitedUntil > Date.now()) {
      const waitSec = Math.ceil((this._rateLimitedUntil - Date.now()) / 1000);
      this.status = 'error';
      this.lastError = `Discord a temporairement bloqué les connexions pour ce bot (HTTP 429 - rate limit). Nouvelle tentative automatique dans ${waitSec}s. N'appuie pas sur "Reconnecter" avant, ça ne ferait qu'allonger l'attente.`;
      this.emit('statusChanged', this.getStatus());
      return this.getStatus();
    }

    if (this.client) await this.stop();

    this.status = 'connecting';
    this.lastError = null;
    this._loginSettled = false;
    this.emit('statusChanged', this.getStatus());

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    });

    this.ticketManager = new TicketManager(this.client, this.tenantId, this.store);
    this._registerHandlers();

    // Filet de sécurité : si login() ne résout ni ne rejette jamais (pare-feu
    // hébergeur bloquant le WebSocket en silence), on sort de "connecting"
    // au lieu de rester bloqué indéfiniment.
    this._connectTimer = setTimeout(() => {
      if (this._loginSettled) return;
      this._loginSettled = true;
      this.status = 'error';
      this.lastError =
        `Le bot n'a pas réussi à se connecter à Discord en ${CONNECT_TIMEOUT_MS / 1000}s ` +
        `(aucune réponse, ni succès ni erreur). Causes les plus fréquentes : token invalide ` +
        `ou régénéré depuis, intents privilégiés non activés sur le Developer Portal ` +
        `("Server Members Intent" et "Message Content Intent"), ou connexions sortantes ` +
        `WebSocket bloquées par l'hébergeur/pare-feu (vérifie que le port 443 sortant vers ` +
        `gateway.discord.gg n'est pas filtré).`;
      this._loggedInToken = null;
      console.error(`❌ [tenant ${this.tenantId}] Timeout de connexion bot (${CONNECT_TIMEOUT_MS}ms écoulées).`);
      this.emit('statusChanged', this.getStatus());
      this.client?.destroy().catch(() => {});
    }, CONNECT_TIMEOUT_MS);

    try {
      await this.client.login(bot.token);
      this._loggedInToken = bot.token;
    } catch (err) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
      if (!this._loginSettled) {
        this._loginSettled = true;
        const retryAfterMs = extractRetryAfterMs(err);
        this._loggedInToken = null;
        if (retryAfterMs) {
          this._rateLimitedUntil = Date.now() + retryAfterMs;
          const waitSec = Math.ceil(retryAfterMs / 1000);
          this.status = 'error';
          this.lastError = `Discord bloque temporairement les connexions pour ce bot (HTTP 429 - rate limit), probablement dû à l'IP partagée de l'hébergeur ou à des tentatives de connexion trop rapprochées. Nouvelle tentative automatique dans ${waitSec}s — n'appuie pas sur "Reconnecter" en attendant, ça ne ferait qu'aggraver le blocage.`;
          console.error(`⏳ [tenant ${this.tenantId}] Rate limité par Discord (429). Attente ${waitSec}s avant nouvelle tentative.`);
        } else {
          this.status = 'error';
          this.lastError = `Connexion échouée : ${err.message}`;
          console.error(`❌ [tenant ${this.tenantId}] Erreur de connexion bot:`, err.message);
        }
        this.emit('statusChanged', this.getStatus());
      }
      return this.getStatus();
    }

    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    return this.getStatus();
  }

  async stop() {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    this._loginSettled = true;
    this._stopDayzWatcher();
    if (!this.client) return;
    try {
      await this.client.destroy();
    } catch {}
    this.client = null;
    this.ticketManager = null;
    this._loggedInToken = null;
    this.status = 'offline';
    this.emit('statusChanged', this.getStatus());
  }

  // ── Module DayZ (économie / safe zones / classements) ──────────────
  // Enregistre les slash commands "/dayz-*" sur le serveur Discord
  // configuré (dayz.commandsGuildId, ou à défaut le serveur du panel de
  // tickets) et démarre le watcher de logs ADM si le module est activé.
  async _registerDayzCommands() {
    try {
      const dayzConfig = this.store.getDayz();
      if (!dayzConfig.enabled) return;

      const guildId = dayzConfig.commandsGuildId || this.store.getBot().panelGuildId;
      if (!guildId) {
        console.warn(`⚠️ [tenant ${this.tenantId}] Module DayZ activé mais aucun serveur Discord configuré pour les commandes.`);
        return;
      }

      const rest = new REST({ version: '10' }).setToken(this._loggedInToken);
      await rest.put(Routes.applicationGuildCommands(this.client.user.id, guildId), {
        body: dayzCommands.COMMAND_BUILDERS,
      });
      console.log(`✅ [tenant ${this.tenantId}] Slash commands DayZ enregistrées sur le serveur ${guildId}.`);
    } catch (err) {
      console.error(`❌ [tenant ${this.tenantId}] Échec enregistrement commandes DayZ:`, err.message);
    }
  }

  _startDayzWatcher() {
    const dayzConfig = this.store.getDayz();
    if (!dayzConfig.enabled) return;
    const watcher = dayzManager.get(this.tenantId, this.store);
    watcher.removeAllListeners('log');
    watcher.on('log', (msg) => console.log(`[DayZ tenant ${this.tenantId}] ${msg}`));
    watcher.start();
  }

  _stopDayzWatcher() {
    if (dayzManager && this.tenantId != null) {
      try { dayzManager.get(this.tenantId, this.store).stop(); } catch {}
    }
  }

  // Réagit à un changement de config DayZ depuis le dashboard (pas besoin
  // de redémarrer tout le bot Discord pour ça) : re-enregistre les
  // commandes et démarre/arrête le watcher selon le nouvel état "enabled".
  async _onDayzSettingsChanged() {
    if (this.status !== 'online') return;
    const dayzConfig = this.store.getDayz();
    if (dayzConfig.enabled) {
      await this._registerDayzCommands();
      this._startDayzWatcher();
    } else {
      this._stopDayzWatcher();
    }
  }

  async restart() {
    // Coalesce les restart() concurrents : un clic répété sur "Reconnecter",
    // ou un restart déclenché par un changement de settings pendant qu'un
    // autre tourne déjà, ne doit jamais lancer deux login() en parallèle.
    if (this._restarting) return this._restarting;

    // Anti-spam : impose un délai minimal entre deux tentatives, même hors
    // rate limit Discord explicite — c'est ce qui empêchait auparavant les
    // clics répétés (ou un watchdog mal réglé) d'aggraver un ralentissement
    // en véritable 429.
    const elapsed = Date.now() - this._lastRestartAt;
    if (this._lastRestartAt && elapsed < MIN_RESTART_INTERVAL_MS) {
      const waitSec = Math.ceil((MIN_RESTART_INTERVAL_MS - elapsed) / 1000);
      console.warn(`⏳ [tenant ${this.tenantId}] restart() ignoré (anti-spam), réessaie dans ${waitSec}s.`);
      if (this.status !== 'connecting') {
        this.lastError = `Merci de patienter ${waitSec}s avant une nouvelle tentative de reconnexion (anti-spam).`;
        this.emit('statusChanged', this.getStatus());
      }
      return this.getStatus();
    }

    this._restarting = (async () => {
      this._lastRestartAt = Date.now();
      await this.stop();
      return this.start();
    })();
    try {
      return await this._restarting;
    } finally {
      this._restarting = null;
    }
  }

  _registerHandlers() {
    const client = this.client;

    client.once('clientReady', async () => {
      this._loginSettled = true;
      if (this._connectTimer) {
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
      }
      // Connexion réussie : le rate limit éventuel est levé.
      this._rateLimitedUntil = 0;
      console.log(`✅ [tenant ${this.tenantId}] Bot connecté en tant que ${client.user.tag}`);
      this.status = 'online';
      this.lastError = null;
      this.emit('statusChanged', this.getStatus());
      await this.ticketManager.init();
      await this._refreshPanel();
      await this._registerDayzCommands();
      this._startDayzWatcher();
    });

    client.on('error', (err) => {
      console.error(`Erreur client Discord (tenant ${this.tenantId}):`, err.message);
      this.lastError = err.message;
      this.emit('statusChanged', this.getStatus());
    });

    client.on('shardDisconnect', (event) => {
      console.warn(`⚠️ [tenant ${this.tenantId}] Shard déconnecté (code ${event?.code}), tentative de reconnexion…`);
    });
    client.on('shardReconnecting', () => {
      console.log(`🔄 [tenant ${this.tenantId}] Reconnexion du shard en cours…`);
    });
    client.on('shardResume', () => {
      console.log(`✅ [tenant ${this.tenantId}] Shard reconnecté.`);
      this.status = 'online';
      this.emit('statusChanged', this.getStatus());
    });
    client.on('invalidated', () => {
      console.error(`❌ [tenant ${this.tenantId}] Session Discord invalidée, relance par le watchdog.`);
      this.status = 'error';
      this.lastError = 'Session invalidée par Discord.';
      this.client = null;
      this.emit('statusChanged', this.getStatus());
    });

    client.on('interactionCreate', async (interaction) => {
      if (interaction.isChatInputCommand()) {
        try {
          const handled = await dayzCommands.handleInteraction(interaction, this.store);
          if (!handled) {
            await interaction.reply({ content: '❌ Commande inconnue.', ephemeral: true }).catch(() => {});
          }
        } catch (err) {
          console.error(`Erreur commande "${interaction.commandName}" (tenant ${this.tenantId}):`, err.message);
          const payload = { content: `❌ Erreur : ${err.message}`, ephemeral: true };
          if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
          else await interaction.reply(payload).catch(() => {});
        }
        return;
      }

      if (!interaction.isButton()) return;
      const { customId, user } = interaction;

      if (customId.startsWith('open_ticket_')) {
        const typeId = customId.replace('open_ticket_', '');
        const ticketType = getTicketTypes(this.store).find((t) => t.id === typeId);
        if (!ticketType) return;

        await interaction.deferReply({ ephemeral: true });

        if (this.ticketManager.hasOpenTicket(user.id)) {
          return interaction.editReply({
            content: "❌ Tu as déjà un ticket ouvert ! Termine-le avant d'en ouvrir un nouveau.",
          });
        }

        try {
          await this.ticketManager.createTicket(user, ticketType, interaction.guild);
          await interaction.editReply({
            content: `✅ Ton ticket **${ticketType.label}** a été ouvert ! Vérifie tes messages privés 📬`,
          });
        } catch (err) {
          console.error('Erreur création ticket:', err);
          await interaction.editReply({
            content: `❌ Erreur lors de la création du ticket : ${err.message}`,
          });
        }
        return;
      }

      if (customId.startsWith('ticket_')) {
        const parts = customId.split('_');
        const action = parts[1];
        const ticketId = parts[2];
        const ticket = this.ticketManager.getTicketById(ticketId);

        if (!ticket) {
          return interaction.reply({ content: '❌ Ticket introuvable ou déjà supprimé.', ephemeral: true });
        }

        switch (action) {
          case 'claim':
            await this.ticketManager.claimTicket(interaction, ticket);
            break;
          case 'close':
            await this.ticketManager.closeTicket(interaction, ticket);
            break;
          case 'delete':
            await this.ticketManager.deleteTicket(interaction, ticket);
            break;
          default:
            await interaction.reply({ content: '❌ Action inconnue.', ephemeral: true });
        }
      }
    });

    client.on('messageCreate', async (message) => {
      if (message.author.bot) return;

      if (!message.guild) {
        await this.ticketManager.relayUserToStaff(message);
        return;
      }

      const { staffGuildId } = this.store.getBot();
      if (staffGuildId && message.guild.id === staffGuildId) {
        await this.ticketManager.relayStaffToUser(message);
      }
    });
  }

  _buildTypeRows() {
    const rows = [];
    const types = getTicketTypes(this.store);
    for (let i = 0; i < types.length; i += 5) {
      const chunk = types.slice(i, i + 5);
      const row = new ActionRowBuilder();
      for (const type of chunk) {
        const button = new ButtonBuilder()
          .setCustomId(`open_ticket_${type.id}`)
          .setLabel(type.label)
          .setStyle(ButtonStyle.Secondary);

        if (isValidEmoji(type.emoji)) {
          button.setEmoji(type.emoji);
        } else {
          console.warn(`⚠️ Emoji invalide pour le type de ticket "${type.id}" ("${type.emoji}"), utilisation de 🎫 à la place.`);
          button.setEmoji('🎫');
        }

        row.addComponents(button);
      }
      rows.push(row);
    }
    return rows;
  }

  async _refreshPanel() {
    if (!this.client || this.status !== 'online') {
      return { ok: false, reason: 'Le bot est hors ligne, impossible de republier le panel.' };
    }

    const { panelChannelId } = this.store.getBot();
    if (!panelChannelId) {
      return { ok: false, reason: "Aucun salon de panel configuré (onglet \"Configuration générale\")." };
    }

    try {
      const channel = await this.client.channels.fetch(panelChannelId);
      if (!channel) {
        return { ok: false, reason: 'Le salon configuré pour le panel est introuvable (a-t-il été supprimé ?).' };
      }

      const messages = await channel.messages.fetch({ limit: 50 });
      const existing = messages.find((m) => m.author.id === this.client.user.id && m.embeds.length > 0);
      if (existing) await existing.delete().catch(() => {});

      const rows = this._buildTypeRows();
      const embed = createPanelEmbed(this.store);

      await channel.send({ embeds: [embed], components: rows });
      console.log(`📨 [tenant ${this.tenantId}] Panel envoyé/mis à jour dans le salon`);
      return { ok: true };
    } catch (err) {
      console.error('Erreur panel:', err.message);
      return { ok: false, reason: `Erreur Discord lors de l'envoi du panel : ${err.message} (vérifie les permissions du bot dans ce salon).` };
    }
  }

  async refreshPanel() {
    return this._refreshPanel();
  }
}

// ── BotManager : Map<tenantId, BotController> ────────────────────────
// Point d'entrée unique pour obtenir/démarrer/arrêter le bot d'un tenant.
class BotManager {
  constructor() {
    this._controllers = new Map();
  }

  // Ne démarre RIEN — retourne juste le contrôleur (le crée s'il n'existe
  // pas encore). Le démarrage effectif est explicite (voir `start`) pour
  // ne pas connecter un bot juste parce qu'on a consulté son statut.
  get(tenantId, store) {
    if (!this._controllers.has(tenantId)) {
      if (!store) throw new Error(`botManager.get(${tenantId}) appelé sans store alors qu'aucun contrôleur n'existe encore.`);
      this._controllers.set(tenantId, new BotController(tenantId, store));
    }
    return this._controllers.get(tenantId);
  }

  has(tenantId) {
    return this._controllers.has(tenantId);
  }

  async stopAll() {
    await Promise.all([...this._controllers.values()].map((c) => c.stop().catch(() => {})));
  }

  allControllers() {
    return [...this._controllers.values()];
  }
}

module.exports = new BotManager();
