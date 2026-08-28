const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { pool, ensureSchema } = require('./db');
const customerCodes = require('./customerCodes');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'settings.default.json');
const GLOBAL_KEY = 'global_settings';

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function kvGet(key) {
  const [rows] = await pool.query('SELECT value FROM kv_store WHERE `key` = ?', [key]);
  return rows.length ? JSON.parse(rows[0].value) : null;
}

async function kvSet(key, data) {
  const json = JSON.stringify(data);
  await pool.query(
    'INSERT INTO kv_store (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, json]
  );
}

// ─────────────────────────────────────────────────────────────────
// GlobalStore : config UNIQUE à toute l'application.
// Ne contient QUE ce qui sert à authentifier les gens (l'app OAuth2
// Discord utilisée pour le bouton "Se connecter") + le secret de
// session. Ne contient PLUS jamais de données propres à un client
// (bot, tickets, adminIds) : c'était le mélange qui causait la fuite.
// ─────────────────────────────────────────────────────────────────
class GlobalStore {
  constructor() {
    this.settings = null;
    this.ready = false;
    this._initPromise = null;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._load();
    await this._initPromise;
    this.ready = true;
    return this.settings;
  }

  _assertReady() {
    if (!this.ready) {
      throw new Error('GlobalStore non initialisé — appelle await globalStore.init() au démarrage.');
    }
  }

  async _load() {
    await ensureSchema();

    const defaults = {
      auth: { clientId: '', clientSecret: '', redirectUri: '' },
      sessionSecret: null,
    };

    let current = {};
    try {
      current = (await kvGet(GLOBAL_KEY)) || {};
    } catch (err) {
      console.error('⚠️ Impossible de lire global_settings depuis MySQL, valeurs par défaut:', err.message);
    }

    const merged = deepMerge(defaults, current);
    if (!merged.sessionSecret) {
      merged.sessionSecret = crypto.randomBytes(32).toString('hex');
    }

    this.settings = merged;
    await kvSet(GLOBAL_KEY, merged);
    return merged;
  }

  save() {
    kvSet(GLOBAL_KEY, this.settings).catch((err) =>
      console.error('❌ Échec sauvegarde global_settings:', err.message)
    );
  }

  hasAuthApp() {
    this._assertReady();
    return !!(this.settings.auth.clientId && this.settings.auth.clientSecret);
  }

  getAuthConfig() {
    this._assertReady();
    return { ...this.settings.auth };
  }

  setAuthConfig(patch) {
    this._assertReady();
    this.settings.auth = deepMerge(this.settings.auth, patch);
    this.save();
    return this.getAuthConfig();
  }

  getSessionSecret() {
    this._assertReady();
    return this.settings.sessionSecret;
  }
}

// ─────────────────────────────────────────────────────────────────
// TenantStore : config PROPRE à un client (un dashboard = un tenant).
// Une instance par tenant_id, jamais partagée entre clients.
// ─────────────────────────────────────────────────────────────────
class TenantStore extends EventEmitter {
  constructor(tenantId) {
    super();
    this.tenantId = tenantId;
    this.settings = null;
    this.ready = false;
    this._initPromise = null;
  }

  get _key() {
    return `tenant:${this.tenantId}`;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._load();
    await this._initPromise;
    this.ready = true;
    return this.settings;
  }

  _assertReady() {
    if (!this.ready) {
      throw new Error(`TenantStore(${this.tenantId}) non initialisé — appelle await store.init() d'abord.`);
    }
  }

  async _load() {
    await ensureSchema();
    const defaults = JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf8'));
    // Le default global n'a plus besoin des champs OAuth ni sessionSecret
    // (déplacés dans GlobalStore) : on les retire s'ils traînent encore
    // dans data/settings.default.json pour éviter toute confusion.
    delete defaults.auth?.clientId;
    delete defaults.auth?.clientSecret;
    delete defaults.auth?.redirectUri;
    delete defaults.sessionSecret;
    if (!defaults.auth) defaults.auth = { adminIds: [], adminRoles: {}, guildId: '' };
    if (!('adminIds' in defaults.auth)) defaults.auth.adminIds = [];
    if (!('adminRoles' in defaults.auth)) defaults.auth.adminRoles = {};

    let current = {};
    try {
      current = (await kvGet(this._key)) || {};
    } catch (err) {
      console.error(`⚠️ Impossible de lire ${this._key} depuis MySQL, valeurs par défaut:`, err.message);
    }

    const merged = deepMerge(defaults, current);
    this.settings = merged;
    await kvSet(this._key, merged);
    return merged;
  }

