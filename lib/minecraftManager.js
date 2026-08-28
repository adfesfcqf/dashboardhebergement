const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const AdmZip = require('adm-zip');
const upnp = require('./upnp');
const processStats = require('./processStats');
const playerLog = require('./playerLog');

// ── Racine de stockage de TOUS les serveurs Minecraft ──────────────────
// Pour l'instant tout tourne en local (ton PC), donc un simple dossier
// sur disque suffit. Le jour où ça part sur un VPS, seule cette variable
// change (MC_DATA_DIR dans le .env) — le reste du code ne bouge pas.
const DATA_DIR = process.env.MC_DATA_DIR || path.join(__dirname, '..', 'data', 'minecraft');
const JAVA_BIN = process.env.JAVA_BIN || 'java';
const USER_AGENT = 'modmail-bot-dashboard/1.0 (contact: admin@localhost)';

// ── Édition du serveur : "java" (Paper, comportement historique) ou
// "bedrock" (Bedrock Dedicated Server officiel Mojang). Tout le code qui
// dépend de l'édition passe par cette normalisation pour éviter les
// surprises si une valeur inattendue traîne dans les settings.
function normalizeEdition(edition) {
  return edition === 'bedrock' ? 'bedrock' : 'java';
}

const MAX_LOG_LINES = 500;

function tenantDir(tenantId) {
  return path.join(DATA_DIR, String(tenantId));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Requête échouée (${res.status}) : ${url}`);
  return res.json();
}

// ── Adresse de connexion réelle du serveur ──────────────────────────
// IP locale (réseau du même LAN / VPS) : utile en dev ou en LAN. IP
// publique : celle que tes potes utilisent réellement pour se connecter
// depuis internet (nécessite le port ouvert/redirigé côté box ou pare-feu
// du VPS). On renvoie les deux, le front affiche ce qui est pertinent.
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

let cachedPublicIp = null;
let cachedPublicIpAt = 0;
async function getPublicIp() {
  const now = Date.now();
  if (cachedPublicIp && now - cachedPublicIpAt < 5 * 60 * 1000) return cachedPublicIp;
  try {
    const data = await fetchJson('https://api.ipify.org?format=json');
    cachedPublicIp = data.ip;
    cachedPublicIpAt = now;
    return cachedPublicIp;
  } catch {
    return null;
  }
}

async function getConnectionInfo(port) {
  const [publicIp] = await Promise.all([getPublicIp()]);
  return {
    localIp: getLocalIp(),
    publicIp,
    port: Number(port) || 25565,
    address: `${publicIp || getLocalIp()}:${Number(port) || 25565}`,
  };
}

// ── API PaperMC (Fill v3) : liste des versions dispo + téléchargement du
// dernier build stable pour une version donnée. Paper = le choix par
// défaut pour 90% des serveurs (perf + compatibilité plugins Spigot/Bukkit).
async function listAvailableVersions() {
  const data = await fetchJson('https://fill.papermc.io/v3/projects/paper');
  const groups = data.versions || {};
  const versions = Object.values(groups).flat();
  return versions.reverse(); // plus récentes en premier
}

async function getLatestStableDownload(mcVersion) {
  const builds = await fetchJson(`https://fill.papermc.io/v3/projects/paper/versions/${mcVersion}/builds`);
  const stable = builds.find((b) => b.channel === 'STABLE');
  if (!stable) throw new Error(`Aucun build stable pour la version ${mcVersion}.`);
  const dl = stable.downloads['server:default'];
  if (!dl) throw new Error('Build stable trouvé mais sans jar serveur téléchargeable.');
  return { url: dl.url, name: dl.name, build: stable.id };
}

// ── API officielle Mojang (utilisée par le launcher officiel et par la
// page minecraft.net/download/server/bedrock) : renvoie les liens de
// téléchargement à jour du Bedrock Dedicated Server pour chaque plateforme.
// Contrairement à Paper, il n'existe pas de liste de versions choisissable :
// Mojang ne distribue que le dernier build stable, donc on le récupère et
// on en extrait le numéro de version depuis le nom du fichier.
const BEDROCK_LINKS_API = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';

// Le CDN Akamai qui sert les zips (www.minecraft.net/bedrockdedicatedserver/…)
// bloque les User-Agent "de script" (curl, node-fetch par défaut, notre UA
// maison, etc.) et renvoie une page d'erreur HTML avec un statut 200 — d'où
// le besoin d'un UA de navigateur/launcher pour cette requête précise. Tous
// les outils communautaires (scripts Pterodactyl, Docker itzg/…) utilisent
// exactement cette astuce.
const BEDROCK_DOWNLOAD_USER_AGENT = 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; BEDROCK-UPDATER)';

async function getBedrockServerDownload() {
  const data = await fetchJson(BEDROCK_LINKS_API);
  const links = data?.result?.links || [];
  // Le zip Linux contient un binaire ELF nommé "bedrock_server", le zip
  // Windows un exécutable "bedrock_server.exe" — il faut prendre celui qui
  // correspond à la plateforme qui exécute CE dashboard (process.platform),
  // sinon le binaire téléchargé ne correspond jamais au nom attendu par
  // start()/getStatus() (bug corrigé : avant on prenait toujours Linux).
  const wantedType = process.platform === 'win32' ? 'serverBedrockWindows' : 'serverBedrockLinux';
  const link = links.find((l) => l.downloadType === wantedType);
  if (!link?.downloadUrl) throw new Error(`Impossible de trouver le lien de téléchargement du Bedrock Dedicated Server (${wantedType}).`);
  const match = link.downloadUrl.match(/bedrock-server-([\d.]+)\.zip/i);
  return { url: link.downloadUrl, version: match ? match[1].replace(/\.$/, '') : 'inconnue' };
}

async function downloadFile(url, destPath, extraHeaders = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...extraHeaders } });
  if (!res.ok || !res.body) throw new Error(`Téléchargement échoué (${res.status})`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error(`Le serveur de téléchargement a renvoyé une page web au lieu du fichier attendu (souvent un blocage anti-robot). URL : ${url}`);
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;
  const fileStream = fs.createWriteStream(tmpPath);
  await new Promise((resolve, reject) => {
    const { Readable } = require('stream');
    Readable.fromWeb(res.body).pipe(fileStream).on('finish', resolve).on('error', reject);
  });
  await fsp.rename(tmpPath, destPath);
}

