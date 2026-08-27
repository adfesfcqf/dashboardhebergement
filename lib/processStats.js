// ── Statistiques CPU/RAM réelles (hôte + process) ────────────────────
// Aucune dépendance externe : lecture de /proc/<pid>/{stat,status} côté
// Linux (l'environnement de prod visé) pour les process enfants (ex: le
// serveur Minecraft), et des API natives Node (process.cpuUsage(),
// process.memoryUsage()) pour le process du dashboard lui-même — qui
// héberge aussi le bot Discord en in-process (pas de PID séparé).
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

let clkTck = 100; // valeur standard Linux, recalée si possible ci-dessous
try {
  if (process.platform === 'linux') {
    clkTck = parseInt(execSync('getconf CLK_TCK').toString().trim(), 10) || 100;
  }
} catch {
  // getconf indisponible (conteneur minimal, autre OS…) — on garde 100.
}

// pid -> { totalTimeJiffies, at } : dernier échantillon, pour calculer un
// delta de CPU comme le fait "top" (temps CPU consommé / temps réel écoulé).
const prevSamples = new Map();
let prevSelf = null;

function readProcTotalJiffies(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  // Le nom de commande (2e champ) est entre parenthèses et peut contenir
  // des espaces/parenthèses — on repart après la dernière ')'.
  const afterParen = raw.slice(raw.lastIndexOf(')') + 2).trim();
  const fields = afterParen.split(/\s+/);
  // À partir d'ici, fields[0] = état (3e champ d'origine), utime = index 11,
  // stime = index 12 (cf. man proc, section /proc/[pid]/stat).
  const utime = parseInt(fields[11], 10) || 0;
  const stime = parseInt(fields[12], 10) || 0;
  return utime + stime;
}

function readProcRssMb(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = raw.match(/VmRSS:\s+(\d+)\s+kB/);
  return match ? Math.round(parseInt(match[1], 10) / 1024) : null;
}

// Échantillonne un PID Linux quelconque (ex: le process du serveur
// Minecraft lancé via child_process.spawn). Renvoie null si indisponible
// (process mort, plateforme non-Linux, permissions insuffisantes) — dans
// ce cas on retire aussi l'échantillon précédent pour ce PID.
function sampleChildProcess(pid) {
  if (!pid || process.platform !== 'linux') return null;
  try {
    const totalTimeJiffies = readProcTotalJiffies(pid);
    const memMb = readProcRssMb(pid);
    const now = Date.now();
    const prev = prevSamples.get(pid);
    prevSamples.set(pid, { totalTimeJiffies, at: now });
    if (!prev) return { cpuPercent: 0, memMb };
    const elapsedSec = (now - prev.at) / 1000;
    if (elapsedSec <= 0) return { cpuPercent: 0, memMb };
    const deltaJiffies = Math.max(0, totalTimeJiffies - prev.totalTimeJiffies);
    const cpuPercent = (deltaJiffies / clkTck / elapsedSec) * 100;
    return { cpuPercent: Math.round(cpuPercent * 10) / 10, memMb };
  } catch {
    prevSamples.delete(pid);
    return null;
  }
}

// Nettoie l'échantillon gardé en mémoire pour un PID qui vient de se
// terminer, pour ne pas fausser le prochain calcul de delta s'il est réutilisé.
function forgetProcess(pid) {
  if (pid) prevSamples.delete(pid);
}

// Échantillonne le process Node courant (dashboard + bot Discord en
// in-process) via les API natives — pas besoin de /proc, ça marche aussi
// hors Linux.
function sampleSelfProcess() {
  const usage = process.cpuUsage();
  const now = Date.now();
  const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (!prevSelf) {
    prevSelf = { usage, at: now };
    return { cpuPercent: 0, memMb };
  }
  const elapsedMicros = (now - prevSelf.at) * 1000;
  const deltaMicros = (usage.user - prevSelf.usage.user) + (usage.system - prevSelf.usage.system);
  prevSelf = { usage, at: now };
  const cpuPercent = elapsedMicros > 0 ? Math.max(0, (deltaMicros / elapsedMicros) * 100) : 0;
  return { cpuPercent: Math.round(cpuPercent * 10) / 10, memMb };
}

// Stats globales de l'hôte (RAM totale/utilisée, charge CPU approximative
// via la load average rapportée au nombre de coeurs — os.loadavg() renvoie
// [0,0,0] sur Windows, donc loadPercent sera 0 dans ce cas).
function hostStats() {
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const cpuCount = os.cpus().length || 1;
  const loadAvg = os.loadavg();
  const loadPercent = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100));
  return {
    totalMb,
    usedMb: totalMb - freeMb,
    cpuCount,
    loadAvg,
    loadPercent,
    uptimeSec: Math.round(os.uptime()),
  };
}

module.exports = { sampleChildProcess, sampleSelfProcess, hostStats, forgetProcess };