  save() {
    kvSet(this._key, this.settings).catch((err) =>
      console.error(`❌ Échec sauvegarde ${this._key}:`, err.message)
    );
  }

  // ── Admins (scopés à CE tenant uniquement) ──────────────────────
  isAdmin(discordId) {
    this._assertReady();
    return this.settings.auth.adminIds.includes(discordId);
  }

  hasAnyAdmin() {
    this._assertReady();
    return this.settings.auth.adminIds.length > 0;
  }

  getAdminIds() {
    this._assertReady();
    return [...this.settings.auth.adminIds];
  }

  // ── Rôles (administrateur / moderateur / visiteur) ───────────────
  // Un compte présent dans adminIds mais absent de adminRoles est
  // considéré "administrateur" (comptes créés avant l'introduction
  // des rôles → on ne change pas leur niveau d'accès existant).
  static ROLES = ['administrateur', 'moderateur', 'visiteur'];

  getAdminRole(discordId) {
    this._assertReady();
    if (!this.settings.auth.adminIds.includes(discordId)) return null;
    return this.settings.auth.adminRoles[discordId] || 'administrateur';
  }

  getAdminsWithRoles() {
    this._assertReady();
    return this.settings.auth.adminIds.map((id) => ({
      id,
      role: this.settings.auth.adminRoles[id] || 'administrateur',
    }));
  }

  countAdministrateurs() {
    this._assertReady();
    return this.getAdminsWithRoles().filter((a) => a.role === 'administrateur').length;
  }

  setAdminRole(discordId, role) {
    this._assertReady();
    if (!TenantStore.ROLES.includes(role)) throw new Error('Rôle invalide.');
    if (!this.settings.auth.adminIds.includes(discordId)) throw new Error('Ce compte n\'a pas accès au dashboard.');

    const current = this.getAdminRole(discordId);
    if (current === 'administrateur' && role !== 'administrateur' && this.countAdministrateurs() <= 1) {
      throw new Error('Impossible de retirer le dernier administrateur.');
    }

    this.settings.auth.adminRoles[discordId] = role;
    this.save();
    return this.getAdminsWithRoles();
  }

  // NB: la mise à jour de la table tenant_admins (utilisée pour retrouver
  // à quel tenant appartient un discord_id à la connexion) est faite par
  // l'appelant (tenantManager.addAdminToTenant) en plus de cet appel, pour
  // garder ce fichier indépendant de la connexion DB "métier".
  addAdmin(discordId, role = 'administrateur') {
    this._assertReady();
    if (!TenantStore.ROLES.includes(role)) role = 'administrateur';
    if (!this.settings.auth.adminIds.includes(discordId)) {
      this.settings.auth.adminIds.push(discordId);
    }
    this.settings.auth.adminRoles[discordId] = role;
    this.save();
    return this.getAdminsWithRoles();
  }

  removeAdmin(discordId) {
    this._assertReady();
    this.settings.auth.adminIds = this.settings.auth.adminIds.filter((id) => id !== discordId);
    delete this.settings.auth.adminRoles[discordId];
    this.save();
    return this.getAdminsWithRoles();
  }

  getGuildId() {
    this._assertReady();
    return this.settings.auth.guildId || '';
  }

  setGuildId(guildId) {
    this._assertReady();
    this.settings.auth.guildId = guildId;
    this.save();
  }

  // ── Bot settings ──────────────────────────────────────
  getBot() {
    this._assertReady();
    return { ...this.settings.bot };
  }