// Vérifie que le fichier téléchargé est bien une archive ZIP valide (signature
// "PK") avant de tenter de l'extraire — un blocage anti-robot silencieux
// (page HTML renvoyée avec Content-Type générique, ou fichier tronqué) donne
// sinon une erreur AdmZip incompréhensible ("Invalid CEN header").
async function assertIsZip(filePath) {
  const fd = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fd.read(buf, 0, 4, 0);
    if (buf.toString('latin1', 0, 2) !== 'PK') {
      throw new Error("Le fichier téléchargé n'est pas une archive ZIP valide (probablement bloqué par le CDN de téléchargement — réessaie dans quelques minutes).");
    }
  } finally {
    await fd.close();
  }
}


// ── Contenu par défaut de server.properties ─────────────────────────
// Reprend l'intégralité des clés que Mojang/Paper génère sur un serveur
// tout neuf (mêmes noms, mêmes valeurs par défaut), pour que le fichier
// affiché dans le gestionnaire de fichiers soit identique à un vrai
// server.properties fraîchement installé — pas une version tronquée.
function buildServerProperties({ port, motd, maxPlayers }) {
  const lines = [
    '#Minecraft server properties',
    `#${new Date().toString()}`,
    'accepts-transfers=false',
    'allow-flight=false',
    'allow-nether=true',
    'broadcast-console-to-ops=true',
    'broadcast-rcon-to-ops=true',
    'bug-report-link=',
    'debug=false',
    'difficulty=easy',
    'enable-command-block=false',
    'enable-jmx-monitoring=false',
    'enable-query=false',
    'enable-rcon=false',
    'enable-status=true',
    'enforce-secure-profile=true',
    'enforce-whitelist=false',
    'entity-broadcast-range-percentage=100',
    'force-gamemode=false',
    'function-permission-level=2',
    'gamemode=survival',
    'generate-structures=true',
    'generator-settings={}',
    'hardcore=false',
    'hide-online-players=false',
    'initial-disabled-packs=',
    'initial-enabled-packs=vanilla',
    'level-name=world',
    'level-seed=',
    'level-type=minecraft\\:normal',
    `max-chained-neighbor-updates=1000000`,
    `max-players=${maxPlayers || 20}`,
    'max-tick-time=60000',
    'max-world-size=29999984',
    'motd=' + (motd || 'Serveur Minecraft'),
    'network-compression-threshold=256',
    'online-mode=true',
    'op-permission-level=4',
    'player-idle-timeout=0',
    'prevent-proxy-connections=false',
    'pvp=true',
    'query.port=' + (port || 25565),
    'rate-limit=0',
    'rcon.password=',
    'rcon.port=25575',
    'require-resource-pack=false',
    'resource-pack=',
    'resource-pack-id=',
    'resource-pack-prompt=',
    'resource-pack-sha1=',
    `server-ip=`,
    `server-port=${port || 25565}`,
    'simulation-distance=10',
    'spawn-monsters=true',
    'spawn-protection=16',
    'sync-chunk-writes=true',
    'text-filtering-config=',
    'use-native-transport=true',
    'view-distance=10',
    'white-list=false',
    '',
  ];
  return lines.join('\n');
}

// ── Mise à jour d'un serveur déjà installé : contrairement à provision()
// (installation initiale), on ne doit JAMAIS écraser les données propres
// au joueur/à l'admin — le monde, la config, les listes de joueurs, les
// packs déjà installés. On ne rafraîchit que les fichiers "moteur du jeu"
// (binaire/jar, libs, packs vanilla fournis par Mojang/PaperMC).
const PRESERVE_ON_UPDATE = new Set([
  // Bedrock
  'server.properties', 'allowlist.json', 'permissions.json', 'valid_known_packs.json',
  'config', // config/default — packs installés par l'utilisateur (voir registerWorldPack)
  'packs', // archives .mcpack/.mcaddon envoyées par l'utilisateur
  'worlds',
  // Java (au cas où un jour un update Java copierait aussi un dossier complet)
  'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json',
  'world', 'world_nether', 'world_the_end', 'plugins', 'logs',
]);

// Copie tout le contenu de `srcDir` vers `destDir`, sauf les noms listés
// dans `preserve` (données déjà en place qu'on ne touche pas). Utilisé
// pour appliquer une mise à jour Bedrock (dézippée dans un dossier
// temporaire) par-dessus une installation existante sans perdre le monde,
// la config ou les packs déjà installés.
async function copyFreshFilesPreserving(srcDir, destDir, preserve) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  await fsp.mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    if (preserve.has(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.cp(src, dest, { recursive: true });
  }
}

// ── Écrit tout ce qu'un serveur Paper fraîchement installé possède
// avant même son premier lancement. Le reste (bukkit.yml, spigot.yml,
// config/paper-global.yml, config/paper-world-defaults.yml, logs/…) est
// généré par le jar lui-même au premier `java -jar server.jar` — on ne
// le pré-écrit pas à la main pour ne jamais désynchroniser ces fichiers
// des vrais defaults de la version téléchargée.
async function writeDefaultConfigFiles(dir, { port, motd, maxPlayers } = {}) {
  await fsp.mkdir(dir, { recursive: true });

  await fsp.writeFile(
    path.join(dir, 'eula.txt'),
    [`#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).`, `#${new Date().toString()}`, 'eula=true', ''].join('\n')
  );

  await fsp.writeFile(path.join(dir, 'server.properties'), buildServerProperties({ port, motd, maxPlayers }));

  // Listes de joueurs : vides par défaut sur tout serveur neuf.
  await fsp.writeFile(path.join(dir, 'ops.json'), '[]\n');
  await fsp.writeFile(path.join(dir, 'whitelist.json'), '[]\n');
  await fsp.writeFile(path.join(dir, 'banned-players.json'), '[]\n');
  await fsp.writeFile(path.join(dir, 'banned-ips.json'), '[]\n');
  await fsp.writeFile(path.join(dir, 'usercache.json'), '[]\n');
}

// Dézippe l'archive du Bedrock Dedicated Server directement dans le
// dossier du tenant (le zip contient bedrock_server + toutes ses libs
// + un server.properties/permissions.json par défaut qu'on écrase juste
// après avec nos propres valeurs).
async function extractZip(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  await new Promise((resolve, reject) => {
    zip.extractAllToAsync(destDir, true, false, (err) => (err ? reject(err) : resolve()));
  });
  await fsp.rm(zipPath, { force: true });
}

