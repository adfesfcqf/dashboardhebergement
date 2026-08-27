const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

const { globalStore, tenantManager, TenantStore } = require('../lib/store');
const botManager = require('../lib/botManager');
const minecraftManager = require('../lib/minecraftManager');
const { getLeaderboard: getDayzLeaderboard } = require('../lib/dayzManager');
const nitradoApi = require('../lib/nitradoApi');
const fileManager = require('../lib/fileManager');
const { pool: db } = require('../lib/db');
const { isValidEmoji } = require('../lib/config');
const customerCodes = require('../lib/customerCodes');
const { fetchServerStatus } = require('../lib/cfxApi');
const { hashPassword, verifyPassword, validateUsername, validatePassword } = require('../lib/auth');
const auditLog = require('../lib/auditLog');
const processStats = require('../lib/processStats');

const VIEWS_DIR = __dirname;
const DISCORD_API = 'https://discord.com/api/v10';

const sessionStore = new MySQLStore({}, db);

function readView(name) {
  return fs.readFileSync(path.join(VIEWS_DIR, 'public', name), 'utf8');
}

// ── Auth : vérifie juste qu'on a une session Discord + un tenantId ──
function requireAuth(req, res, next) {
  if (req.session && req.session.discordUser && req.session.tenantId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

// ── Résout le TenantStore + le BotController DU TENANT DE LA SESSION ──
async function resolveTenant(req, res, next) {
  try {
    const tenantId = req.session.tenantId;
    if (!tenantId) return res.status(401).json({ error: 'unauthorized' });

    const store = await tenantManager.getStore(tenantId);
    if (!store.isAdmin(req.session.discordUser.id)) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'unauthorized' });
    }

    req.tenantStore = store;
    req.tenantId = tenantId;
    req.adminRole = store.getAdminRole(req.session.discordUser.id);
    req.tenantService = await tenantManager.getService(tenantId);
    if (req.tenantService === 'minecraft') {
      req.minecraft = minecraftManager.get(tenantId, store);
    } else {
      req.bot = botManager.get(tenantId, store);
    }
    next();
  } catch (err) {
    console.error('Erreur resolveTenant:', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
}

// ── Contrôle d'accès par rôle ──
function requireRole(...allowed) {
  return (req, res, next) => {
    if (allowed.includes(req.adminRole)) return next();
    return res.status(403).json({ error: 'Accès refusé pour ton rôle.' });
  };
}

async function readTickets(tenantId) {
  try {
    const [rows] = await db.query('SELECT data FROM tickets WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
    return rows.map((r) => JSON.parse(r.data));
  } catch (err) {
    console.error('Erreur lecture tickets MySQL:', err.message);
    return [];
  }
}

async function computeStats(tenantId) {
  const tickets = await readTickets(tenantId);
  const total = tickets.length;
  const open = tickets.filter((t) => t.status === 'open').length;
  const closed = tickets.filter((t) => t.status === 'closed').length;

  const byType = {};
  for (const t of tickets) {
    byType[t.typeId] = (byType[t.typeId] || 0) + 1;
  }

  const closedWithDuration = tickets.filter((t) => t.status === 'closed' && t.createdAt && t.closedAt);
  const avgResolutionMs = closedWithDuration.length
    ? closedWithDuration.reduce((sum, t) => sum + (t.closedAt - t.createdAt), 0) / closedWithDuration.length
    : null;

  const claimedCount = tickets.filter((t) => t.claimedBy).length;
  const unclaimedOpen = tickets.filter((t) => t.status === 'open' && !t.claimedBy).length;

  const recent = [...tickets]
    .sort((a, b) => (b.closedAt || b.createdAt || 0) - (a.closedAt || a.createdAt || 0))
    .slice(0, 8)
    .map((t) => ({
      id: t.id,
      userTag: t.userTag,
      typeId: t.typeId,
      status: t.status,
      createdAt: t.createdAt,
      closedAt: t.closedAt || null,
      claimedByTag: t.claimedByTag || null,
    }));

  return { total, open, closed, byType, avgResolutionMs, claimedCount, unclaimedOpen, recent };
}

function toCsv(tickets) {
  const headers = ['id', 'userTag', 'userId', 'typeId', 'status', 'claimedByTag', 'createdAt', 'closedAt', 'closedBy'];
  const rows = tickets.map((t) =>
    headers
      .map((h) => {
        const v = t[h] ?? '';
        const s = String(v).replace(/"/g, '""');
        return `"${s}"`;
      })
      .join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

function mapTicketMessage(m) {
  const time = m.createdAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  if (!m.author.bot) {
    return { sender: m.author.username, text: m.content, time, from: 'staff' };
  }

  if (m.content.startsWith('**[Dashboard]')) {
    const match = m.content.match(/^\*\*\[Dashboard\]\s*(.+?)\s*:\*\*\s*([\s\S]*)$/);
    return {
      sender: match ? `Staff (Dashboard) · ${match[1]}` : 'Staff (Dashboard)',
      text: match ? match[2] : m.content,
      time,
      from: 'staff',
    };
  }

  const embed = m.embeds?.[0];
  if (embed?.author?.name) {
    const isStaffRelay = embed.author.name.startsWith('Staff · ');
    return {
      sender: isStaffRelay ? embed.author.name : `${embed.author.name} (joueur)`,
      text: embed.description || '*[pièce jointe uniquement]*',
      time,
      from: isStaffRelay ? 'staff' : 'user',
    };
  }

  if (embed) {
    return { sender: 'Système', text: embed.title || embed.description || '[notification]', time, from: 'system' };
  }

  return { sender: 'Bot', text: m.content || '[message vide]', time, from: 'system' };
}

function createDashboardServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' })); // 2mb : marge pour les photos de profil en base64
  app.use(
    session({
      store: sessionStore,
      secret: globalStore.getSessionSecret(),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 30,
        httpOnly: true,
        sameSite: 'lax',
      },
    })
  );

  // ── DEV ONLY : bypass de connexion pour tester le dashboard sans Discord ──
  // Actif seulement si DEV_BYPASS_AUTH=true dans l'environnement (jamais en prod).
  // Dès qu'une requête arrive sans session valide, on crée/réutilise un tenant
  // de test et on connecte automatiquement un faux compte "dev" dessus.
  if (process.env.DEV_BYPASS_AUTH === 'true') {
    console.warn('⚠️  DEV_BYPASS_AUTH activé : la connexion Discord est court-circuitée. Ne JAMAIS activer ça en prod.');
    const DEV_DISCORD_ID = process.env.DEV_DISCORD_ID || 'dev-000000000000000';

    app.use(async (req, res, next) => {
      if (req.session.discordUser && req.session.tenantId) return next();
      try {
        let tenantId = await tenantManager.findTenantIdForDiscordUser(DEV_DISCORD_ID);
        if (!tenantId) {
          tenantId = await tenantManager.createTenantForDiscordUser(DEV_DISCORD_ID, 'Tenant de test (dev)');
        }

        req.session.discordUser = {
          id: DEV_DISCORD_ID,
          username: 'Dev Tester',
          handle: 'Dev Tester',
          avatar: 'https://cdn.discordapp.com/embed/avatars/0.png',
        };
        req.session.tenantId = tenantId;

        try {
          await db.query(
            `INSERT INTO users (discord_id, username, tenant_id) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE username = VALUES(username), tenant_id = VALUES(tenant_id)`,
            [DEV_DISCORD_ID, 'Dev Tester', tenantId]
          );
          const [userRows] = await db.query('SELECT id FROM users WHERE discord_id = ?', [DEV_DISCORD_ID]);
          if (userRows.length) req.session.discordUser.dbId = userRows[0].id;
        } catch (sqlErr) {
          console.error('DEV_BYPASS_AUTH: erreur upsert users:', sqlErr.message);
        }
      } catch (err) {
        console.error('DEV_BYPASS_AUTH: impossible de créer/récupérer le tenant de test:', err.message);
      }
      next();
    });
  }

  app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, tenants: botManager.allControllers().length, uptime: process.uptime() });
  });

  app.get('/accueil', (req, res) => {
    res.type('html').send(readView('index.html'));
  });

  const DISCORD_BTN_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3c-.211.375-.457.881-.626 1.283a18.27 18.27 0 0 0-5.865 0C9.898 3.881 9.646 3.375 9.434 3a19.736 19.736 0 0 0-3.762 1.37C2.913 7.99 2.157 11.53 2.42 15.02a19.9 19.9 0 0 0 6.031 3.049c.486-.657.918-1.354 1.29-2.087a12.9 12.9 0 0 1-2.032-.98c.171-.124.338-.253.5-.386a14.16 14.16 0 0 0 12.062 0c.164.133.331.262.5.386-.646.383-1.325.71-2.033.98.372.734.804 1.43 1.29 2.087a19.86 19.86 0 0 0 6.033-3.05c.309-4.06-.548-7.567-2.744-11.65ZM9.5 13.14c-1.08 0-1.96-1.005-1.96-2.24s.862-2.24 1.96-2.24 1.982 1.014 1.963 2.24c0 1.235-.865 2.24-1.963 2.24Zm7.02 0c-1.08 0-1.96-1.005-1.96-2.24s.862-2.24 1.96-2.24 1.982 1.014 1.963 2.24c0 1.235-.865 2.24-1.963 2.24Z"/></svg>`;

  // Rend login.html en injectant CÔTÉ SERVEUR le bon lien Discord (avec le
  // slug déjà résolu) ou le petit formulaire pour saisir l'identifiant
  // d'espace — plutôt que de faire deviner le slug au JS du navigateur
  // depuis l'URL (source de bugs : cache, script bloqué, etc.).
  function renderLogin(slug) {
    let html = readView('login.html');
    if (slug) {
      html = html
        .replace('__SUB_TEXT__', `Connecte-toi avec le compte Discord autorisé sur ton espace.`)
        .replace('__SLUG_FORM__', '')
        .replace(
          '__DISCORD_BTN__',
          `<a href="/api/auth/discord/${encodeURIComponent(slug)}" class="btn-discord">${DISCORD_BTN_SVG}Se connecter avec Discord</a>
           <p class="sub" style="margin-top:16px;"><a href="/login">Ce n'est pas ton code ? Recommencer</a></p>`
        );
    } else {
      html = html
        .replace('__SUB_TEXT__', 'Connecte-toi avec le compte Discord autorisé pour gérer ton bot de tickets.')
        .replace(
          '__SLUG_FORM__',
          `<form id="slug-form">
             <div class="field">
               <label for="slug-input">Code client</label>
               <input type="text" id="slug-input" class="mono" placeholder="TCKT-XXXX-XXXX-XXXX" required autocomplete="off">
               <p class="field-hint">Le code reçu à l'achat, il te sert aussi à te connecter. Pas encore de compte ? <a href="/accueil">Voir les offres</a>.</p>
             </div>
             <button type="submit" class="btn-primary" style="width:100%">Continuer</button>
           </form>`
        )
        .replace('__DISCORD_BTN__', '');
    }
    return html;
  }

  app.get('/', (req, res) => {
    if (req.session.discordUser && req.session.tenantId) return res.redirect('/dashboard');
    return res.redirect('/accueil');
  });

  // ── Comptes locaux : nom d'utilisateur + mot de passe + identifiant
  // d'achat (remplace le formulaire de connexion par défaut). Le code
  // d'achat sert à créer/relier l'espace (tenant) du client, exactement
  // comme avant, mais l'identité de connexion n'est plus le compte
  // Discord : c'est un identifiant interne "local:<id utilisateur>"
  // stocké dans les mêmes colonnes que l'ancien discord_id, pour
  // réutiliser tel quel tout le système d'admin/rôles existant.
  app.get('/signup', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.session.discordUser && req.session.tenantId) return res.redirect('/dashboard');
    res.type('html').send(readView('signup.html'));
  });

  app.post('/api/signup', async (req, res) => {
    const { username: rawUsername, password: rawPassword, code, service: rawService } = req.body || {};
    const service = rawService === 'minecraft' ? 'minecraft' : 'discord';

    const usernameCheck = validateUsername(rawUsername);
    if (!usernameCheck.ok) return res.status(400).json({ error: usernameCheck.error });
    const passwordCheck = validatePassword(rawPassword);
    if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });
    const username = usernameCheck.username;

    try {
      const check = await customerCodes.checkCode(code);
      if (!check.valid) {
        const messages = {
          not_found: "Cet identifiant d'achat n'existe pas. Vérifie ta saisie.",
          already_used: 'Cet identifiant a déjà été utilisé.',
          empty: "Merci de saisir ton identifiant d'achat.",
        };
        return res.status(400).json({ error: messages[check.reason] || 'Identifiant invalide.' });
      }

      const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
      if (existing.length) {
        return res.status(400).json({ error: "Ce nom d'utilisateur est déjà pris." });
      }

      const passwordHash = hashPassword(passwordCheck.password);
      const [insertResult] = await db.query(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)',
        [username, passwordHash]
      );
      const dbUserId = insertResult.insertId;
      const identity = `local:${dbUserId}`;

      try {
        const tenantId = await tenantManager.createTenantForDiscordUser(identity, username, service);

        const redeemed = await customerCodes.redeemCode(code, identity, username);
        if (!redeemed.ok) {
          // Le code a été pris entre le check et le redeem (course) : on
          // annule la création du compte/espace pour ne rien laisser de
          // "gratuit" derrière un code invalide.
          await db.query('DELETE FROM tenants WHERE id = ?', [tenantId]);
          await db.query('DELETE FROM users WHERE id = ?', [dbUserId]);
          return res.status(400).json({ error: 'Cet identifiant a déjà été utilisé.' });
        }

        const store = await tenantManager.getStore(tenantId);
        if (redeemed.planType) {
          store.setSubscription({ planType: redeemed.planType, active: true });
        }
        await db.query('UPDATE customer_codes SET tenant_id = ? WHERE code = ?', [tenantId, customerCodes.normalizeCode(code)]);
        await db.query('UPDATE users SET discord_id = ?, tenant_id = ? WHERE id = ?', [identity, tenantId, dbUserId]);

        req.session.discordUser = {
          id: identity,
          username,
          handle: username,
          avatar: `https://cdn.discordapp.com/embed/avatars/${dbUserId % 5}.png`,
          dbId: dbUserId,
        };
        req.session.tenantId = tenantId;

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await db.query(
          `INSERT INTO connection_logs (user_id, event_type, ip_address, user_agent) VALUES (?, 'LOGIN', ?, ?)`,
          [dbUserId, ip, req.headers['user-agent'] || '']
        );

        res.json({ ok: true });
      } catch (err) {
        await db.query('DELETE FROM users WHERE id = ?', [dbUserId]);
        throw err;
      }
    } catch (err) {
      console.error('Erreur création de compte:', err.message);
      res.status(500).json({ error: 'Erreur serveur, réessaie dans un instant.' });
    }
  });

  app.post('/api/login', async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ error: "Nom d'utilisateur et mot de passe requis." });
    }

    try {
      const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
      const user = rows[0];
      if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: "Nom d'utilisateur ou mot de passe incorrect." });
      }

      const tenantId = user.tenant_id || (await tenantManager.findTenantIdForDiscordUser(user.discord_id));
      if (!tenantId) {
        return res.status(400).json({ error: "Ce compte n'est relié à aucun espace." });
      }

      req.session.discordUser = {
        id: user.discord_id,
        username: user.username,
        handle: user.username,
        avatar: user.avatar_url || `https://cdn.discordapp.com/embed/avatars/${user.id % 5}.png`,
        dbId: user.id,
      };
      req.session.tenantId = tenantId;

      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      await db.query(
        `INSERT INTO connection_logs (user_id, event_type, ip_address, user_agent) VALUES (?, 'LOGIN', ?, ?)`,
        [user.id, ip, req.headers['user-agent'] || '']
      );

      res.json({ ok: true });
    } catch (err) {
      console.error('Erreur connexion:', err.message);
      res.status(500).json({ error: 'Erreur serveur, réessaie dans un instant.' });
    }
  });

  // ── Création d'un nouvel espace client (sa propre appli Discord) ──
  app.get('/setup', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(readView('setup.html'));
  });

  function defaultRedirectUri(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    return `${proto}://${req.get('host')}/api/auth/discord/callback`;
  }

  app.get('/api/setup/default-redirect', (req, res) => {
    res.json({ redirectUri: defaultRedirectUri(req) });
  });

  app.post('/api/setup', async (req, res) => {
    const { code, name, clientId, clientSecret } = req.body || {};
    if (!code || !name || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'Code client, nom, Client ID et Client Secret sont obligatoires.' });
    }

    try {
      const check = await customerCodes.checkCode(code);
      if (!check.valid) {
        const messages = {
          not_found: "Ce code client n'existe pas. Vérifie ta saisie.",
          already_used: 'Ce code a déjà été utilisé.',
          empty: 'Merci de saisir ton code client.',
        };
        return res.status(400).json({ error: messages[check.reason] || 'Code invalide.' });
      }

      const { tenantId, slug } = await tenantManager.createTenantWithApp({
        name: name.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        loginCode: code,
      });

      const redeemed = await customerCodes.redeemCode(code, null, null);
      if (!redeemed.ok) {
        // Le code a été pris entre le check et le redeem (course) : on
        // annule la création du tenant pour ne pas laisser d'espace
        // "gratuit" derrière un code invalide.
        await db.query('DELETE FROM tenants WHERE id = ?', [tenantId]);
        return res.status(400).json({ error: 'Ce code a déjà été utilisé.' });
      }

      const store = await tenantManager.getStore(tenantId);
      if (redeemed.planType) {
        store.setSubscription({ planType: redeemed.planType, active: true });
      }
      await db.query('UPDATE customer_codes SET tenant_id = ? WHERE code = ?', [tenantId, customerCodes.normalizeCode(code)]);

      res.json({ ok: true, slug, loginUrl: `/login/${slug}` });
    } catch (err) {
      console.error('Erreur création espace client:', err.message);
      res.status(500).json({ error: 'Erreur serveur, réessaie dans un instant.' });
    }
  });

  // ── Login via Discord OAuth2 (une appli Discord PAR client) ───────
  app.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.session.discordUser && req.session.tenantId) return res.redirect('/dashboard');
    res.type('html').send(readView('login.html'));
  });

  app.get('/login/:slug', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.session.discordUser && req.session.tenantId) return res.redirect('/dashboard');
    const tenant = await tenantManager.findTenantByLoginCode(req.params.slug);
    if (!tenant || !tenant.client_id) {
      return res.redirect('/login?error=' + encodeURIComponent("Espace introuvable. Vérifie ton code."));
    }
    res.type('html').send(renderLogin(req.params.slug));
  });

  app.get('/api/auth/discord/:slug', async (req, res) => {
    const tenant = await tenantManager.findTenantByLoginCode(req.params.slug);
    if (!tenant || !tenant.client_id) {
      return res.redirect('/login?error=' + encodeURIComponent('Espace introuvable.'));
    }

    // Réinitialise la session pour éviter les conflits d'état
    req.session.oauthState = null;
    req.session.oauthTenantId = null;

    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    req.session.oauthTenantId = tenant.id;

    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', tenant.client_id);
    url.searchParams.set('redirect_uri', defaultRedirectUri(req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);

    res.redirect(url.toString());
  });

  app.get('/api/auth/discord/callback', async (req, res) => {
    const { code, state } = req.query;
    const tenantId = req.session.oauthTenantId;
    if (!code || !state || state !== req.session.oauthState || !tenantId) {
      return res.redirect('/login?error=' + encodeURIComponent('Requête invalide ou expirée, réessaie de te connecter.'));
    }
    delete req.session.oauthState;
    delete req.session.oauthTenantId;

    const tenant = await tenantManager.findTenantById(tenantId);
    if (!tenant || !tenant.client_id || !tenant.client_secret) {
      return res.redirect('/login?error=' + encodeURIComponent('Espace introuvable.'));
    }
    const loginUrl = `/login/${tenant.slug}`;

    try {
      // Authentification Basic Auth + URLSearchParams encodé en chaîne de caractères
      const credentials = Buffer.from(`${tenant.client_id}:${tenant.client_secret}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: defaultRedirectUri(req),
      });

      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        body: body.toString(),
      });

      if (!tokenRes.ok) {
        const errorData = await tokenRes.json().catch(() => ({}));
        console.error('Erreur détaillée échange token Discord :', errorData);
        throw new Error(`Échange du code refusé par Discord (${tokenRes.status})`);
      }

      const tokenData = await tokenRes.json();

      const userRes = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userRes.ok) throw new Error("Impossible de récupérer ton profil Discord.");
      const user = await userRes.json();

      const discordProfile = {
        id: user.id,
        username: user.global_name || user.username,
        handle: user.discriminator && user.discriminator !== '0' ? `${user.username}#${user.discriminator}` : user.username,
        avatar: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
          : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`,
      };

      // Le tenant a-t-il déjà un propriétaire ?
      let authorized = false;
      if (!tenant.owner_discord_id) {
        // Première connexion sur cet espace : ce compte en devient le
        // propriétaire (opération atomique, protège contre le double-clic).
        authorized = await tenantManager.claimTenant(tenant.id, user.id);
      } else {
        const store = await tenantManager.getStore(tenant.id);
        authorized = store.isAdmin(user.id);
      }

      if (!authorized) {
        return res.redirect(loginUrl + '?error=' + encodeURIComponent("Ce compte Discord n'a pas accès à cet espace."));
      }

      req.session.discordUser = discordProfile;
      req.session.tenantId = tenant.id;

      try {
        await db.query(
          `INSERT INTO users (discord_id, username, tenant_id) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE username = VALUES(username), tenant_id = VALUES(tenant_id)`,
          [user.id, user.global_name || user.username, tenant.id]
        );

        const [userRows] = await db.query('SELECT id FROM users WHERE discord_id = ?', [user.id]);
        const dbUserId = userRows[0].id;
        req.session.discordUser.dbId = dbUserId;

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await db.query(
          `INSERT INTO connection_logs (user_id, event_type, ip_address, user_agent) VALUES (?, 'LOGIN', ?, ?)`,
          [dbUserId, ip, req.headers['user-agent'] || '']
        );
      } catch (sqlErr) {
        console.error('Erreur SQL lors de la connexion :', sqlErr.message);
      }

      res.redirect('/dashboard');
    } catch (err) {
      console.error('Erreur OAuth Discord:', err.message);
      res.redirect(loginUrl + '?error=' + encodeURIComponent('Connexion Discord échouée, réessaie.'));
    }
  });

  app.get('/api/admin/customer-codes', requireAuth, resolveTenant, requireRole('administrateur'), async (req, res) => {
    try {
      const codes = await customerCodes.listCodes();
      res.json({ codes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/logout', async (req, res) => {
    if (req.session.discordUser && req.session.discordUser.dbId) {
      try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await db.query(
          `INSERT INTO connection_logs (user_id, event_type, ip_address, user_agent) VALUES (?, 'LOGOUT', ?, ?)`,
          [req.session.discordUser.dbId, ip, req.headers['user-agent'] || '']
        );
      } catch (sqlErr) {
        console.error('Erreur SQL Déconnexion :', sqlErr.message);
      }
    }
    req.session.destroy(() => res.json({ ok: true }));
  });

  // ── Dashboard ──────────
  app.get('/dashboard', requireAuth, (req, res) => {
    res.type('html').send(readView('dashboard.html'));
  });

  const api = express.Router();
  api.use(requireAuth, resolveTenant);

  api.get('/me', (req, res) => {
    res.json({
      user: req.session.discordUser,
      admins: req.tenantStore.getAdminIds(),
      role: req.adminRole,
    });
  });

  // ── Paramètres du compte : photo de profil ─────────────────────
  const MAX_AVATAR_DATA_URL_LENGTH = 1.5 * 1024 * 1024; // ~1.5 Mo en base64

  api.post('/profile/avatar', async (req, res) => {
    const avatar = String(req.body?.avatar || '');
    if (!avatar) return res.status(400).json({ error: 'Aucune image fournie.' });
    if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(avatar)) {
      return res.status(400).json({ error: 'Format d\'image non supporté.' });
    }
    if (avatar.length > MAX_AVATAR_DATA_URL_LENGTH) {
      return res.status(400).json({ error: 'Image trop lourde (2 Mo maximum).' });
    }

    const dbUserId = req.session.discordUser?.dbId;
    if (!dbUserId) return res.status(400).json({ error: "Compte introuvable." });

    try {
      await db.query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatar, dbUserId]);
      req.session.discordUser.avatar = avatar;
      res.json({ ok: true, avatar });
    } catch (err) {
      console.error('Erreur sauvegarde avatar:', err.message);
      res.status(500).json({ error: 'Impossible d\'enregistrer la photo de profil.' });
    }
  });

  api.get('/fivem/config', async (req, res) => {
    try {
      const dbUserId = req.session.discordUser.dbId;
      const [rows] = await db.query('SELECT fivem_enabled, fivem_url, blur_val FROM user_configs WHERE user_id = ?', [dbUserId]);
      if (rows.length > 0) {
        return res.json({
          enabled: Boolean(rows[0].fivem_enabled),
          url: rows[0].fivem_url,
          blurVal: rows[0].blur_val
        });
      }
      res.json({ enabled: false, url: '', blurVal: 5 });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erreur serveur lors de la récupération SQL." });
    }
  });

  api.post('/fivem/config', async (req, res) => {
    try {
      const dbUserId = req.session.discordUser.dbId;
      const { enabled, url } = req.body;

      await db.query(`
        INSERT INTO user_configs (user_id, fivem_enabled, fivem_url)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE fivem_enabled = VALUES(fivem_enabled), fivem_url = VALUES(fivem_url)
      `, [dbUserId, enabled ? 1 : 0, url || '']);

      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Impossible d'enregistrer la configuration dans MySQL." });
    }
  });

  api.get('/fivem/bans', async (req, res) => {
    try {
      const dbUserId = req.session.discordUser.dbId;
      const [rows] = await db.query('SELECT fivem_url FROM user_configs WHERE user_id = ?', [dbUserId]);
      if (!rows.length || !rows[0].fivem_url) return res.json([]);
      res.json([]);
    } catch (err) {
      res.status(500).json({ error: "Erreur lors de la récupération des bannis." });
    }
  });

  api.get('/status', (req, res) => {
    if (req.tenantService === 'minecraft') return res.json(req.minecraft.getStatus());
    res.json(req.bot.getStatus());
  });

  // ── Service du tenant courant : détermine ce que le front affiche ──
  api.get('/service', (req, res) => {
    res.json({ service: req.tenantService });
  });

  // ── Bascule Discord <-> Minecraft depuis le switcher de la sidebar ──
  // Réservé aux administrateurs : ça change ce que TOUT le tenant voit.
  api.post('/service', requireRole('administrateur'), async (req, res) => {
    const wanted = req.body?.service === 'minecraft' ? 'minecraft' : 'discord';
    if (wanted === req.tenantService) return res.json({ service: wanted });
    try {
      const service = await tenantManager.setService(req.tenantId, wanted);
      res.json({ service });
    } catch (err) {
      res.status(500).json({ error: `Impossible de changer de service : ${err.message}` });
    }
  });

  // ── Console du serveur : conso CPU/RAM réelle (hôte + process suivi) ──
  // Le "process suivi" dépend du service actif du tenant : le vrai PID du
  // serveur Minecraft (lu via /proc) s'il tourne, sinon le process Node du
  // dashboard lui-même (qui héberge aussi le bot Discord en in-process).
  api.get('/server/stats', (req, res) => {
    const host = processStats.hostStats();
    let proc = null;
    if (req.tenantService === 'minecraft' && req.minecraft?.process?.pid && req.minecraft.status === 'running') {
      // sampleChildProcess() renvoie null si /proc est indisponible (ex: hôte
      // Windows) — le process Minecraft tourne quand même. On garde `running:
      // true` et on marque juste les métriques comme indisponibles plutôt que
      // de renvoyer `proc = null`, ce qui faisait passer la carte à "Hors
      // ligne" alors que le serveur est bel et bien en ligne.
      const sample = processStats.sampleChildProcess(req.minecraft.process.pid);
      proc = {
        label: 'Serveur Minecraft',
        pid: req.minecraft.process.pid,
        running: true,
        cpuPercent: sample ? sample.cpuPercent : null,
        memMb: sample ? sample.memMb : null,
        statsUnavailable: !sample,
      };
    } else if (req.tenantService === 'minecraft') {
      proc = { label: 'Serveur Minecraft', running: false, cpuPercent: 0, memMb: 0 };
    } else {
      const sample = processStats.sampleSelfProcess();
      proc = {
        label: 'Bot Discord',
        pid: process.pid,
        running: req.bot?.getStatus?.().status === 'online',
        cpuPercent: sample ? sample.cpuPercent : null,
        memMb: sample ? sample.memMb : null,
        statsUnavailable: !sample,
      };
    }
    res.json({ host, process: proc });
  });

  api.get('/settings', requireRole('administrateur'), (req, res) => {
    const b = req.tenantStore.getBot();
    res.json({
      bot: { ...b, token: b.token ? maskToken(b.token) : '' },
      hasToken: !!b.token,
      ticketTypes: req.tenantStore.getTicketTypes(),
    });
  });

  api.post('/settings/bot', requireRole('administrateur'), async (req, res) => {
    const patch = { ...req.body };
    const isTokenChange = !!(patch.token && !patch.token.includes('•'));
    if (patch.token && patch.token.includes('•')) delete patch.token;
    const updated = req.tenantStore.setBot(patch);
    auditLog.logFromRequest(req, 'settings.bot.update', null, {
      fieldsChanged: Object.keys(patch),
      tokenChanged: isTokenChange,
    });

    let panel = null;
    if (!isTokenChange) {
      panel = await req.bot.refreshPanel();
    } else if (patch.token) {
      // Ne PAS attendre la reconnexion complète ici : login() peut prendre
      // plusieurs secondes (voire rester bloqué en cas de souci réseau côté
      // Discord), ce qui gelait toute la requête et donnait l'impression
      // que le dashboard était bloqué sur "connexion en cours". On lance la
      // reconnexion en tâche de fond et on répond tout de suite ; le front
      // suit la progression via le polling de /api/status.
      req.bot.restart().catch((err) => {
        console.error(`Erreur reconnexion bot (tenant ${req.tenantId}):`, err.message);
      });
    }

    res.json({
      ok: true,
      bot: { ...updated, token: updated.token ? maskToken(updated.token) : '' },
      panel,
    });
  });

  // ── Module DayZ (économie / safe zones / classements) ────────────
  // Réservé aux administrateurs du dashboard (la whitelist "staff DayZ"
  // pour /dayz-give et /dayz-link est une notion séparée, gérée via ces
  // mêmes routes mais consommée côté Discord par store.isDayzStaff()).
  api.get('/dayz/settings', requireRole('administrateur'), (req, res) => {
    const dayzConfig = req.tenantStore.getDayz();
    res.json({ ...dayzConfig, rcon: { ...dayzConfig.rcon, password: dayzConfig.rcon.password ? '••••••••' : '' } });
  });

  api.post('/dayz/settings', requireRole('administrateur'), (req, res) => {
    const patch = { ...req.body };
    if (patch.rcon && typeof patch.rcon.password === 'string' && patch.rcon.password.includes('•')) {
      delete patch.rcon.password; // champ masqué renvoyé tel quel -> on ne l'écrase pas
    }
    const updated = req.tenantStore.setDayz(patch);
    auditLog.logFromRequest(req, 'settings.dayz.update', null, { fieldsChanged: Object.keys(patch) });
    res.json({ ok: true, dayz: { ...updated, rcon: { ...updated.rcon, password: updated.rcon.password ? '••••••••' : '' } } });
  });

  // ── Liaison compte Nitrado : récupère automatiquement les accès RCon
  // + le dossier de logs ADM depuis le token API Nitrado du client, sans
  // qu'il ait besoin de connaître ces infos (utile en particulier pour
  // un serveur PS4/PS5 où il n'y a pas d'accès FTP/RCon direct).
  api.get('/dayz/nitrado', requireRole('administrateur'), (req, res) => {
    const dayzConfig = req.tenantStore.getDayz();
    const n = dayzConfig.nitrado || {};
    res.json({ ...n, token: n.token ? '••••••••' : '' });
  });

  // Étape 1 : le client colle son token API Nitrado -> on vérifie qu'il
  // est valide et on renvoie la liste de ses services pour qu'il
  // choisisse lequel est son serveur DayZ (sans rien enregistrer tant
  // que le choix n'est pas fait, cf. /dayz/nitrado/select).
  api.post('/dayz/nitrado/link', requireRole('administrateur'), async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token API Nitrado requis.' });
    try {
      const services = await nitradoApi.listServices(token);
      res.json({ ok: true, services });
    } catch (err) {
      res.status(400).json({ error: `Token Nitrado invalide ou API injoignable : ${err.message}` });
    }
  });

  // Étape 2 : le client choisit son service DayZ parmi la liste -> on
  // enregistre token + serviceId, puis on synchronise tout de suite.
  api.post('/dayz/nitrado/select', requireRole('administrateur'), async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const serviceId = String(req.body?.serviceId || '').trim();
    if (!token || !serviceId) return res.status(400).json({ error: 'token et serviceId requis.' });

    req.tenantStore.setDayz({ nitrado: { token, serviceId, linked: true } });

    try {
      const result = await nitradoApi.fetchRconAndLogConfig(token, serviceId);
      const dayzPatch = {
        nitrado: { lastSyncAt: Date.now(), lastSyncError: result.missing.length ? result.missing.join(', ') : null },
      };
      if (result.host) dayzPatch.rcon = { ...dayzPatch.rcon, host: result.host };
      if (result.port) dayzPatch.rcon = { ...dayzPatch.rcon, port: result.port };
      if (result.password) dayzPatch.rcon = { ...dayzPatch.rcon, password: result.password };
      if (result.admLogDir) dayzPatch.admLogDir = result.admLogDir;
      const updated = req.tenantStore.setDayz(dayzPatch);
      res.json({
        ok: true,
        dayz: { ...updated, rcon: { ...updated.rcon, password: updated.rcon.password ? '••••••••' : '' }, nitrado: { ...updated.nitrado, token: '••••••••' } },
        missing: result.missing,
      });
    } catch (err) {
      req.tenantStore.setDayz({ nitrado: { lastSyncError: err.message } });
      res.status(200).json({
        ok: true,
        dayz: req.tenantStore.getDayz(),
        warning: `Serveur lié, mais synchro auto impossible (${err.message}). Renseigne le RCon manuellement ci-dessous.`,
      });
    }
  });

  // Resynchronise à la demande (ex: le client a changé son mot de passe
  // RCon côté Nitrado et veut que le dashboard le retrouve tout seul).
  api.post('/dayz/nitrado/sync', requireRole('administrateur'), async (req, res) => {
    const dayzConfig = req.tenantStore.getDayz();
    const n = dayzConfig.nitrado || {};
    if (!n.linked || !n.token || !n.serviceId) {
      return res.status(400).json({ error: 'Aucun compte Nitrado lié.' });
    }
    try {
      const result = await nitradoApi.fetchRconAndLogConfig(n.token, n.serviceId);
      const dayzPatch = { nitrado: { lastSyncAt: Date.now(), lastSyncError: result.missing.length ? result.missing.join(', ') : null } };
      if (result.host) dayzPatch.rcon = { ...dayzPatch.rcon, host: result.host };
      if (result.port) dayzPatch.rcon = { ...dayzPatch.rcon, port: result.port };
      if (result.password) dayzPatch.rcon = { ...dayzPatch.rcon, password: result.password };
      if (result.admLogDir) dayzPatch.admLogDir = result.admLogDir;
      const updated = req.tenantStore.setDayz(dayzPatch);
      res.json({ ok: true, dayz: { ...updated, rcon: { ...updated.rcon, password: updated.rcon.password ? '••••••••' : '' }, nitrado: { ...updated.nitrado, token: '••••••••' } }, missing: result.missing });
    } catch (err) {
      req.tenantStore.setDayz({ nitrado: { lastSyncError: err.message } });
      res.status(400).json({ error: err.message });
    }
  });

  api.delete('/dayz/nitrado', requireRole('administrateur'), (req, res) => {
    const updated = req.tenantStore.setDayz({ nitrado: { token: '', serviceId: '', linked: false, lastSyncAt: null, lastSyncError: null } });
    res.json({ ok: true, dayz: updated });
  });

  api.post('/dayz/safezones', requireRole('administrateur'), (req, res) => {
    const { name, x, z, radius } = req.body || {};
    if (!name || typeof x !== 'number' || typeof z !== 'number' || typeof radius !== 'number') {
      return res.status(400).json({ error: 'Champs requis : name (texte), x, z, radius (nombres).' });
    }
    const zones = req.tenantStore.addDayzSafeZone({ name, x, z, radius });
    res.json({ ok: true, safeZones: zones });
  });

  api.delete('/dayz/safezones/:id', requireRole('administrateur'), (req, res) => {
    const zones = req.tenantStore.removeDayzSafeZone(req.params.id);
    res.json({ ok: true, safeZones: zones });
  });

  // Staff DayZ (autorisé à /dayz-give et /dayz-link côté Discord, sans
  // forcément avoir accès au dashboard lui-même).
  api.post('/dayz/staff', requireRole('administrateur'), (req, res) => {
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{15,25}$/.test(discordId)) return res.status(400).json({ error: 'ID Discord invalide.' });
    const dayzConfig = req.tenantStore.getDayz();
    if (!dayzConfig.staffWhitelist.includes(discordId)) dayzConfig.staffWhitelist.push(discordId);
    const updated = req.tenantStore.setDayz({ staffWhitelist: dayzConfig.staffWhitelist });
    res.json({ ok: true, staffWhitelist: updated.staffWhitelist });
  });

  api.delete('/dayz/staff/:discordId', requireRole('administrateur'), (req, res) => {
    const dayzConfig = req.tenantStore.getDayz();
    const staffWhitelist = dayzConfig.staffWhitelist.filter((id) => id !== req.params.discordId);
    const updated = req.tenantStore.setDayz({ staffWhitelist });
    res.json({ ok: true, staffWhitelist: updated.staffWhitelist });
  });

  api.get('/dayz/leaderboard', async (req, res) => {
    const type = ['money', 'kills', 'ratio'].includes(req.query.type) ? req.query.type : 'money';
    const rows = await getDayzLeaderboard(req.tenantId, type, 20);
    res.json({ type, rows });
  });

  api.get('/dayz/ban-log', requireRole('administrateur', 'moderateur'), async (req, res) => {
    const [rows] = await db.query(
      'SELECT * FROM dayz_ban_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100',
      [req.tenantId]
    );
    res.json({ rows });
  });

  // ── Serveur Minecraft (routes actives uniquement pour un tenant de
  // service "minecraft" — 404 sinon, pour ne pas exposer de surface
  // inutile aux tenants Discord). ──────────────────────────────────
  function requireMinecraft(req, res, next) {
    if (req.tenantService !== 'minecraft') return res.status(404).json({ error: 'Service indisponible.' });
    next();
  }

  api.get('/minecraft', requireMinecraft, async (req, res) => {
    const config = req.tenantStore.getMinecraft();
    let connection = null;
    if (config.created) {
      try {
        connection = await minecraftManager.getConnectionInfo(config.port);
      } catch {
        connection = null;
      }
    }
    res.json({ config, runtime: req.minecraft.getStatus(), connection });
  });

  // Les versions listées viennent de l'API PaperMC : ça ne concerne que
  // l'édition Java (Bedrock n'a qu'un seul build officiel toujours à jour,
  // pas de choix de version côté hébergement).
  api.get('/minecraft/versions', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      res.json(await minecraftManager.listAvailableVersions());
    } catch (err) {
      res.status(500).json({ error: `Impossible de récupérer les versions PaperMC : ${err.message}` });
    }
  });

  api.post('/minecraft/create', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    const { name, mcVersion, memoryMb, port, edition } = req.body || {};
    const safeEdition = minecraftManager.normalizeEdition(edition);
    if (safeEdition === 'java' && !mcVersion) {
      return res.status(400).json({ error: 'Version Minecraft requise.' });
    }
    const defaultPort = safeEdition === 'bedrock' ? 19132 : 25565;
    try {
      await req.minecraft.provision({ mcVersion, port, edition: safeEdition });
      const updated = req.tenantStore.setMinecraft({
        name: name || 'Mon serveur',
        edition: safeEdition,
        mcVersion: safeEdition === 'bedrock' ? '' : mcVersion,
        memoryMb: Number(memoryMb) || 1024,
        port: Number(port) || defaultPort,
        eulaAccepted: true,
        created: true,
      });
      res.json({ ok: true, config: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/minecraft/start', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      const cfg = req.tenantStore.getMinecraft();
      res.json(await req.minecraft.start({ memoryMb: cfg.memoryMb, edition: cfg.edition }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/minecraft/stop', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    res.json(await req.minecraft.stop());
  });

  api.post('/minecraft/restart', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    await req.minecraft.stop();
    const cfg = req.tenantStore.getMinecraft();
    res.json(await req.minecraft.start({ memoryMb: cfg.memoryMb, edition: cfg.edition }));
  });

  api.post('/minecraft/command', requireMinecraft, requireRole('administrateur'), (req, res) => {
    try {
      req.minecraft.sendCommand(String(req.body?.command || ''));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/minecraft/logs', requireMinecraft, (req, res) => {
    res.json({ logs: req.minecraft.getLogs() });
  });

  // ── Configuration (server.properties) : lecture/écriture clé/valeur
  // du vrai fichier server.properties du tenant, via un schéma de champs
  // propre à l'édition (java/bedrock) pour le rendu du formulaire. ──
  api.get('/minecraft/properties', requireMinecraft, async (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    if (!cfg.created) return res.status(400).json({ error: "Aucun serveur installé pour l'instant." });
    try {
      const properties = await minecraftManager.readServerProperties(minecraftManager.tenantDir(req.tenantId));
      res.json({ edition: cfg.edition, schema: minecraftManager.getPropertySchema(cfg.edition), properties });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  api.post('/minecraft/properties', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    if (!cfg.created) return res.status(400).json({ error: "Aucun serveur installé pour l'instant." });
    const updates = req.body?.properties;
    if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Propriétés invalides.' });
    try {
      await minecraftManager.writeServerProperties(minecraftManager.tenantDir(req.tenantId), updates);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admins Minecraft : pseudos qui reçoivent la permission Operator/OP
  // à leur connexion et peuvent ensuite changer eux-mêmes de mode de jeu
  // en jeu — tout le monde d'autre reste limité au mode par défaut du
  // serveur (voir MinecraftController._checkPlayerJoin). ──
  api.get('/minecraft/admins', requireMinecraft, (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    res.json({ admins: cfg.admins || [] });
  });

  api.post('/minecraft/admins', requireMinecraft, requireRole('administrateur'), (req, res) => {
    const raw = req.body?.admins;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'Liste invalide.' });
    const admins = [...new Set(raw.map((a) => String(a).trim()).filter(Boolean))];
    const updated = req.tenantStore.setMinecraft({ admins });
    res.json({ ok: true, admins: updated.admins || [] });
  });

  api.delete('/minecraft', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      await req.minecraft.wipe();
      req.tenantStore.setMinecraft({ created: false, mcVersion: '' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Gestionnaire de fichiers : partagé Discord (dossier "libre" du
  // tenant) et Minecraft (dossier réel du serveur). Toujours borné à la
  // racine du tenant courant (voir lib/fileManager.js:safeResolve). ──
  function filesRoot(req) {
    return fileManager.rootForService(req.tenantId, req.tenantService);
  }

  api.get('/files', requireRole('administrateur', 'moderateur'), async (req, res) => {
    try {
      res.json({ items: await fileManager.list(filesRoot(req), req.query.path || '') });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/files/content', requireRole('administrateur', 'moderateur'), async (req, res) => {
    try {
      res.json({ content: await fileManager.readFile(filesRoot(req), req.query.path || '') });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/files/content', requireRole('administrateur'), async (req, res) => {
    try {
      await fileManager.writeFile(filesRoot(req), req.body?.path || '', req.body?.content ?? '');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/files/upload', requireRole('administrateur'), express.json({ limit: '80mb' }), async (req, res) => {
    try {
      await fileManager.writeBinaryBase64(filesRoot(req), req.body?.path || '', req.body?.base64 || '');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/files/mkdir', requireRole('administrateur'), async (req, res) => {
    try {
      await fileManager.mkdir(filesRoot(req), req.body?.path || '');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/files/rename', requireRole('administrateur'), async (req, res) => {
    try {
      await fileManager.rename(filesRoot(req), req.body?.from || '', req.body?.to || '');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.delete('/files', requireRole('administrateur'), async (req, res) => {
    try {
      await fileManager.remove(filesRoot(req), req.query.path || '');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/cfx/test', requireRole('administrateur'), async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Code CFX manquant.' });
    try {
      const status = await fetchServerStatus(code);
      res.json(status);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/settings/ticket-types', requireRole('administrateur'), (req, res) => {
    const types = req.body?.ticketTypes;
    if (!Array.isArray(types)) return res.status(400).json({ error: 'Format invalide.' });

    for (const t of types) {
      if (!t.id || !t.label || !t.emoji) {
        return res.status(400).json({ error: 'Chaque type de ticket doit avoir un id, un label et un emoji.' });
      }
      if (!isValidEmoji(t.emoji)) {
        return res.status(400).json({
          error: `Emoji invalide pour "${t.label}" : "${t.emoji}". Utilise un emoji Unicode (ex: 🎫) ou un emoji personnalisé du serveur (ex: <:nom:1234567890>).`,
        });
      }
    }
    const ids = types.map((t) => t.id);
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Les identifiants de types de tickets doivent être uniques.' });
    }

    const saved = req.tenantStore.setTicketTypes(types);
    res.json({ ok: true, ticketTypes: saved });
  });

  api.post('/bot/restart', requireRole('administrateur'), async (req, res) => {
    const status = await req.bot.restart();
    if (status.rateLimitedUntil) {
      res.set('Retry-After', String(Math.max(status.retryAfterSeconds || 0, 0)));
      return res.status(429).json({
        ok: false,
        status,
        error: status.lastError,
        retryAfterSeconds: status.retryAfterSeconds,
      });
    }
    res.json({ ok: true, status });
  });

  api.post('/bot/refresh-panel', requireRole('administrateur'), async (req, res) => {
    const result = await req.bot.refreshPanel();
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json({ ok: true });
  });

  // ── Diagnostic connexion Discord ────────────────────────────
  // Isole la cause d'un blocage sur "connecting" : distingue un problème
  // de TOKEN (REST échoue tout de suite avec 401) d'un problème RÉSEAU
  // côté hébergeur (REST timeout/erreur alors que le token est valide,
  // typique d'une sortie WebSocket bloquée vers gateway.discord.gg alors
  // que les requêtes HTTPS classiques passent, ou l'inverse). Ne touche
  // pas au client discord.js du tenant : requête HTTPS indépendante.
  api.get('/bot/diagnose', requireRole('administrateur'), async (req, res) => {
    const bot = req.tenantStore.getBot();
    if (!bot.token) return res.status(400).json({ error: 'Aucun token enregistré.' });

    const steps = [];
    const started = Date.now();
    let rateLimitedSeconds = null;

    // Extrait le délai d'attente exact renvoyé par Discord sur un 429,
    // depuis le header Retry-After ou le corps JSON ({ retry_after }).
    async function readRetryAfter(res) {
      const header = res.headers.get('retry-after');
      if (header && !Number.isNaN(Number(header))) return Number(header);
      try {
        const body = await res.clone().json();
        if (typeof body?.retry_after === 'number') return body.retry_after;
      } catch {}
      return null;
    }

    try {
      const t0 = Date.now();
      const ctrl = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
      const meRes = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bot ${bot.token}` },
        signal: ctrl,
      });
      const ms = Date.now() - t0;
      if (meRes.status === 429) {
        const retryAfter = await readRetryAfter(meRes);
        rateLimitedSeconds = retryAfter ?? rateLimitedSeconds ?? 60;
        steps.push({
          step: 'REST /users/@me',
          ok: false,
          ms,
          detail: retryAfter
            ? `Rate limité par Discord (HTTP 429). Ce n'est PAS un problème de token : Discord demande d'attendre ${Math.ceil(retryAfter)}s avant toute nouvelle requête (probablement l'IP partagée de l'hébergeur, ou trop de tentatives rapprochées). Arrête toute reconnexion jusque-là.`
            : `Rate limité par Discord (HTTP 429) sans délai précisé dans la réponse. Arrête toute tentative de reconnexion pendant quelques minutes.`,
        });
      } else if (meRes.status === 401) {
        steps.push({ step: 'REST /users/@me', ok: false, ms, detail: 'Token invalide ou révoqué (401). Régénère le token sur le Developer Portal et recolle-le en entier, sans espace.' });
      } else if (!meRes.ok) {
        steps.push({ step: 'REST /users/@me', ok: false, ms, detail: `HTTP ${meRes.status}` });
      } else {
        const me = await meRes.json();
        steps.push({ step: 'REST /users/@me', ok: true, ms, detail: `Token valide, application "${me.username}". Les sorties HTTPS fonctionnent.` });
      }
    } catch (err) {
      steps.push({
        step: 'REST /users/@me',
        ok: false,
        ms: Date.now() - started,
        detail: `Échec réseau (${err.message}). L'hébergeur bloque probablement les connexions HTTPS sortantes vers discord.com, ou coupe les requêtes longues.`,
      });
    }

    try {
      const t0 = Date.now();
      const ctrl = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
      const gwRes = await fetch(`${DISCORD_API}/gateway/bot`, {
        headers: { Authorization: `Bot ${bot.token}` },
        signal: ctrl,
      });
      const ms = Date.now() - t0;
      if (!gwRes.ok) {
        steps.push({ step: 'REST /gateway/bot', ok: false, ms, detail: `HTTP ${gwRes.status}` });
      } else {
        const gw = await gwRes.json();
        steps.push({
          step: 'REST /gateway/bot',
          ok: true,
          ms,
          detail: `URL gateway obtenue (${gw.url}). Sessions restantes ce jour : ${gw.session_start_limit?.remaining ?? '?'}/${gw.session_start_limit?.total ?? '?'}.`,
        });
        if (gw.session_start_limit && gw.session_start_limit.remaining === 0) {
          steps.push({
            step: 'Session start limit',
            ok: false,
            ms: 0,
            detail: `⚠️ Quota de connexions Discord épuisé pour aujourd'hui (reset dans ${Math.ceil((gw.session_start_limit.reset_after || 0) / 3600000)}h). C'est probablement la cause du blocage : Discord refuse silencieusement l'IDENTIFY tant que le quota n'est pas reset.`,
          });
        }
      }
    } catch (err) {
      steps.push({
        step: 'REST /gateway/bot',
        ok: false,
        ms: Date.now() - started,
        detail: `Échec réseau (${err.message}).`,
      });
    }

    const allRestOk = steps.filter((s) => s.step.startsWith('REST')).every((s) => s.ok);
    let verdict;
    if (!allRestOk) {
      verdict = "Les requêtes REST (HTTPS classique) vers Discord échouent déjà. C'est un problème de token ou de réseau sortant côté hébergeur, PAS spécifique au WebSocket. Corrige ça d'abord.";
    } else if (steps.some((s) => s.step === 'Session start limit')) {
      verdict = 'Le token et le réseau HTTPS fonctionnent, mais le quota de connexions Discord est épuisé — attends le reset.';
    } else {
      verdict = "Le token est valide et les requêtes HTTPS passent. Si la connexion WebSocket (bot) reste bloquée malgré ça, c'est très probablement l'hébergeur qui bloque spécifiquement le trafic WebSocket (port 443 en mode 'upgrade') vers gateway.discord.gg, alors qu'il laisse passer le HTTPS classique. Active DEBUG_DISCORD=true dans les variables d'environnement et regarde les logs pour voir où ça bloque exactement.";
    }

    res.json({ ok: allRestOk, steps, verdict, botStatus: req.bot.getStatus() });
  });

  api.get('/discord/guilds', requireRole('administrateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') return res.json([]);
    const guilds = [...req.bot.client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
    res.json(guilds);
  });

  api.get('/discord/guilds/:guildId/channels', requireRole('administrateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') return res.json([]);
    try {
      const guild = await req.bot.client.guilds.fetch(req.params.guildId);
      const channels = await guild.channels.fetch();
      const textChannels = [...channels.values()]
        .filter((c) => c && c.type === 0)
        .map((c) => ({ id: c.id, name: c.name }));
      res.json(textChannels);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/discord/guilds/:guildId/categories', requireRole('administrateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') return res.json([]);
    try {
      const guild = await req.bot.client.guilds.fetch(req.params.guildId);
      const channels = await guild.channels.fetch();
      const categories = [...channels.values()]
        .filter((c) => c && c.type === 4)
        .map((c) => ({ id: c.id, name: c.name }));
      res.json(categories);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/discord/guilds/:guildId/roles', requireRole('administrateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') return res.json([]);
    try {
      const guild = await req.bot.client.guilds.fetch(req.params.guildId);
      const roles = await guild.roles.fetch();
      const list = [...roles.values()]
        .filter((r) => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
      res.json(list);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/stats', async (req, res) => {
    res.json(await computeStats(req.tenantId));
  });

  api.get('/tickets/open', async (req, res) => {
    const tickets = await readTickets(req.tenantId);
    const open = tickets
      .filter((t) => t.status === 'open')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((t) => ({
        id: t.id,
        channelId: t.channelId,
        guildId: t.guildId,
        userTag: t.userTag,
        userId: t.userId,
        typeId: t.typeId,
        status: t.status,
        claimedByTag: t.claimedByTag || null,
        createdAt: t.createdAt,
      }));
    res.json(open);
  });

  api.get('/tickets/:id/messages', requireRole('administrateur', 'moderateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') {
      return res.status(503).json({ error: 'Le bot est hors ligne, impossible de lire les messages.' });
    }
    try {
      const [rows] = await db.query('SELECT data FROM tickets WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
      if (!rows.length) return res.status(404).json({ error: 'Ticket introuvable.' });
      const ticket = JSON.parse(rows[0].data);

      const channel = await req.bot.client.channels.fetch(ticket.channelId);
      const messages = await channel.messages.fetch({ limit: 30 });
      const list = [...messages.values()].reverse().map((m) => mapTicketMessage(m));

      res.json({
        ticket: { id: ticket.id, userTag: ticket.userTag, typeId: ticket.typeId, status: ticket.status },
        messages: list,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/tickets/:id/reply', requireRole('administrateur', 'moderateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online' || !req.bot.ticketManager) {
      return res.status(503).json({ error: "Le bot est hors ligne, impossible d'envoyer un message." });
    }
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message vide.' });

    try {
      const [rows] = await db.query('SELECT data FROM tickets WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
      if (!rows.length) return res.status(404).json({ error: 'Ticket introuvable.' });
      const ticket = JSON.parse(rows[0].data);

      const staffLabel = req.session.discordUser?.username || 'Staff';
      await req.bot.ticketManager.sendDashboardReply(ticket, staffLabel, message);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/tickets/export.csv', requireRole('administrateur', 'moderateur'), async (req, res) => {
    const tickets = await readTickets(req.tenantId);
    const csv = toCsv(tickets);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tickets-${Date.now()}.csv"`);
    res.send(csv);
  });

  api.get('/admins', requireRole('administrateur'), (req, res) => {
    res.json({ admins: req.tenantStore.getAdminsWithRoles(), selfId: req.session.discordUser.id });
  });

  api.post('/admins', requireRole('administrateur'), async (req, res) => {
    const id = String(req.body?.discordId || '').trim();
    if (!/^\d{15,25}$/.test(id)) return res.status(400).json({ error: "ID Discord invalide (identifiant numérique attendu)." });

    let role = String(req.body?.role || 'administrateur').trim();
    if (!TenantStore.ROLES.includes(role)) role = 'administrateur';

    const existingTenant = await tenantManager.findTenantIdForDiscordUser(id);
    if (existingTenant && existingTenant !== req.tenantId) {
      return res.status(400).json({ error: 'Cet identifiant Discord est déjà administrateur sur un autre dashboard.' });
    }

    await tenantManager.addAdminToTenant(req.tenantId, id, role);
    auditLog.logFromRequest(req, 'admins.add', id, { role });
    res.json({ ok: true, admins: req.tenantStore.getAdminsWithRoles() });
  });

  api.patch('/admins/:id/role', requireRole('administrateur'), (req, res) => {
    const role = String(req.body?.role || '').trim();
    if (!TenantStore.ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide.' });
    try {
      const admins = req.tenantStore.setAdminRole(req.params.id, role);
      auditLog.logFromRequest(req, 'admins.role_change', req.params.id, { role });
      res.json({ ok: true, admins });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.delete('/admins/:id', requireRole('administrateur'), async (req, res) => {
    const adminIds = req.tenantStore.getAdminIds();
    if (adminIds.length <= 1) return res.status(400).json({ error: 'Impossible de retirer le dernier administrateur.' });
    if (
      req.tenantStore.getAdminRole(req.params.id) === 'administrateur' &&
      req.tenantStore.countAdministrateurs() <= 1
    ) {
      return res.status(400).json({ error: 'Impossible de retirer le dernier administrateur.' });
    }
    await tenantManager.removeAdminFromTenant(req.tenantId, req.params.id);
    auditLog.logFromRequest(req, 'admins.remove', req.params.id);
    res.json({ ok: true, admins: req.tenantStore.getAdminsWithRoles() });
  });

  // ── Registre d'audit : lecture des dernières actions du tenant ──────
  api.get('/audit-log', requireRole('administrateur'), async (req, res) => {
    try {
      const entries = await auditLog.getRecent(req.tenantId, req.query.limit);
      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: `Impossible de lire le registre d'audit : ${err.message}` });
    }
  });

  app.use('/api', api);

  return app;
}

function maskToken(token) {
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 6)}${'•'.repeat(18)}${token.slice(-4)}`;
}

module.exports = createDashboardServer;