  setBot(patch) {
    this._assertReady();
    const before = JSON.stringify(this.settings.bot);
    this.settings.bot = deepMerge(this.settings.bot, patch);
    this.save();
    const after = JSON.stringify(this.settings.bot);
    if (before !== after) this.emit('botSettingsChanged', this.getBot());
    return this.getBot();
  }

  // ── Serveur Minecraft (tenant de type "minecraft") ──────────────
  // Contient uniquement la CONFIG déclarée (version, type, ressources).
  // L'état d'exécution réel (process en cours, logs, PID) vit en mémoire
  // dans minecraftManager, jamais ici — comme pour le bot Discord, on ne
  // veut pas qu'un redémarrage du dashboard "ressuscite" un mauvais état.
  getMinecraft() {
    this._assertReady();
    if (!this.settings.minecraft) {
      this.settings.minecraft = {
        name: 'Mon serveur',
        edition: 'java', // 'java' | 'bedrock'
        mcVersion: '',
        serverType: 'paper',
        memoryMb: 1024,
        port: 25565,
        eulaAccepted: false,
        created: false,
        admins: [], // pseudos (Bedrock : gamertag) avec permission Creative auto — les autres restent en Survie
      };
    }
    return { ...this.settings.minecraft };
  }

  setMinecraft(patch) {
    this._assertReady();
    const before = this.getMinecraft();
    this.settings.minecraft = deepMerge(before, patch);
    this.save();
    const after = this.getMinecraft();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.emit('minecraftSettingsChanged', after);
    }
    return after;
  }

  // ── Playlist musicale (Configuration générale) ────────────────────
  // Liste de pistes uploadées par l'admin (tous formats acceptés côté
  // upload : .mp3, .wav, .mp4, .ogg, .flac...) + réglages de diffusion.
  // Les fichiers eux-mêmes vivent sur disque (voir lib/musicManager.js),
  // ici on ne stocke que les métadonnées + la config, comme pour le
  // reste des settings (petit blob JSON, pas de gros binaire en DB).
  getMusicPlaylist() {
    this._assertReady();
    if (!this.settings.musicPlaylist) {
      this.settings.musicPlaylist = {
        enabled: false, // diffusion automatique en boucle quand le serveur tourne
        volume: 100, // 0-100, appliqué via /playsound
        loop: true,
        trackDurationSec: 180, // durée avant de passer au morceau suivant
        tracks: [], // [{ id, name, filename, ext, sizeBytes, addedAt }]
        packUuid: null, // UUID stable du resource pack généré (voir lib/musicManager.js)
        packModuleUuid: null,
      };
    }
    return {
      ...this.settings.musicPlaylist,
      tracks: this.settings.musicPlaylist.tracks.map((t) => ({ ...t })),
    };
  }

  setMusicPlaylist(patch) {
    this._assertReady();
    const before = this.getMusicPlaylist();
    const merged = { ...before, ...patch };
    if (patch.tracks) merged.tracks = patch.tracks; // remplacement explicite, pas de merge profond sur le tableau
    this.settings.musicPlaylist = merged;
    this.save();
    const after = this.getMusicPlaylist();
    this.emit('musicPlaylistChanged', after);
    return after;
  }

  // ── DayZ (module additionnel du bot Discord) ─────────────────────
  // Config pure (RCon, dossier logs ADM, whitelist staff, zones safe).
  // Les DONNÉES joueurs (solde, kills, steamid<->discord) vivent en SQL
  // (table dayz_players), pas ici : ça grossit avec le nombre de joueurs,
  // contrairement au reste des settings qui est un petit blob JSON.
  getDayz() {
    this._assertReady();
    if (!this.settings.dayz) {
      this.settings.dayz = {
        enabled: false,
        currencySymbol: '💰',
        rcon: { host: '', port: 2302, password: '' },
        admLogDir: '',
        staffWhitelist: [],
        safeZones: [],
        commandsGuildId: '',
        // Liaison compte Nitrado (cf. lib/nitradoApi.js) : permet de
        // récupérer host/port/password RCon + dossier de logs ADM
        // automatiquement, sans FTP/RCon en clair côté client (utile
        // pour un hébergement Nitrado PS4/PS5 où le client n'a de toute
        // façon pas d'accès direct au serveur).
        nitrado: { token: '', serviceId: '', linked: false, lastSyncAt: null, lastSyncError: null },
      };
    }
    return JSON.parse(JSON.stringify(this.settings.dayz));
  }

  setDayz(patch) {
    this._assertReady();
    const before = this.getDayz();
    this.settings.dayz = deepMerge(before, patch);
    this.save();
    const after = this.getDayz();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.emit('dayzSettingsChanged', after);
    }
    return after;
  }

  isDayzStaff(discordId) {
    this._assertReady();
    const dayz = this.getDayz();
    // Un administrateur du dashboard est toujours considéré staff DayZ
    // (évite de devoir se re-whitelister soi-même après avoir créé le
    // tenant) ; la whitelist sert surtout à ajouter du staff DayZ qui n'a
    // pas forcément accès au dashboard.
    return this.isAdmin(discordId) || dayz.staffWhitelist.includes(discordId);
  }

  addDayzSafeZone(zone) {
    this._assertReady();
    const dayz = this.getDayz();
    const id = crypto.randomBytes(4).toString('hex');
    dayz.safeZones.push({ id, ...zone });
    this.settings.dayz = dayz;
    this.save();
    return dayz.safeZones;
  }

  removeDayzSafeZone(id) {
    this._assertReady();
    const dayz = this.getDayz();
    dayz.safeZones = dayz.safeZones.filter((z) => z.id !== id);
    this.settings.dayz = dayz;
    this.save();
    return dayz.safeZones;
  }

  // ── Abonnement & paiement ───────────────────────────────
  getSubscription() {
    this._assertReady();
    return JSON.parse(JSON.stringify(this.settings.subscription));
  }

  setSubscription(patch) {
    this._assertReady();
    this.settings.subscription = deepMerge(this.settings.subscription, patch);
    this.save();
    return this.getSubscription();
  }

  // ── Ticket types ──────────────────────────────────────
  getTicketTypes() {
    this._assertReady();
    return this.settings.ticketTypes.map((t) => ({ ...t }));
  }

  setTicketTypes(types) {
    this._assertReady();
    this.settings.ticketTypes = types;
    this.save();
    this.emit('ticketTypesChanged', this.getTicketTypes());
    return this.getTicketTypes();
  }

  getAllKnownRoleIds() {
    this._assertReady();
    const ids = new Set();
    for (const t of this.settings.ticketTypes) {
      for (const r of t.allowedRoles || []) ids.add(r);
    }
    return [...ids];
  }
}

