const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const minecraftManager = require('./minecraftManager');

// ── Racine des fichiers "libres" du bot Discord d'un tenant (images
// d'embeds, exports, etc.) — séparée du serveur Minecraft. ──────────────
const BOT_FILES_DIR = process.env.BOT_FILES_DIR || path.join(__dirname, '..', 'data', 'bot-files');

// Extensions qu'on autorise à ouvrir/éditer comme texte dans le dashboard.
// Le reste (jars, mondes, images...) reste listable/téléchargeable mais
// pas éditable en ligne — pas d'intérêt et ça évite d'afficher du binaire.
const TEXT_EXTENSIONS = new Set([
  '.txt', '.properties', '.yml', '.yaml', '.json', '.json5', '.cfg', '.conf',
  '.toml', '.log', '.md', '.env', '.js', '.mcfunction',
]);

function rootForService(tenantId, service) {
  return service === 'minecraft'
    ? minecraftManager.tenantDir(tenantId)
    : path.join(BOT_FILES_DIR, String(tenantId));
}

// Résout un chemin relatif demandé par le client contre la racine du
// tenant, et REFUSE toute tentative de sortie du bac à sable (../, liens
// symboliques pointant ailleurs, chemins absolus...). C'est la seule
// fonction qui doit toucher à un chemin fourni par l'utilisateur.
function safeResolve(root, relPath) {
  const cleaned = String(relPath || '').replace(/\\/g, '/');
  const resolved = path.resolve(root, `.${path.sep}${cleaned}`);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error('Chemin invalide.');
  }
  return resolved;
}

async function ensureRoot(root) {
  await fsp.mkdir(root, { recursive: true });
}

async function list(root, relPath = '') {
  await ensureRoot(root);
  const dirPath = safeResolve(root, relPath);
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dirPath, entry.name);
      const stat = await fsp.stat(full).catch(() => null);
      return {
        name: entry.name,
        isDir: entry.isDirectory(),
        size: stat ? stat.size : 0,
        editable: !entry.isDirectory() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
        modifiedAt: stat ? stat.mtimeMs : null,
      };
    })
  );
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return items;
}

const MAX_READABLE_BYTES = 2 * 1024 * 1024; // 2 Mo — au-delà, on refuse l'édition en ligne

async function readFile(root, relPath) {
  const filePath = safeResolve(root, relPath);
  const stat = await fsp.stat(filePath);
  if (stat.isDirectory()) throw new Error('Ceci est un dossier.');
  if (stat.size > MAX_READABLE_BYTES) throw new Error('Fichier trop volumineux pour être édité en ligne (> 2 Mo).');
  return fsp.readFile(filePath, 'utf8');
}

async function writeFile(root, relPath, content) {
  const filePath = safeResolve(root, relPath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

async function writeBinaryBase64(root, relPath, base64Content) {
  const filePath = safeResolve(root, relPath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, Buffer.from(base64Content, 'base64'));
}

async function mkdir(root, relPath) {
  const dirPath = safeResolve(root, relPath);
  await fsp.mkdir(dirPath, { recursive: true });
}

async function remove(root, relPath) {
  const target = safeResolve(root, relPath);
  if (target === root) throw new Error('Impossible de supprimer la racine.');
  await fsp.rm(target, { recursive: true, force: true });
}

async function rename(root, fromRel, toRel) {
  const from = safeResolve(root, fromRel);
  const to = safeResolve(root, toRel);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

module.exports = { rootForService, list, readFile, writeFile, writeBinaryBase64, mkdir, remove, rename, TEXT_EXTENSIONS };
