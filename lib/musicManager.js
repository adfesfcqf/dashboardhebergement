const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const minecraftManager = require('./minecraftManager');

// ── Playlist musicale (Configuration générale > Playlist musicale) ─────
// Permet à l'admin d'uploader des pistes (tous formats acceptés : .mp3,
// .wav, .mp4, .ogg, .flac, .m4a...) et de les faire "tourner" sur son
// serveur Minecraft pendant que celui-ci est en ligne.
//
// ⚠️ Limite technique honnête : Minecraft (Java comme Bedrock) ne sait
// pas streamer un fichier audio/vidéo arbitraire aux joueurs — le son
// en jeu passe forcément par la commande /playsound, qui ne peut jouer
// que des sons déjà connus du client (sons vanilla) ou fournis via un
// resource pack au format .ogg installé côté joueur. On ne peut donc
// pas "diffuser" un .wav ou .mp4 tel quel dans le jeu.
// Ce module gère malgré tout le cycle complet demandé (upload, ordre,
// lecture/pause) : la piste "jouée" est annoncée aux joueurs connectés
// (tellraw + playsound sur le son vanilla le plus proche en fallback)
// pendant que le fichier original reste stocké et téléchargeable pour
// être intégré à un resource pack plus tard si besoin.
const MUSIC_DIRNAME = 'music';

// Volontairement permissif — l'admin peut uploader ce qu'il veut, le
// tri "ça marchera nativement ou pas" se fait à la lecture, pas à l'upload.
const ALLOWED_EXTENSIONS = new Set([
  '.mp3', '.wav', '.wave', '.ogg', '.oga', '.flac', '.m4a', '.aac',
  '.wma', '.opus', '.mp4', '.m4v', '.mov', '.webm', '.mkv',
]);

const MAX_TRACK_BYTES = 60 * 1024 * 1024; // 60 Mo par piste

function musicDir(tenantId) {
  return path.join(minecraftManager.tenantDir(tenantId), MUSIC_DIRNAME);
}

function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'piste';
}

function isAllowedExt(ext) {
  return ALLOWED_EXTENSIONS.has(String(ext || '').toLowerCase());
}

// ── Stockage disque ──────────────────────────────────────────────────
async function saveTrack(tenantId, { name, base64 }) {
  const originalName = String(name || 'piste').trim();
  const ext = path.extname(originalName).toLowerCase();
  if (!isAllowedExt(ext)) {
    throw new Error(`Format non supporté (${ext || 'inconnu'}). Formats acceptés : ${[...ALLOWED_EXTENSIONS].join(', ')}.`);
  }
  const buffer = Buffer.from(String(base64 || ''), 'base64');
  if (!buffer.length) throw new Error('Fichier vide ou invalide.');
  if (buffer.length > MAX_TRACK_BYTES) {
    throw new Error(`Fichier trop volumineux (max ${Math.round(MAX_TRACK_BYTES / 1024 / 1024)} Mo).`);
  }

  const id = crypto.randomBytes(8).toString('hex');
  const filename = `${id}-${slugify(path.basename(originalName, ext))}${ext}`;
  const dir = musicDir(tenantId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, filename), buffer);

  return {
    id,
    name: originalName,
    filename,
    ext,
    sizeBytes: buffer.length,
    addedAt: Date.now(),
  };
}

async function deleteTrack(tenantId, filename) {
  if (!filename) return;
  const dir = musicDir(tenantId);
  const target = path.resolve(dir, filename);
  // Garde-fou anti path-traversal, même si `filename` vient toujours de
  // nos propres métadonnées (jamais tapé librement par le client).
  if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error('Chemin invalide.');
  await fsp.rm(target, { force: true });
}

function trackDownloadPath(tenantId, filename) {
  return path.join(musicDir(tenantId), filename);
}

// ── Diffusion en jeu ─────────────────────────────────────────────────
// Un runner par tenant : avance dans la playlist toutes les
// `trackDurationSec` secondes tant que le serveur Minecraft tourne,
// annonce la piste en cours (tellraw) et tente un /playsound. S'arrête
// tout seul si le serveur s'éteint ou si la playlist est désactivée.
const runners = new Map(); // tenantId -> { timer, index, config }

function stopVanillaMusic(controller) {
  if (!controller?.process) return;
  try {
    if (controller.edition === 'bedrock') {
      // Bedrock : `/music stop` coupe uniquement la musique d'ambiance
      // auto-générée par le client (celle qui se déclenche toute seule
      // selon le biome/l'humeur du joueur), sans toucher aux sons de jeu
      // (pas, mobs, blocs...) contrairement à /stopsound qui couperait tout.
      controller.sendCommand('music stop 0');
    } else {
      // Java : la catégorie "music" est la musique d'ambiance auto ; on
      // coupe aussi "record" au cas où un joueur aurait un jukebox en
      // cours. Le "master" utilisé pour notre propre son (voir
      // announceTrack) n'est volontairement pas touché ici.
      controller.sendCommand('stopsound @a music');
      controller.sendCommand('stopsound @a record');
    }
  } catch {
    // Le process a pu s'arrêter entre-temps — pas bloquant.
  }
}