// ── Contenu par défaut du server.properties Bedrock ─────────────────
// Reprend les clés telles que le Bedrock Dedicated Server officiel les
// génère (server-name, gamemode, permissions, propriétés "content-log-*"
// des versions récentes, etc.), pour un fichier identique à celui d'un
// vrai serveur Bedrock fraîchement installé.
function buildBedrockServerProperties({ port, motd, maxPlayers }) {
  const lines = [
    'server-name=' + (motd || 'Serveur Minecraft'),
    'gamemode=survival',
    'force-gamemode=false',
    'difficulty=easy',
    'allow-cheats=false',
    `max-players=${maxPlayers || 20}`,
    'online-mode=true',
    'allow-list=false',
    `server-port=${port || 19132}`,
    `server-portv6=${(Number(port) || 19132) + 1}`,
    'view-distance=10',
    'tick-distance=4',
    'player-idle-timeout=0',
    'max-threads=8',
    'level-name=world',
    'level-seed=',
    'default-player-permission-level=member',
    'texturepack-required=false',
    'content-log-file-enabled=false',
    'content-log-console-output-enabled=false',
    'content-log-level=info',
    'compression-threshold=1',
    'compression-algorithm=zlib',
    'server-authoritative-block-breaking=false',
    'disable-player-interaction=false',
    'chat-restriction=None',
    'client-side-chunk-generation-enabled=true',
    'op-permission-level=1',
    'server-authoritative-movement=server-auth',
    'correct-player-movement=false',
    'server-authoritative-block-actions=true',
    'level-type=DEFAULT',
    'emit-server-telemetry=false',
    'server-authoritative-block-breaking-pick-range-scalar=1.0',
    '',
  ];
  return lines.join('\n');
}

// ── Arborescence par défaut d'un serveur Bedrock fraîchement installé.
// En plus des fichiers propres au binaire officiel (déjà présents après
// dézippage), on prépare :
//   - config/default/ : dossier vide destiné à recevoir les packs de
//     comportement/ressources (l'équivalent des "plugins" côté Bedrock).
//   - packs/           : dossier vide pour les archives .mcpack/.mcaddon
//     envoyées par l'utilisateur avant installation dans config/default.
async function writeDefaultConfigFilesBedrock(dir, { port, motd, maxPlayers } = {}) {
  await fsp.mkdir(path.join(dir, 'config', 'default'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'packs'), { recursive: true });

  await fsp.writeFile(path.join(dir, 'server.properties'), buildBedrockServerProperties({ port, motd, maxPlayers }));

  // Listes de joueurs : équivalents Bedrock de whitelist.json/ops.json.
  await fsp.writeFile(path.join(dir, 'allowlist.json'), '[]\n');
  await fsp.writeFile(path.join(dir, 'permissions.json'), '[]\n');
}

// ── Installation de packs Bedrock (.mcpack / .mcaddon) ─────────────────
// Reçoit l'archive envoyée depuis le dashboard (upload en base64), l'extrait
// (en gérant le cas .mcaddon qui contient lui-même plusieurs .mcpack
// imbriqués), lit chaque manifest.json trouvé pour déterminer s'il s'agit
// d'un pack de comportement ("data") ou de ressources ("resources" /
// "client_data"), copie le pack directement dans behavior_packs/ ou
// resource_packs/ à la racine du serveur (l'arborescence réelle utilisée
// par le binaire Bedrock officiel) et l'active pour le monde courant via
// world_behavior_packs.json /
// world_resource_packs.json — sans redémarrage manuel nécessaire côté
// utilisateur (juste relancer le serveur pour que Bedrock les charge).

// Dézippe récursivement : après extraction d'une archive, si des fichiers
// .mcpack/.mcaddon/.zip imbriqués traînent dans le résultat (cas d'un
// .mcaddon qui empaquette plusieurs .mcpack), on les extrait à leur tour,
// jusqu'à ce qu'il ne reste plus que des dossiers de packs "à plat".
async function extractNestedArchives(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await extractNestedArchives(full);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== '.mcpack' && ext !== '.mcaddon' && ext !== '.zip') continue;
    const destDir = path.join(root, entry.name.replace(/\.[^.]+$/, '') + '__extracted');
    try {
      const zip = new AdmZip(full);
      await new Promise((resolve, reject) => {
        zip.extractAllToAsync(destDir, true, false, (err) => (err ? reject(err) : resolve()));
      });
      await fsp.rm(full, { force: true });
      await extractNestedArchives(destDir);
    } catch {
      // Pas une archive valide (ou déjà un fichier de pack normal) — on laisse tel quel.
    }
  }
}

// Recherche récursive de tous les manifest.json (un .mcaddon peut en
// contenir plusieurs, un pour chaque pack qu'il regroupe).
async function findManifests(root) {
  const results = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.toLowerCase() === 'manifest.json') results.push(full);
    }
  }
  await walk(root);
  return results;
}

function sanitizePackFolderName(name) {
  return String(name || 'pack').replace(/[^a-zA-Z0-9_\-. ]+/g, '_').trim().slice(0, 60) || 'pack';
}

