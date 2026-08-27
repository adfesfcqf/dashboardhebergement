'use strict';

// ── Client UPnP IGD minimal (sans dépendance externe) ───────────────────
// Permet d'ouvrir/fermer automatiquement le port du serveur Minecraft sur
// la box internet (redirection de port) via le protocole UPnP
// Internet Gateway Device, quand la box le supporte et l'a d'activé.
//
// Tout est "best-effort" : en cas d'échec (pas de box compatible, UPnP
// désactivé, timeout réseau, etc.) les fonctions ne lancent jamais
// d'exception bloquante — elles renvoient { success: false, error }.
// Le fonctionnement du serveur Minecraft ne dépend donc jamais de l'UPnP ;
// au pire, le joueur devra rediriger le port manuellement (cf. commentaire
// dans minecraftManager.js).

const dgram = require('dgram');
const http = require('http');
const { URL } = require('url');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const DISCOVER_TIMEOUT_MS = 3000;
const HTTP_TIMEOUT_MS = 4000;

// Types de service IGD couramment exposés par les box grand public.
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

function httpGet(url, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout HTTP UPnP')));
  });
}

function httpPost(url, body, headers, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout HTTP UPnP')));
    req.write(body);
    req.end();
  });
}

// Découverte SSDP : diffuse un M-SEARCH sur le réseau local et récupère
// l'URL de description du premier routeur/box qui répond.
function discoverGatewayLocation() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* déjà fermé */ }
      if (err) reject(err); else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error('Aucune box UPnP détectée sur le réseau (timeout).')), DISCOVER_TIMEOUT_MS);

    socket.on('error', (err) => { clearTimeout(timer); finish(err); });

    socket.on('message', (msg) => {
      const text = msg.toString();
      const match = text.match(/LOCATION:\s*(.+)\r?\n/i);
      if (match) {
        clearTimeout(timer);
        finish(null, match[1].trim());
      }
    });

    socket.bind(() => {
      const query = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n' +
        '\r\n'
      );
      socket.send(query, 0, query.length, SSDP_PORT, SSDP_ADDR, (err) => {
        if (err) { clearTimeout(timer); finish(err); }
      });
    });
  });
}

// Récupère et parse (grossièrement, via regex) la description XML du
// device pour trouver le controlURL du service WANIPConnection/WANPPP.
async function getControlInfo(locationUrl) {
  const xml = await httpGet(locationUrl);
  const base = new URL(locationUrl);

  for (const serviceType of SERVICE_TYPES) {
    const escaped = serviceType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const serviceBlockRegex = new RegExp(
      `<service>\\s*<serviceType>${escaped}</serviceType>[\\s\\S]*?<controlURL>(.*?)</controlURL>[\\s\\S]*?</service>`,
      'i'
    );
    const match = xml.match(serviceBlockRegex);
    if (match) {
      const controlPath = match[1].trim();
      const controlUrl = controlPath.startsWith('http')
        ? controlPath
        : `${base.protocol}//${base.host}${controlPath.startsWith('/') ? '' : '/'}${controlPath}`;
      return { controlUrl, serviceType };
    }
  }
  throw new Error("Aucun service WANIPConnection/WANPPPConnection trouvé sur cette box (UPnP probablement désactivé).");
}

async function findGateway() {
  const location = await discoverGatewayLocation();
  return getControlInfo(location);
}

function soapEnvelope(serviceType, action, args) {
  const params = Object.entries(args)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('');
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action} xmlns:u="${serviceType}">${params}</u:${action}>` +
    '</s:Body></s:Envelope>'
  );
}

async function soapCall(controlUrl, serviceType, action, args) {
  const body = soapEnvelope(serviceType, action, args);
  const res = await httpPost(controlUrl, body, {
    'Content-Type': 'text/xml; charset="utf-8"',
    SOAPAction: `"${serviceType}#${action}"`,
  });
  if (res.statusCode >= 300) {
    throw new Error(`La box a refusé la requête UPnP (HTTP ${res.statusCode}).`);
  }
  return res.body;
}

// ── API publique ─────────────────────────────────────────────────────

// Ouvre/redirige un port sur la box (ex: le port du serveur Minecraft).
// protocol: 'TCP' (Java) ou 'UDP' (Bedrock). Renvoie toujours un objet,
// ne rejette jamais — best-effort uniquement.
async function openPort(port, { protocol = 'TCP', description = 'Minecraft Server', ttlSeconds = 0 } = {}) {
  try {
    const { controlUrl, serviceType } = await findGateway();
    const localIp = require('os').networkInterfaces
      ? Object.values(require('os').networkInterfaces())
        .flat()
        .find((i) => i.family === 'IPv4' && !i.internal)?.address
      : null;

    await soapCall(controlUrl, serviceType, 'AddPortMapping', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: protocol.toUpperCase(),
      NewInternalPort: port,
      NewInternalClient: localIp || '',
      NewEnabled: 1,
      NewPortMappingDescription: description,
      NewLeaseDuration: ttlSeconds,
    });

    return { success: true, port, protocol: protocol.toUpperCase() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Ferme/retire la redirection de port ouverte par openPort().
async function closePort(port, { protocol = 'TCP' } = {}) {
  try {
    const { controlUrl, serviceType } = await findGateway();

    await soapCall(controlUrl, serviceType, 'DeletePortMapping', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: protocol.toUpperCase(),
    });

    return { success: true, port, protocol: protocol.toUpperCase() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { openPort, closePort, findGateway };