// ─────────────────────────────────────────────────────────────────
// TenantManager : résout/crée les tenants, met en cache une instance
// TenantStore par tenant_id (jamais deux instances pour le même id).
// ─────────────────────────────────────────────────────────────────
class TenantManager {
  constructor() {
    this._cache = new Map(); // tenantId -> TenantStore (initialisé)
  }

  async getStore(tenantId) {
    if (!tenantId) throw new Error('getStore appelé sans tenantId.');
    if (this._cache.has(tenantId)) return this._cache.get(tenantId);
    const store = new TenantStore(tenantId);
    await store.init();
    this._cache.set(tenantId, store);
    return store;
  }

  // Retourne le tenant_id auquel appartient ce discord_id (admin), ou null.
  // Un discord_id n'appartient qu'à UN SEUL tenant (contrainte volontaire :
  // pas de compte "multi-client" pour l'instant — évite toute ambiguïté
  // de session comme celle qui a causé le bug initial).
  async findTenantIdForDiscordUser(discordId) {
    await ensureSchema();
    const [rows] = await pool.query('SELECT tenant_id FROM tenant_admins WHERE discord_id = ? LIMIT 1', [discordId]);
    return rows.length ? rows[0].tenant_id : null;
  }

  // Crée un tenant tout neuf (dashboard vierge) pour ce discord_id, à
  // partir des defaults de data/settings.default.json. C'est LE point
  // d'entrée qui garantit qu'un nouveau client ne voit JAMAIS les
  // données d'un autre : chaque activation crée sa propre ligne isolée.
  async createTenantForDiscordUser(discordId, name, service = 'discord') {
    await ensureSchema();
    const safeService = service === 'minecraft' ? 'minecraft' : 'discord';
    const [result] = await pool.query(
      'INSERT INTO tenants (owner_discord_id, name, service) VALUES (?, ?, ?)',
      [discordId, name || null, safeService]
    );
    const tenantId = result.insertId;
    await this.addAdminToTenant(tenantId, discordId);
    // Force la création du document de settings par défaut en base.
    await this.getStore(tenantId);
    return tenantId;
  }