// Active un pack pour le monde courant en l'ajoutant à
// worlds/<level-name>/world_behavior_packs.json (ou world_resource_packs.json).
// Le fichier peut ne pas encore exister (monde jamais généré) : on le crée.
async function registerWorldPack(dir, kind, packId, version) {
  const props = await readServerProperties(dir);
  const levelName = props['level-name'] || 'world';
  const worldDir = path.join(dir, 'worlds', levelName);
  await fsp.mkdir(worldDir, { recursive: true });
  const jsonName = kind === 'resource_packs' ? 'world_resource_packs.json' : 'world_behavior_packs.json';
  const filePath = path.join(worldDir, jsonName);
  let list = [];
  try {
    list = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  list = list.filter((p) => p.pack_id !== packId);
  list.push({ pack_id: packId, version: Array.isArray(version) ? version : [1, 0, 0] });
  await fsp.writeFile(filePath, JSON.stringify(list, null, 2));
}

async function installPack(tenantId, base64, originalFilename) {
  const dir = tenantDir(tenantId);
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-pack-'));
  try {
    const zipPath = path.join(tmpDir, 'upload.zip');
    await fsp.writeFile(zipPath, Buffer.from(String(base64 || ''), 'base64'));
    await assertIsZip(zipPath);

    const extractRoot = path.join(tmpDir, 'extracted');
    const zip = new AdmZip(zipPath);
    await new Promise((resolve, reject) => {
      zip.extractAllToAsync(extractRoot, true, false, (err) => (err ? reject(err) : resolve()));
    });
    await extractNestedArchives(extractRoot);

    const manifests = await findManifests(extractRoot);
    if (!manifests.length) {
      throw new Error(
        `"${originalFilename || 'fichier'}" ne contient aucun manifest.json — ce n'est pas un pack Bedrock (.mcpack/.mcaddon) valide.`
      );
    }

    const installed = [];
    for (const manifestPath of manifests) {
      const packSrcDir = path.dirname(manifestPath);
      let manifest;
      try {
        manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      } catch {
        continue; // manifest illisible/corrompu — on saute ce pack, on continue les autres
      }
      const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
      const isResource = modules.some((m) => m.type === 'resources' || m.type === 'client_data');
      const kind = isResource ? 'resource_packs' : 'behavior_packs';
      const uuid = manifest.header?.uuid || crypto.randomUUID();
      const name = manifest.header?.name || (kind === 'resource_packs' ? 'Pack de textures' : 'Pack de comportement');
      const folderName = `${sanitizePackFolderName(name)}_${uuid}`;
      const destDir = path.join(dir, kind, folderName);

      await fsp.rm(destDir, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(destDir), { recursive: true });
      await fsp.cp(packSrcDir, destDir, { recursive: true });

      await registerWorldPack(dir, kind, uuid, manifest.header?.version);

      installed.push({ name, kind: kind === 'resource_packs' ? 'resource' : 'behavior', uuid });
    }

    if (!installed.length) {
      throw new Error('Aucun pack valide trouvé dans le fichier envoyé (manifest.json corrompu).');
    }
    return installed;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Schéma des champs affichés dans l'onglet "Configuration" du
// dashboard : un descripteur {key, label, type, options?} par clé de
// server.properties, un tableau par édition. C'est uniquement pour le
// rendu du formulaire côté front — les valeurs réelles sont toujours
// lues/écrites depuis le vrai fichier server.properties du tenant.
const JAVA_PROPERTY_SCHEMA = [
  { key: 'motd', label: 'Message du jour (MOTD)', type: 'text' },
  { key: 'max-players', label: 'Joueurs maximum', type: 'number' },
  { key: 'server-port', label: 'Port', type: 'number' },
  { key: 'gamemode', label: 'Mode de jeu', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'difficulty', label: 'Difficulté', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'hardcore', label: 'Hardcore', type: 'bool' },
  { key: 'pvp', label: 'PvP', type: 'bool' },
  { key: 'white-list', label: 'Liste blanche (whitelist)', type: 'bool' },
  { key: 'enforce-whitelist', label: 'Forcer la whitelist', type: 'bool' },
  { key: 'online-mode', label: 'Mode en ligne (vérif compte Mojang)', type: 'bool' },
  { key: 'allow-flight', label: 'Autoriser le vol', type: 'bool' },
  { key: 'allow-nether', label: 'Autoriser le Nether', type: 'bool' },
  { key: 'spawn-monsters', label: 'Faire apparaître des monstres', type: 'bool' },
  { key: 'spawn-protection', label: 'Protection du spawn (rayon)', type: 'number' },
  { key: 'view-distance', label: 'Distance de vue (chunks)', type: 'number' },
  { key: 'simulation-distance', label: 'Distance de simulation (chunks)', type: 'number' },
  { key: 'level-name', label: 'Nom du monde', type: 'text' },
  { key: 'level-seed', label: 'Seed du monde', type: 'text' },
  { key: 'level-type', label: 'Type de monde', type: 'text' },
  { key: 'op-permission-level', label: 'Niveau de permission des OP', type: 'number' },
  { key: 'function-permission-level', label: 'Niveau de permission des fonctions', type: 'number' },
  { key: 'player-idle-timeout', label: "Déconnexion auto (min. d'inactivité, 0 = désactivé)", type: 'number' },
  { key: 'enable-command-block', label: 'Activer les blocs de commande', type: 'bool' },
  { key: 'enable-query', label: 'Activer le protocole Query', type: 'bool' },
  { key: 'enable-rcon', label: 'Activer RCON', type: 'bool' },
  { key: 'rcon.password', label: 'Mot de passe RCON', type: 'text' },
  { key: 'rcon.port', label: 'Port RCON', type: 'number' },
  { key: 'require-resource-pack', label: 'Resource pack obligatoire', type: 'bool' },
  { key: 'resource-pack', label: 'URL du resource pack', type: 'text' },
  { key: 'resource-pack-sha1', label: 'SHA1 du resource pack', type: 'text' },
  { key: 'prevent-proxy-connections', label: 'Bloquer les connexions via proxy/VPN', type: 'bool' },
  { key: 'hide-online-players', label: 'Masquer les joueurs en ligne (liste serveur)', type: 'bool' },
];

const BEDROCK_PROPERTY_SCHEMA = [
  { key: 'server-name', label: 'Nom du serveur', type: 'text' },
  { key: 'gamemode', label: 'Mode de jeu', type: 'select', options: ['survival', 'creative', 'adventure'] },
  { key: 'force-gamemode', label: 'Forcer le mode de jeu', type: 'bool' },
  { key: 'difficulty', label: 'Difficulté', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'allow-cheats', label: 'Autoriser les cheats', type: 'bool' },
  { key: 'max-players', label: 'Joueurs maximum', type: 'number' },
  { key: 'online-mode', label: 'Mode en ligne (vérif compte Xbox Live)', type: 'bool' },
  { key: 'allow-list', label: 'Liste blanche (allowlist)', type: 'bool' },
  { key: 'server-port', label: 'Port (IPv4)', type: 'number' },
  { key: 'server-portv6', label: 'Port (IPv6)', type: 'number' },
  { key: 'view-distance', label: 'Distance de vue (chunks)', type: 'number' },
  { key: 'tick-distance', label: 'Distance de simulation (tick-distance)', type: 'number' },
  { key: 'player-idle-timeout', label: "Déconnexion auto (min. d'inactivité, 0 = désactivé)", type: 'number' },
  { key: 'max-threads', label: 'Threads maximum', type: 'number' },
  { key: 'level-name', label: 'Nom du monde', type: 'text' },
  { key: 'level-seed', label: 'Seed du monde', type: 'text' },
  { key: 'default-player-permission-level', label: 'Permission par défaut des joueurs', type: 'select', options: ['visitor', 'member', 'operator'] },
  { key: 'texturepack-required', label: 'Pack de textures obligatoire', type: 'bool' },
  { key: 'content-log-file-enabled', label: 'Journal de contenu (fichier)', type: 'bool' },
  { key: 'content-log-console-output-enabled', label: 'Journal de contenu (console)', type: 'bool' },
  { key: 'content-log-level', label: 'Niveau de journalisation', type: 'select', options: ['error', 'warning', 'info', 'verbose'] },
  { key: 'compression-threshold', label: 'Seuil de compression', type: 'number' },
  { key: 'compression-algorithm', label: 'Algorithme de compression', type: 'select', options: ['zlib', 'snappy', 'none'] },
  { key: 'server-authoritative-block-breaking', label: 'Casse de blocs autoritaire (serveur)', type: 'bool' },
  { key: 'disable-player-interaction', label: 'Désactiver les interactions entre joueurs', type: 'bool' },
  { key: 'chat-restriction', label: 'Restriction du chat', type: 'select', options: ['None', 'Dropped', 'Disabled'] },
  { key: 'client-side-chunk-generation-enabled', label: 'Génération de chunks côté client', type: 'bool' },
  { key: 'op-permission-level', label: 'Niveau de permission des OP', type: 'number' },
  { key: 'server-authoritative-movement', label: 'Mouvement autoritaire (serveur)', type: 'select', options: ['client-auth', 'server-auth', 'server-auth-with-rewind'] },
  { key: 'correct-player-movement', label: 'Correction du mouvement des joueurs', type: 'bool' },
  { key: 'server-authoritative-block-actions', label: 'Actions de blocs autoritaires (serveur)', type: 'bool' },
  { key: 'level-type', label: 'Type de monde', type: 'select', options: ['DEFAULT', 'FLAT', 'LEGACY'] },
  { key: 'emit-server-telemetry', label: 'Télémétrie serveur', type: 'bool' },
  { key: 'server-authoritative-block-breaking-pick-range-scalar', label: 'Portée de casse (scalaire)', type: 'text' },
];

function getPropertySchema(edition) {
  return normalizeEdition(edition) === 'bedrock' ? BEDROCK_PROPERTY_SCHEMA : JAVA_PROPERTY_SCHEMA;
}

// ── Lecture/écriture de server.properties sous forme clé/valeur ────
// parseProperties() ignore commentaires et lignes vides. serializeProperties()
// réécrit le fichier existant en ne touchant qu'aux lignes des clés modifiées
// (préserve commentaires/ordre/clés inconnues) et ajoute les clés absentes
// en fin de fichier.
function parseProperties(text) {
  const props = {};
  String(text || '').split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    props[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  });
  return props;
}

function serializeProperties(originalText, updates) {
  const lines = String(originalText || '').split('\n');
  const seen = new Set();
  const outLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return line;
    const key = trimmed.slice(0, idx);
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  const newKeys = Object.keys(updates).filter((k) => !seen.has(k));
  if (newKeys.length) {
    while (outLines.length && outLines[outLines.length - 1] === '') outLines.pop();
    newKeys.forEach((k) => outLines.push(`${k}=${updates[k]}`));
    outLines.push('');
  }
  return outLines.join('\n');
}

async function readServerProperties(dir) {
  const filePath = path.join(dir, 'server.properties');
  const text = await fsp.readFile(filePath, 'utf8').catch(() => '');
  return parseProperties(text);
}

async function writeServerProperties(dir, updates) {
  const filePath = path.join(dir, 'server.properties');
  const text = await fsp.readFile(filePath, 'utf8').catch(() => '');
  const updated = serializeProperties(text, updates || {});
  await fsp.writeFile(filePath, updated);
}

// ── MinecraftController : UN serveur Minecraft pour UN tenant ──────────
class MinecraftController extends EventEmitter {
  constructor(tenantId, store) {
    super();
    this.tenantId = tenantId;
    this.store = store;
    this.process = null;
    this.status = 'stopped'; // stopped | provisioning | starting | running | stopping | crashed
    this.logs = [];
    this.lastError = null;
    this.startedAt = null;
    this.edition = 'java'; // 'java' | 'bedrock' — mis à jour via provision()/start() ou à la création du controller (voir MinecraftManager.get)
  }

  get dir() {
    return tenantDir(this.tenantId);
  }

  get jarPath() {
    return path.join(this.dir, 'server.jar');
  }

  // Chemin de l'exécutable réellement lancé, selon l'édition courante :
  // le .jar Paper pour Java, le binaire officiel bedrock_server pour Bedrock.
  get binaryPath() {
    if (this.edition === 'bedrock') {
      return path.join(this.dir, process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server');
    }
    return this.jarPath;
  }

  _pushLog(line) {
    const stamped = `[${new Date().toLocaleTimeString('fr-FR')}] ${line}`;
    this.logs.push(stamped);
    if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
    this.emit('log', stamped);
  }

  getStatus() {
    return {
      status: this.status,
      lastError: this.lastError,
      startedAt: this.startedAt,
      edition: this.edition,
      hasJar: fs.existsSync(this.binaryPath),
    };
  }

  getLogs() {
    return [...this.logs];
  }

  // Télécharge le serveur (jar Paper ou binaire Bedrock officiel selon
  // `edition`) + prépare toute la config par défaut. N'écrase pas un
  // serveur déjà provisionné sauf si `reinstall` est explicitement
  // demandé (changement de version/édition).
  async provision({ mcVersion, port, edition } = {}) {
    if (this.process) throw new Error('Arrête le serveur avant de le reprovisionner.');
    this.edition = normalizeEdition(edition);
    this.status = 'provisioning';

    try {
      if (this.edition === 'bedrock') {
        this._pushLog('📦 Téléchargement du Bedrock Dedicated Server (build officiel Mojang)…');
        const { url, version } = await getBedrockServerDownload();
        const zipPath = path.join(this.dir, 'bedrock-server.zip');
        await downloadFile(url, zipPath, { 'User-Agent': BEDROCK_DOWNLOAD_USER_AGENT });
        await assertIsZip(zipPath);
        this._pushLog(`✅ Bedrock Dedicated Server ${version} téléchargé.`);

        await extractZip(zipPath, this.dir);
        if (process.platform !== 'win32') {
          await fsp.chmod(this.binaryPath, 0o755).catch(() => {});
        }
        this._pushLog('📦 Archive extraite (bedrock_server + librairies).');

        await writeDefaultConfigFilesBedrock(this.dir, { port });
        this._pushLog('📝 Fichiers de configuration par défaut générés (server.properties, allowlist.json, permissions.json).');
        this._pushLog('📂 Dossiers config/default (packs de comportement/ressources) et packs (archives .mcpack/.mcaddon) créés.');
      } else {
        this._pushLog(`📦 Téléchargement de Paper ${mcVersion}…`);
        const { url, name, build } = await getLatestStableDownload(mcVersion);
        await downloadFile(url, this.jarPath);
        this._pushLog(`✅ ${name} (build ${build}) téléchargé.`);

        await writeDefaultConfigFiles(this.dir, { port });
        this._pushLog('📝 Fichiers de configuration par défaut générés (server.properties, eula.txt, whitelist.json, ops.json, banned-players.json, banned-ips.json, usercache.json).');
        this._pushLog('ℹ️ bukkit.yml, spigot.yml et config/paper-global.yml seront générés automatiquement par le serveur Paper au premier démarrage.');
      }

      this.status = 'stopped';
      this.lastError = null;
      return true;
    } catch (err) {
      this.status = 'crashed';
      this.lastError = err.message;
      this._pushLog(`❌ Échec du provisioning : ${err.message}`);
      throw err;
    }
  }

  // Met à jour un serveur déjà installé vers la dernière version
  // disponible : dernier build stable Paper pour la version demandée (ou
  // la toute dernière version Minecraft si aucune n'est précisée) côté
  // Java, dernier Bedrock Dedicated Server officiel côté Bedrock (il n'y a
  // qu'une seule version possible, comme à l'installation). Contrairement
  // à provision(), le monde, la config (server.properties, allowlist/ops,
  // whitelist, packs déjà installés…) ne sont jamais touchés — seuls les
  // fichiers du "moteur" (jar/binaire + libs + packs vanilla) sont
  // remplacés par leur toute dernière version.
  async update({ mcVersion } = {}) {
    if (this.process) throw new Error('Arrête le serveur avant de le mettre à jour.');
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error("Aucun serveur installé pour ce tenant — installe-le d'abord.");
    }
    this.status = 'updating';

    try {
      let installedVersion;

      if (this.edition === 'bedrock') {
        this._pushLog('🔄 Recherche de la dernière version du Bedrock Dedicated Server…');
        const { url, version } = await getBedrockServerDownload();
        installedVersion = version;
        const zipPath = path.join(this.dir, `bedrock-server-update-${Date.now()}.zip`);
        await downloadFile(url, zipPath, { 'User-Agent': BEDROCK_DOWNLOAD_USER_AGENT });
        await assertIsZip(zipPath);
        this._pushLog(`✅ Bedrock Dedicated Server ${version} téléchargé.`);

        const tmpDir = path.join(this.dir, `.update-tmp-${Date.now()}`);
        await extractZip(zipPath, tmpDir);
        this._pushLog('📦 Archive extraite — copie des fichiers du serveur (le monde, server.properties et les packs déjà installés sont conservés)…');
        await copyFreshFilesPreserving(tmpDir, this.dir, PRESERVE_ON_UPDATE);
        await fsp.rm(tmpDir, { recursive: true, force: true });
        if (process.platform !== 'win32') {
          await fsp.chmod(this.binaryPath, 0o755).catch(() => {});
        }
        this._pushLog(`🎉 Mise à jour terminée — Bedrock Dedicated Server ${version} installé.`);
      } else {
        const targetVersion = mcVersion || (await listAvailableVersions())[0];
        if (!targetVersion) throw new Error('Impossible de déterminer la dernière version Minecraft disponible.');
        installedVersion = targetVersion;

        this._pushLog(`🔄 Téléchargement de Paper ${targetVersion} (dernier build stable)…`);
        const { url, name, build } = await getLatestStableDownload(targetVersion);
        const tmpJarPath = path.join(this.dir, `server.jar.update-${Date.now()}`);
        await downloadFile(url, tmpJarPath);
        await fsp.rename(tmpJarPath, this.jarPath);
        this._pushLog(`🎉 Mise à jour terminée — ${name} (build ${build}) installé. Le monde et la config sont conservés.`);
      }

      this.status = 'stopped';
      this.lastError = null;
      return { version: installedVersion };
    } catch (err) {
      this.status = 'crashed';
      this.lastError = err.message;
      this._pushLog(`❌ Échec de la mise à jour : ${err.message}`);
      throw err;
    }
  }

  async start({ memoryMb, edition } = {}) {
    if (this.process) return this.getStatus();
    if (edition) this.edition = normalizeEdition(edition);
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error("Aucun serveur installé pour ce tenant — lance d'abord la création.");
    }

    this.status = 'starting';

    let child;
    if (this.edition === 'bedrock') {
      this._pushLog('🚀 Démarrage du serveur Bedrock…');
      child = spawn(this.binaryPath, [], {
        cwd: this.dir,
        env: { ...process.env, LD_LIBRARY_PATH: '.' },
      });
    } else {
      const mem = Math.max(512, Number(memoryMb) || 1024);
      this._pushLog(`🚀 Démarrage du serveur (${mem} Mo alloués)…`);
      child = spawn(
        JAVA_BIN,
        [`-Xms${Math.min(mem, 512)}M`, `-Xmx${mem}M`, '-jar', 'server.jar', 'nogui'],
        { cwd: this.dir }
      );
    }
    this.process = child;
    this.startedAt = Date.now();

    const readyPattern = this.edition === 'bedrock' ? /Server started\./i : /Done \(/i;
    child.stdout.on('data', (buf) => {
      String(buf).split('\n').filter(Boolean).forEach((l) => this._pushLog(l));
      if (this.status === 'starting' && readyPattern.test(String(buf))) {
        this.status = 'running';
        this.emit('statusChanged', this.getStatus());
        this._announceConnectionInfo();
        this._openUpnpPort();
      }
      this._checkPlayerJoin(String(buf));
      this._logPlayerActivity(String(buf));
    });
    child.stderr.on('data', (buf) => {
      String(buf).split('\n').filter(Boolean).forEach((l) => this._pushLog(`⚠️ ${l}`));
    });
    child.on('exit', (code) => {
      this._pushLog(`⏹️ Processus terminé (code ${code}).`);
      this.status = code === 0 || this.status === 'stopping' ? 'stopped' : 'crashed';
      processStats.forgetProcess(child.pid);
      this.process = null;
      this.startedAt = null;
      this.emit('statusChanged', this.getStatus());
    });
    child.on('error', (err) => {
      this.lastError = err.message;
      const hint = this.edition === 'bedrock'
        ? "Vérifie que bedrock_server a bien les droits d'exécution."
        : 'Vérifie que Java est installé et accessible (JAVA_BIN).';
      this._pushLog(`❌ Impossible de lancer le serveur : ${err.message}. ${hint}`);
      this.status = 'crashed';
      this.process = null;
    });

    return this.getStatus();
  }

  // ── Admins : pseudos qui reçoivent la permission Operator/OP dès leur
  // connexion — ils peuvent ensuite changer eux-mêmes de mode de jeu en
  // jeu (menu ou commande /gamemode). Les autres joueurs sont dé-opés à
  // chaque connexion pour rester limités au mode par défaut du serveur.
  // Détecté en parsant les logs (pas besoin de RCON), commande renvoyée
  // via stdin après un petit délai pour laisser le joueur finir de charger.
  //
  // IMPORTANT (Bedrock) : `Player connected:` marque juste la poignée de
  // main réseau — le joueur n'existe pas encore comme entité dans le monde
  // à ce moment-là. `op`/`deop` ciblent un sélecteur de joueur, qui ne
  // matche qu'une fois le joueur réellement chargé, ce qui n'arrive qu'à
  // la ligne `Player Spawned:` (typiquement ~2s plus tard). Se baser sur
  // `Player connected:` donnait donc systématiquement "No targets matched
  // selector" — la commande partait avant que la cible existe. On se base
  // désormais sur `Player Spawned:` pour Bedrock.
  _checkPlayerJoin(chunk) {
    // Format observé : "Player Spawned: Nom xuid: 123..." (pas de virgule
    // avant "xuid" contrairement à "Player connected: Nom, xuid: 123...")
    // — la virgule est donc optionnelle dans le regex.
    const bedrockMatch = chunk.match(/Player Spawned:\s*([^,]+?)\s*,?\s*xuid:/i);
    const javaMatch = chunk.match(/(\S+) joined the game/i);
    const name = (bedrockMatch?.[1] || javaMatch?.[1] || '').trim();
    if (!name) return;

    const admins = this.store?.getMinecraft?.().admins || [];
    const isAdmin = admins.some((a) => String(a).trim().toLowerCase() === name.toLowerCase());

    // Le joueur est déjà chargé dans le monde à ce stade (on se base sur
    // Player Spawned), donc plus besoin d'attendre longtemps — juste une
    // petite marge de sécurité contre un éventuel décalage de log.
    setTimeout(() => {
      try {
        // `permission add/remove operator` N'EXISTE PAS côté Bedrock : la
        // seule sous-commande console documentée par Mojang est `permission
        // <list|set|reload>` (voir learn.microsoft.com/.../commands/permission).
        // Le serveur répondait "Unknown command" en silence, donc aucun admin
        // Xbox n'était jamais réellement opé malgré une détection du pseudo
        // qui fonctionnait très bien. `op`/`deop` sont supportés tels quels
        // sur Bedrock (mêmes noms qu'en Java) — on les utilise pour les deux
        // éditions. Les gamertags Xbox pouvant contenir des espaces, on ne
        // quote le nom que quand c'est nécessaire.
        const target = /\s/.test(name) ? `"${name}"` : name;
        this.sendCommand(`${isAdmin ? 'op' : 'deop'} ${target}`);
        this._pushLog(`🔑 ${name} → ${isAdmin ? 'admin (peut changer de mode de jeu)' : 'joueur (mode par défaut)'}.`);
      } catch {
        // Le process a pu s'arrêter entre-temps — pas bloquant.
      }
    }, 300);
  }

  // ── Logs des joueurs (onglet "Logs du serveur") : parse chaque ligne du
  // flux stdout à la recherche d'événements liés à un joueur (connexion,
  // déconnexion, chat, mort, commande) et les persiste pour la recherche.
  //
  // Couverture par édition :
  // - Java (Paper) loggue tout nativement en console : les 5 types
  //   d'événements sont détectés directement depuis les logs.
  // - Bedrock : le binaire officiel ne loggue en console QUE les
  //   connexions/déconnexions (limitation du binaire Mojang, pas de ce
  //   parseur). Le chat et les morts deviennent détectables via des
  //   lignes `[VHOST-LOG] TYPE|...` émises par le behavior pack "VHOST
  //   Logger" (API de script officielle, qui tourne dans le moteur du
  //   jeu et peut donc "voir" ces événements — voir scripts/main.js du
  //   pack). Les commandes joueur restent indisponibles sur Bedrock quelle
  //   que soit la méthode : l'API de script Mojang n'expose aucun hook
  //   pour les intercepter, contrairement à Bukkit/Paper côté Java.
  _logPlayerActivity(chunk) {
    const lines = chunk.split('\n').filter(Boolean);
    for (const line of lines) {
      // Événements émis par le behavior pack "VHOST Logger" (Bedrock
      // uniquement — chat et morts, voir plus haut).
      const vhostLog = line.match(/\[VHOST-LOG\]\s*(CHAT|DEATH)\|([^|]+)\|(.*)$/);
      if (vhostLog) {
        const [, type, player, detail] = vhostLog;
        playerLog.logEvent(this.tenantId, {
          playerName: player.trim(),
          eventType: type.toLowerCase(),
          detail: detail.trim(),
        });
        continue;
      }

      // Connexion
      const joinBedrock = line.match(/Player Spawned:\s*([^,]+?)\s*,?\s*xuid:/i);
      const joinJava = line.match(/(\S+) joined the game/i);
      if (joinBedrock || joinJava) {
        playerLog.logEvent(this.tenantId, { playerName: (joinBedrock?.[1] || joinJava?.[1]).trim(), eventType: 'join' });
        continue;
      }

      // Déconnexion
      const leaveBedrock = line.match(/Player disconnected:\s*([^,]+?)\s*,?\s*xuid:/i);
      const leaveJava = line.match(/(\S+) left the game/i);
      if (leaveBedrock || leaveJava) {
        playerLog.logEvent(this.tenantId, { playerName: (leaveBedrock?.[1] || leaveJava?.[1]).trim(), eventType: 'leave' });
        continue;
      }

      // Commande jouée en jeu (Paper/Bukkit : "<Nom> issued server command: /...")
      const commandMatch = line.match(/(\S+) issued server command:\s*(\/.+)$/i);
      if (commandMatch) {
        playerLog.logEvent(this.tenantId, { playerName: commandMatch[1].trim(), eventType: 'command', detail: commandMatch[2].trim() });
        continue;
      }

      // Chat (Java uniquement : "<Nom> message")
      const chatMatch = line.match(/[:\]]\s*<(\S+)>\s*(.+)$/);
      if (chatMatch) {
        playerLog.logEvent(this.tenantId, { playerName: chatMatch[1].trim(), eventType: 'chat', detail: chatMatch[2].trim() });
        continue;
      }

      // Mort (Java : couvre les formulations les plus courantes des messages
      // de mort vanilla — pas forcément 100% exhaustif, Mojang en ajoute
      // régulièrement de nouvelles avec les mises à jour).
      const deathMatch = line.match(
        /INFO\]:\s*(\S+)\s+(?:was\s|died|drowned|blew up|hit the ground|fell\s|starved|burned|went up in flames|suffocated|withered away|froze|was squashed|experienced kinetic energy|was pricked|was killed|discovered floor was lava)/i
      );
      if (deathMatch) {
        playerLog.logEvent(this.tenantId, { playerName: deathMatch[1].trim(), eventType: 'death', detail: line.replace(/^.*INFO\]:\s*/i, '').trim() });
      }
    }
  }

  async _announceConnectionInfo() {
    try {
      const defaultPort = this.edition === 'bedrock' ? 19132 : 25565;
      const port = this.store?.getMinecraft?.().port || defaultPort;
      const info = await getConnectionInfo(port);
      const parts = [`🌐 Serveur en ligne — adresse de connexion : ${info.address}`];
      if (info.localIp && info.localIp !== info.publicIp) parts.push(`(réseau local : ${info.localIp}:${info.port})`);
      this._pushLog(parts.join(' '));
    } catch {
      // Pas bloquant : l'IP publique peut être indisponible (pas d'accès
      // internet sortant), le serveur tourne quand même normalement.
    }
  }

  // ── Redirection de port automatique (UPnP) ─────────────────────────
  // Best-effort : si la box ne supporte pas l'UPnP ou si la fonction
  // est désactivée, on log juste une info et le serveur continue de
  // tourner normalement (redirection manuelle possible en secours).
  get _upnpPort() {
    const defaultPort = this.edition === 'bedrock' ? 19132 : 25565;
    return Number(this.store?.getMinecraft?.().port) || defaultPort;
  }

  async _openUpnpPort() {
    const protocol = this.edition === 'bedrock' ? 'UDP' : 'TCP';
    const port = this._upnpPort;
    const result = await upnp.openPort(port, { protocol, description: 'Minecraft Server' });
    if (result.success) {
      this._pushLog(`📡 Port ${port}/${protocol} redirigé automatiquement via UPnP.`);
    } else {
      this._pushLog(`ℹ️ Redirection UPnP indisponible (${result.error}) — redirige le port ${port}/${protocol} manuellement sur ta box si besoin.`);
    }
  }

  async _closeUpnpPort() {
    const protocol = this.edition === 'bedrock' ? 'UDP' : 'TCP';
    const port = this._upnpPort;
    await upnp.closePort(port, { protocol }).catch(() => {});
  }

  async stop() {
    if (!this.process) return this.getStatus();
    this.status = 'stopping';
    this._pushLog('🛑 Arrêt demandé (commande "stop" envoyée)…');
    this._closeUpnpPort();
    this.process.stdin.write('stop\n');
    // Filet de sécurité : si le process ne répond pas dans les 20s, on le tue.
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) this.process.kill('SIGKILL');
        resolve();
      }, 20000);
      this.once('statusChanged', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return this.getStatus();
  }

  sendCommand(command) {
    if (!this.process) throw new Error("Le serveur n'est pas démarré.");
    this.process.stdin.write(`${command}\n`);
    this._pushLog(`> ${command}`);
  }

  async wipe() {
    if (this.process) throw new Error('Arrête le serveur avant de le supprimer.');
    await fsp.rm(this.dir, { recursive: true, force: true });
    this.logs = [];
    this.status = 'stopped';
  }
}