function announceTrack(controller, track, volume) {
  if (!controller?.process) return;
  const label = (track.name || 'piste inconnue').replace(/"/g, "'");
  const vol = (Math.max(0, Math.min(100, Number(volume) || 100)) / 100).toFixed(2);
  // On coupe la musique d'ambiance vanilla juste avant de lancer notre
  // piste, pour éviter que les deux se superposent (cf. demande : "pas de
  // superposition avec les musiques par défaut de Minecraft"). Le client
  // Minecraft peut relancer sa propre musique de son côté entre deux
  // pistes de la playlist ; voir le "garde anti-superposition" périodique
  // dans startPlaylist() ci-dessous qui la recoupe régulièrement.
  stopVanillaMusic(controller);
  // Si la piste est en .ogg ET que le resource pack a été généré/installé,
  // on peut jouer le vrai son custom. Sinon, fallback sur un son vanilla
  // pour donner malgré tout un repère audio en jeu.
  const soundKey = track.ext === '.ogg' ? `custom.${track.id}` : 'minecraft:block.note_block.harp';
  try {
    controller.sendCommand(`tellraw @a {"text":"🎵 Lecture : ${label}","color":"aqua"}`);
    if (controller.edition === 'bedrock') {
      controller.sendCommand(`playsound ${soundKey} @a ~ ~ ~ ${vol} 1 1`);
    } else {
      controller.sendCommand(`playsound ${soundKey} master @a ~ ~ ~ ${vol} 1 1`);
    }
  } catch {
    // Le process a pu s'arrêter entre-temps — pas bloquant.
  }
}

function stopPlaylist(tenantId) {
  const runner = runners.get(tenantId);
  if (runner?.timer) clearInterval(runner.timer);
  if (runner?.antiOverlapTimer) clearInterval(runner.antiOverlapTimer);
  runners.delete(tenantId);
}

function isPlaying(tenantId) {
  return runners.has(tenantId);
}

function currentTrackId(tenantId) {
  const runner = runners.get(tenantId);
  if (!runner) return null;
  const track = runner.config.tracks[runner.index];
  return track ? track.id : null;
}

// `store` sert à relire la config à chaque tick (au cas où l'admin
// modifie volume/playlist pendant la lecture) sans redémarrer le runner.
function startPlaylist(tenantId, store, controller, { fromTrackId } = {}) {
  stopPlaylist(tenantId);

  const config = store.getMusicPlaylist();
  if (!config.tracks.length) throw new Error('La playlist est vide — ajoute au moins une piste.');
  if (!controller?.process || controller.status !== 'running') {
    throw new Error("Le serveur Minecraft n'est pas en ligne.");
  }

  let index = fromTrackId ? config.tracks.findIndex((t) => t.id === fromTrackId) : 0;
  if (index < 0) index = 0;

  const tick = () => {
    const freshConfig = store.getMusicPlaylist();
    if (!freshConfig.tracks.length || controller.status !== 'running') {
      stopPlaylist(tenantId);
      return;
    }
    if (index >= freshConfig.tracks.length) {
      if (!freshConfig.loop) {
        stopPlaylist(tenantId);
        return;
      }
      index = 0;
    }
    runners.get(tenantId).config = freshConfig;
    announceTrack(controller, freshConfig.tracks[index], freshConfig.volume);
    index += 1;
  };

  const intervalMs = Math.max(5, Number(config.trackDurationSec) || 180) * 1000;
  const timer = setInterval(tick, intervalMs);
  // Garde anti-superposition : le client Minecraft peut relancer sa propre
  // musique d'ambiance de lui-même entre deux pistes de la playlist (ce
  // n'est pas piloté par le serveur) — on la recoupe régulièrement plutôt
  // que seulement au moment où on lance une nouvelle piste.
  const antiOverlapTimer = setInterval(() => {
    if (controller.status === 'running') stopVanillaMusic(controller);
  }, 20000);
  runners.set(tenantId, { timer, antiOverlapTimer, index, config });
  tick(); // joue la première piste immédiatement plutôt que d'attendre un tick complet
  runners.get(tenantId).index = index; // tick() ci-dessus a déjà incrémenté

  return { playing: true, trackId: config.tracks[Math.max(0, index - 1)]?.id || null };
}

// ── Démarrage/arrêt automatique de la playlist ──────────────────────
// Branché sur l'événement 'statusChanged' du contrôleur Minecraft (voir
// dashboard/server.js) : dès que le serveur passe "running", on relance
// la playlist si elle est activée (config.enabled) ; dès qu'il s'arrête
// ou plante, on coupe le runner (il n'y a plus de process à qui envoyer
// des commandes de toute façon).
function autoStartIfEnabled(tenantId, store, controller) {
  try {
    const config = store.getMusicPlaylist();
    if (config.enabled && config.tracks.length && !isPlaying(tenantId)) {
      startPlaylist(tenantId, store, controller);
    }
  } catch {
    // Pas de piste, playlist mal configurée... pas bloquant pour le
    // démarrage du serveur lui-même.
  }
}

// ── Génération du resource pack (lecture audio réelle) ─────────────────
// Seules les pistes .ogg peuvent être lues nativement par Minecraft.
// Cette fonction construit un pack Bedrock (manifest + sound_definitions)
// à partir des pistes .ogg de la playlist, l'installe automatiquement
// dans le monde actif si le serveur est en Bedrock, et produit un
// .mcpack téléchargeable dans tous les cas (utile pour partage manuel /
// édition Java, qui nécessite un hébergement HTTP externe du pack).
const PACK_DIRNAME = 'custom_music';

async function buildResourcePack(tenantId, store, controller) {
  const config = store.getMusicPlaylist();
  const oggTracks = config.tracks.filter((t) => t.ext === '.ogg');
  if (!oggTracks.length) {
    throw new Error('Aucune piste au format .ogg — seul ce format est lisible nativement par Minecraft. Convertis tes fichiers en .ogg puis réessaie.');
  }

  // UUID stable entre deux générations, pour ne pas créer un nouveau
  // pack à chaque fois côté client/monde.
  let packUuid = config.packUuid;
  let moduleUuid = config.packModuleUuid;
  if (!packUuid || !moduleUuid) {
    packUuid = crypto.randomUUID();
    moduleUuid = crypto.randomUUID();
    store.setMusicPlaylist({ packUuid, packModuleUuid: moduleUuid });
  }

  const root = minecraftManager.tenantDir(tenantId);
  const packDir = path.join(root, 'resource_packs', PACK_DIRNAME);
  const soundsDir = path.join(packDir, 'sounds', 'custom');
  await fsp.rm(packDir, { recursive: true, force: true });
  await fsp.mkdir(soundsDir, { recursive: true });

  const manifest = {
    format_version: 2,
    header: {
      description: 'Playlist musicale générée depuis le dashboard',
      name: 'Playlist musicale',
      uuid: packUuid,
      version: [1, 0, 0],
      min_engine_version: [1, 16, 0],
    },
    modules: [
      {
        description: 'Sons custom de la playlist',
        type: 'resources',
        uuid: moduleUuid,
        version: [1, 0, 0],
      },
    ],
  };
  await fsp.writeFile(path.join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const soundDefinitions = { format_version: '1.14.0', sound_definitions: {} };
  const musicDirPath = musicDir(tenantId);
  for (const track of oggTracks) {
    const src = path.join(musicDirPath, track.filename);
    const dest = path.join(soundsDir, `${track.id}.ogg`);
    await fsp.copyFile(src, dest).catch(() => {}); // piste possiblement supprimée entre-temps
    soundDefinitions.sound_definitions[`custom.${track.id}`] = {
      category: 'record',
      sounds: [`sounds/custom/${track.id}`],
    };
  }
  await fsp.writeFile(path.join(packDir, 'sounds', 'sound_definitions.json'), JSON.stringify(soundDefinitions, null, 2));

  // .mcpack téléchargeable (zip du dossier du pack)
  const zip = new AdmZip();
  zip.addLocalFolder(packDir);
  const mcpackPath = path.join(root, 'resource_packs', `${PACK_DIRNAME}.mcpack`);
  zip.writeZip(mcpackPath);

  // Installation automatique dans le monde actif si le serveur Bedrock
  // tourne sur cette machine (fichiers locaux, pas besoin de téléchargement).
  let autoInstalled = false;
  if (controller?.edition === 'bedrock') {
    try {
      const props = await minecraftManager.readServerProperties(controller.dir);
      const levelName = props['level-name'] || 'world';
      const worldDir = path.join(controller.dir, 'worlds', levelName);
      await fsp.mkdir(worldDir, { recursive: true });
      const worldPacksFile = path.join(worldDir, 'world_resource_packs.json');
      let existing = [];
      try {
        existing = JSON.parse(await fsp.readFile(worldPacksFile, 'utf8'));
        if (!Array.isArray(existing)) existing = [];
      } catch {
        existing = [];
      }
      existing = existing.filter((p) => p.pack_id !== packUuid);
      existing.push({ pack_id: packUuid, version: [1, 0, 0] });
      await fsp.writeFile(worldPacksFile, JSON.stringify(existing, null, 2));
      autoInstalled = true;
    } catch {
      autoInstalled = false; // pas bloquant : le .mcpack reste téléchargeable manuellement
    }
  }

  return {
    trackCount: oggTracks.length,
    skippedCount: config.tracks.length - oggTracks.length,
    autoInstalled,
    downloadFilename: `${PACK_DIRNAME}.mcpack`,
  };
}

function resourcePackDownloadPath(tenantId) {
  return path.join(minecraftManager.tenantDir(tenantId), 'resource_packs', `${PACK_DIRNAME}.mcpack`);
}

module.exports = {
  musicDir,
  isAllowedExt,
  ALLOWED_EXTENSIONS: [...ALLOWED_EXTENSIONS],
  saveTrack,
  deleteTrack,
  trackDownloadPath,
  startPlaylist,
  stopPlaylist,
  isPlaying,
  currentTrackId,
  autoStartIfEnabled,
  buildResourcePack,
  resourcePackDownloadPath,
};