  async getService(tenantId) {
    await ensureSchema();
    const [rows] = await pool.query('SELECT service FROM tenants WHERE id = ? LIMIT 1', [tenantId]);
    return rows.length ? rows[0].service || 'discord' : 'discord';
  }

  // Change le service actif d'un tenant (bascule Discord <-> Minecraft
  // depuis la barre de navigation). On ne touche à rien d'autre : les
  // données de l'ancien service (config bot, config minecraft) restent
  // en base intactes, elles sont juste masquées tant que le service
  // n'est pas rebasculé dessus — rien n'est supprimé.
  async setService(tenantId, service) {
    await ensureSchema();
    const safeService = service === 'minecraft' ? 'minecraft' : 'discord';
    await pool.query('UPDATE tenants SET service = ? WHERE id = ?', [safeService, tenantId]);
    return safeService;
  }

  // ── Slug + appli Discord PROPRE à chaque tenant ─────────────────
  // Chaque client crée sa propre appli OAuth Discord via /setup : la
  // connexion au dashboard n'est plus mutualisée entre clients (fini le
  // souci où tout le monde se connectait via la même appli "mishima").

  slugify(raw) {
    const base = String(raw || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return base || 'client';
  }

  async isSlugTaken(slug) {
    await ensureSchema();
    const [rows] = await pool.query('SELECT id FROM tenants WHERE slug = ? LIMIT 1', [slug]);
    return rows.length > 0;
  }

  // Génère un slug unique à partir d'un nom souhaité (ajoute un suffixe
  // aléatoire si le slug "propre" est déjà pris par un autre client).
  async generateUniqueSlug(desiredName) {
    const base = this.slugify(desiredName);
    let candidate = base;
    let attempts = 0;
    while (await this.isSlugTaken(candidate)) {
      attempts += 1;
      candidate = `${base}-${crypto.randomBytes(2).toString('hex')}`;
      if (attempts > 20) throw new Error("Impossible de générer un identifiant d'espace unique.");
    }
    return candidate;
  }

  async findTenantBySlug(slug) {
    await ensureSchema();
    const [rows] = await pool.query('SELECT * FROM tenants WHERE slug = ? LIMIT 1', [slug]);
    return rows.length ? rows[0] : null;
  }

  // Login simplifié : le client tape directement SON CODE D'ACHAT (celui
  // reçu après paiement) pour retrouver son espace — pas besoin de
  // retenir un identifiant séparé. Deux chemins de résolution :
  //  1) le code == slug du tenant (cas normal, tenants créés via /setup
  //     depuis ce patch : le slug EST le code normalisé) ;
  //  2) fallback via la table customer_codes -> tenant_id, pour les
  //     tenants plus anciens dont le slug ne vient pas du code (ex:
  //     "mishima", migré depuis l'ancien système global).
  async findTenantByLoginCode(rawCode) {
    await ensureSchema();
    const normalized = customerCodes.normalizeCode(rawCode);
    if (!normalized) return null;

    const bySlug = await this.findTenantBySlug(normalized);
    if (bySlug) return bySlug;

    const [codeRows] = await pool.query('SELECT tenant_id FROM customer_codes WHERE code = ? LIMIT 1', [normalized]);
    if (codeRows.length && codeRows[0].tenant_id) {
      return this.findTenantById(codeRows[0].tenant_id);
    }
    // Dernier recours : peut-être que ce que le client a tapé est en fait
    // directement un ancien "identifiant d'espace" (slug texte, ex.
    // "mishima") plutôt qu'un code — on tente aussi tel quel.
    return this.findTenantBySlug(rawCode.trim());
  }

  async findTenantById(tenantId) {
    await ensureSchema();
    const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ? LIMIT 1', [tenantId]);
    return rows.length ? rows[0] : null;
  }

  // Crée un tenant vierge avec SA PROPRE appli Discord OAuth, mais sans
  // propriétaire pour l'instant : le propriétaire ne sera fixé qu'à la
  // première connexion réussie via /login/<code> (voir claimTenant).
  // Le slug du tenant = le code client normalisé : c'est CE code que le
  // client retape à chaque connexion, aucun autre identifiant à retenir.
  async createTenantWithApp({ name, clientId, clientSecret, loginCode }) {
    await ensureSchema();
    const desiredSlug = loginCode ? customerCodes.normalizeCode(loginCode) : null;
    const slug = desiredSlug && !(await this.isSlugTaken(desiredSlug))
      ? desiredSlug
      : await this.generateUniqueSlug(desiredSlug || name || clientId);
    const [result] = await pool.query(
      'INSERT INTO tenants (name, slug, client_id, client_secret) VALUES (?, ?, ?, ?)',
      [name || null, slug, clientId, clientSecret]
    );
    const tenantId = result.insertId;
    // Force la création du document de settings par défaut en base.
    await this.getStore(tenantId);
    return { tenantId, slug };
  }

  // Réclame la propriété d'un tenant fraîchement créé (encore sans
  // owner_discord_id) : opération atomique (le WHERE ... IS NULL évite
  // qu'une deuxième personne ne vole le tenant en cas de double clic).
  async claimTenant(tenantId, discordId) {
    await ensureSchema();
    const [result] = await pool.query(
      'UPDATE tenants SET owner_discord_id = ? WHERE id = ? AND owner_discord_id IS NULL',
      [discordId, tenantId]
    );
    if (result.affectedRows === 0) return false;
    await this.addAdminToTenant(tenantId, discordId, 'administrateur');
    return true;
  }

  async addAdminToTenant(tenantId, discordId, role = 'administrateur') {
    await ensureSchema();
    await pool.query(
      'INSERT IGNORE INTO tenant_admins (tenant_id, discord_id) VALUES (?, ?)',
      [tenantId, discordId]
    );
    const store = await this.getStore(tenantId);
    store.addAdmin(discordId, role);
  }

  async removeAdminFromTenant(tenantId, discordId) {
    await ensureSchema();
    await pool.query('DELETE FROM tenant_admins WHERE tenant_id = ? AND discord_id = ?', [tenantId, discordId]);
    const store = await this.getStore(tenantId);
    store.removeAdmin(discordId);
  }

  // ── Migration : rattache les tenants créés AVANT l'introduction du
  // slug/appli-Discord-par-client (client_id NULL en base) à l'ancienne
  // appli Discord globale, pour qu'ils redeviennent joignables via
  // /login/<slug> sans perdre leurs données (tickets, bot, admins…).
  // Idempotent : ne touche que les tenants encore sans client_id.
  async migrateLegacyTenantsWithoutApp(legacyAuth) {
    await ensureSchema();
    if (!legacyAuth || !legacyAuth.clientId || !legacyAuth.clientSecret) return;

    const [rows] = await pool.query("SELECT id, name, slug FROM tenants WHERE client_id IS NULL OR client_id = ''");
    for (const row of rows) {
      let slug = row.slug;
      if (!slug) slug = await this.generateUniqueSlug(row.name || `client-${row.id}`);
      await pool.query(
        'UPDATE tenants SET slug = ?, client_id = ?, client_secret = ? WHERE id = ?',
        [slug, legacyAuth.clientId, legacyAuth.clientSecret, row.id]
      );
      console.log(`🔧 Migration : tenant ${row.id} rattaché à l'ancienne appli Discord globale → /login/${slug}`);
    }
  }
}

module.exports = {
  globalStore: new GlobalStore(),
  tenantManager: new TenantManager(),
  TenantStore,
};