class MinecraftManager {
  constructor() {
    this._controllers = new Map();
  }

  get(tenantId, store) {
    if (!this._controllers.has(tenantId)) {
      const controller = new MinecraftController(tenantId, store);
      // Le controller est recréé "à froid" (redémarrage du dashboard) sans
      // repasser par provision() : on relit l'édition choisie dans les
      // settings persistés pour que hasJar/start pointent le bon binaire.
      const savedEdition = store?.getMinecraft?.()?.edition;
      if (savedEdition) controller.edition = normalizeEdition(savedEdition);
      this._controllers.set(tenantId, controller);
    }
    return this._controllers.get(tenantId);
  }

  has(tenantId) {
    return this._controllers.has(tenantId);
  }

  async stopAll() {
    await Promise.all([...this._controllers.values()].map((c) => c.stop().catch(() => {})));
  }
}

module.exports = new MinecraftManager();
module.exports.listAvailableVersions = listAvailableVersions;
module.exports.tenantDir = tenantDir;
module.exports.getConnectionInfo = getConnectionInfo;
module.exports.normalizeEdition = normalizeEdition;
module.exports.getPropertySchema = getPropertySchema;
module.exports.readServerProperties = readServerProperties;
module.exports.writeServerProperties = writeServerProperties;
module.exports.installPack = installPack;