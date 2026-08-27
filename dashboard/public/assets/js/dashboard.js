// ── État global ───────────────────────────────────────────
let state = {
  bot: {},
  ticketTypes: [],
  guilds: [],
  panelChannels: [],
  staffCategories: [],
  staffRoles: [],
  me: null,
  admins: [],
  service: 'discord',
  minecraft: { config: {}, runtime: {} },
  files: { path: '', items: [], openFile: null },
};

// ── Utilitaires ───────────────────────────────────────────
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur inconnue');
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function fillSelect(select, items, { value, label, placeholder }) {
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';
  if (placeholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = value(item);
    opt.textContent = label(item);
    select.appendChild(opt);
  }
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── LAZY LOADING DES VUES & NAVIGATION ────────────────────
const LAZY_LOADERS = { 
  stats: loadStats, 
  access: loadAdmins,
  audit: loadAuditLog,
  livechat: loadTickets,
  'open-tickets': loadOpenTickets,
  minecraft: loadMinecraft,
  'minecraft-console': loadMinecraft,
  files: () => loadFiles(''),
  dayz: loadDayz,
  'server-console': loadServerConsole,
};
const loadedViews = new Set(['overview']);

function initNavigation() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      
      item.classList.add('active');
      const viewName = item.dataset.view;
      const targetView = document.getElementById(`view-${viewName}`);
      if (targetView) targetView.classList.add('active');

      if (!loadedViews.has(viewName) && LAZY_LOADERS[viewName]) {
        loadedViews.add(viewName);
        LAZY_LOADERS[viewName]();
      }
    });
  });
}

// Cache les entrées de nav qui ne concernent pas le service de ce tenant
// (data-service="discord" masqué pour un tenant Minecraft, et inversement).
// Un nav-item sans attribut data-service est toujours visible (vue commune
// aux deux services : vue d'ensemble, abonnement, accès admin, fichiers…).
function applyServiceVisibility() {
  document.querySelectorAll('.nav-item[data-service]').forEach((item) => {
    item.style.display = item.dataset.service === state.service ? '' : 'none';
  });
  // Si la vue active vient d'être masquée (ex: on était sur "Connexion bot"
  // et le tenant est en fait Minecraft), on retombe sur "Vue d'ensemble".
  const activeItem = document.querySelector('.nav-item.active');
  if (activeItem && activeItem.style.display === 'none') {
    document.querySelector('.nav-item[data-view="overview"]')?.click();
  }
  updateServiceSwitcher();
}

// Met en surbrillance le bouton du service actuellement actif dans le
// switcher de la sidebar (bascule Discord <-> Minecraft).
function updateServiceSwitcher() {
  document.querySelectorAll('.service-switch-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.service === state.service);
  });
}

// Le switcher ne change PAS que l'affichage : il appelle l'API pour
// vraiment changer le service du tenant (les données de l'autre service
// restent en base, on peut revenir dessus n'importe quand).
document.querySelectorAll('.service-switch-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const wanted = btn.dataset.service;
    if (wanted === state.service) return;
    if (!confirm(`Basculer ce dashboard sur le service "${wanted === 'minecraft' ? 'Minecraft' : 'Discord'}" ?`)) return;
    document.querySelectorAll('.service-switch-btn').forEach((b) => (b.disabled = true));
    try {
      const data = await api('POST', '/api/service', { service: wanted });
      state.service = data.service;
      toast(`Service basculé sur ${state.service === 'minecraft' ? 'Minecraft' : 'Discord'}.`);
      window.location.reload();
    } catch (err) {
      toast(err.message, true);
    } finally {
      document.querySelectorAll('.service-switch-btn').forEach((b) => (b.disabled = false));
    }
  });
});

document.getElementById('logout-btn')?.addEventListener('click', async () => {
  await api('POST', '/api/logout');
  window.location.href = '/login';
});

// ── Utilisateur connecté (Discord) ─────────────────────────
async function loadMe() {
  try {
    const data = await api('GET', '/api/me');
    state.me = data.user;
    state.admins = data.admins;
    const avatar = document.getElementById('user-avatar');
    const name = document.getElementById('user-name');
    if (avatar) avatar.src = data.user.avatar;
    if (name) name.textContent = data.user.username;
  } catch {}
}

// ── Statut du bot ─────────────────────────────────────────
const STATUS_LABELS = {
  online: 'En ligne',
  connecting: 'Connexion…',
  offline: 'Hors ligne',
  error: 'Erreur',
};

async function refreshStatus() {
  try {
    const s = await api('GET', '/api/status');
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (dot) dot.className = `status-dot ${s.status}`;
    if (text) text.textContent = STATUS_LABELS[s.status] || s.status;

    const lines = [];
    lines.push(`<strong>Statut :</strong> ${STATUS_LABELS[s.status] || s.status}`);
    if (s.tag) lines.push(`<strong>Compte :</strong> <span class="mono">${escapeHtml(s.tag)}</span>`);
    if (s.guildCount) lines.push(`<strong>Serveurs :</strong> ${s.guildCount}`);
    if (s.ping !== null && s.ping >= 0) lines.push(`<strong>Latence :</strong> ${s.ping} ms`);
    if (s.lastError) lines.push(`<strong style="color:var(--coral)">Dernière erreur :</strong> ${escapeHtml(s.lastError)}`);
    
    const overviewStatus = document.getElementById('overview-status');
    if (overviewStatus) overviewStatus.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  } catch {}
}

// ── Chargement des settings ───────────────────────────────
async function loadSettings() {
  const data = await api('GET', '/api/settings');
  state.bot = data.bot;
  state.ticketTypes = data.ticketTypes;

  const tokenInput = document.getElementById('input-token');
  if (tokenInput) tokenInput.placeholder = data.hasToken ? data.bot.token : 'Colle ton token ici';

  const setInputValue = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
  };

  setInputValue('input-panel-title', data.bot.panelTitle);
  setInputValue('input-panel-desc', data.bot.panelDescription);
  setInputValue('input-panel-banner', data.bot.panelBanner);
  setInputValue('input-embed-color', data.bot.embedColor);
  setInputValue('input-footer', data.bot.footerText);

  renderTicketTypes();
}

async function loadGuilds() {
  state.guilds = await api('GET', '/api/discord/guilds');

  const panelGuildSelect = document.getElementById('select-panel-guild');
  const staffGuildSelect = document.getElementById('select-staff-guild');

  const opts = { value: (g) => g.id, label: (g) => g.name, placeholder: 'Sélectionner un serveur…' };
  fillSelect(panelGuildSelect, state.guilds, opts);
  fillSelect(staffGuildSelect, state.guilds, opts);

  if (panelGuildSelect) panelGuildSelect.value = state.bot.panelGuildId || '';
  if (staffGuildSelect) staffGuildSelect.value = state.bot.staffGuildId || '';

  if (state.guilds.length === 0) {
    toast("Le bot n'est connecté à aucun serveur pour l'instant.", true);
  }

  await Promise.all([onPanelGuildChange(false), onStaffGuildChange(false)]);
}

async function onPanelGuildChange(fromUser = true) {
  const guildSelect = document.getElementById('select-panel-guild');
  const channelSelect = document.getElementById('select-panel-channel');
  if (!guildSelect || !channelSelect) return;

  const guildId = guildSelect.value;
  if (!guildId) return fillSelect(channelSelect, [], { value: () => '', label: () => '', placeholder: 'Choisis un serveur d\'abord' });

  state.panelChannels = await api('GET', `/api/discord/guilds/${guildId}/channels`);
  fillSelect(channelSelect, state.panelChannels, {
    value: (c) => c.id,
    label: (c) => `#${c.name}`,
    placeholder: 'Sélectionner un salon…',
  });
  if (!fromUser) channelSelect.value = state.bot.panelChannelId || '';
  else channelSelect.value = '';
}

async function onStaffGuildChange(fromUser = true) {
  const guildSelect = document.getElementById('select-staff-guild');
  const categorySelect = document.getElementById('select-staff-category');
  if (!guildSelect || !categorySelect) return;

  const guildId = guildSelect.value;
  if (!guildId) {
    fillSelect(categorySelect, [], { value: () => '', label: () => '', placeholder: 'Choisis un serveur d\'abord' });
    state.staffRoles = [];
    state.staffCategories = [];
    renderTicketTypes();
    return;
  }

  const [categories, roles] = await Promise.all([
    api('GET', `/api/discord/guilds/${guildId}/categories`),
    api('GET', `/api/discord/guilds/${guildId}/roles`),
  ]);

  state.staffCategories = categories;
  state.staffRoles = roles;

  fillSelect(categorySelect, categories, {
    value: (c) => c.id,
    label: (c) => c.name,
    placeholder: 'Aucune catégorie (Par défaut)',
  });
  if (!fromUser) categorySelect.value = state.bot.staffCategoryId || '';
  else categorySelect.value = '';

  renderTicketTypes();
}

document.getElementById('select-panel-guild')?.addEventListener('change', () => onPanelGuildChange(true));
document.getElementById('select-staff-guild')?.addEventListener('change', () => onStaffGuildChange(true));

// ── Enregistrement token & config ─────────────────────────
// Attend que le bot passe à 'online' (ou 'error') au lieu de miser sur un
// délai fixe : la connexion à Discord peut prendre de 1 à plusieurs
// secondes selon le nombre de serveurs/le réseau, un setTimeout unique de
// 2.5s déclarait le bot "hors ligne" bien avant qu'il ait fini de se
// connecter, ce qui donnait l'impression que ça restait bloqué.
async function waitForBotOnline(timeoutMs = 20000, intervalMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await api('GET', '/api/status').catch(() => null);
    if (s && s.status === 'online') return s;
    if (s && s.status === 'error') return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return api('GET', '/api/status').catch(() => ({ status: 'connecting' }));
}

document.getElementById('save-token-btn')?.addEventListener('click', async () => {
  const token = document.getElementById('input-token').value.trim();
  if (!token) return toast('Colle un token avant de sauvegarder.', true);
  try {
    await api('POST', '/api/settings/bot', { token });
    toast('Token enregistré, connexion en cours…');
    document.getElementById('input-token').value = '';

    const finalStatus = await waitForBotOnline();
    await loadSettings();
    await loadGuilds();

    if (finalStatus.status !== 'online') {
      toast(
        finalStatus.lastError
          ? `La connexion du bot a échoué : ${finalStatus.lastError}`
          : "Le bot met plus de temps que prévu à se connecter, vérifie son statut dans \"Vue d'ensemble\".",
        true
      );
      return;
    }

    // Le bot vient de se connecter : on tente de republier le panel et on
    // remonte le vrai résultat, au lieu de laisser ça se passer
    // silencieusement en tâche de fond sans aucun retour visible.
    try {
      await api('POST', '/api/bot/refresh-panel');
      toast('Bot connecté, panel republié dans le salon configuré.');
    } catch (err) {
      toast(`Bot connecté, mais le panel n'a pas pu être envoyé : ${err.message}`, true);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('save-general-btn')?.addEventListener('click', async () => {
  const patch = {
    panelGuildId: document.getElementById('select-panel-guild').value,
    panelChannelId: document.getElementById('select-panel-channel').value,
    staffGuildId: document.getElementById('select-staff-guild').value,
    staffCategoryId: document.getElementById('select-staff-category').value,
    panelTitle: document.getElementById('input-panel-title').value,
    panelDescription: document.getElementById('input-panel-desc').value,
    panelBanner: document.getElementById('input-panel-banner').value,
    embedColor: document.getElementById('input-embed-color').value.replace('#', ''),
    footerText: document.getElementById('input-footer').value,
  };
  try {
    const res = await api('POST', '/api/settings/bot', patch);
    state.bot = { ...state.bot, ...res.bot };
    // res.panel contient le vrai résultat de la republication tentée côté
    // serveur juste après la sauvegarde (voir /api/settings/bot).
    if (res.panel && !res.panel.ok) {
      toast(`Configuration enregistrée, mais le panel n'a pas pu être republié : ${res.panel.reason}`, true);
    } else if (res.panel && res.panel.ok) {
      toast('Configuration enregistrée et panel republié.');
    } else {
      toast('Configuration enregistrée.');
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ── Actions rapides ────────────────────────────────────────
document.getElementById('refresh-panel-btn')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/bot/refresh-panel');
    toast('Panel republié.');
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('restart-bot-btn')?.addEventListener('click', async () => {
  try {
    toast('Reconnexion en cours…');
    await api('POST', '/api/bot/restart');
    setTimeout(refreshStatus, 1500);
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('diagnose-bot-btn')?.addEventListener('click', async () => {
  const out = document.getElementById('diagnose-result');
  const btn = document.getElementById('diagnose-bot-btn');
  if (out) {
    out.style.display = 'block';
    out.textContent = 'Diagnostic en cours (test token + réseau Discord)…';
  }
  if (btn) btn.disabled = true;
  try {
    const r = await api('GET', '/api/bot/diagnose');
    const lines = r.steps.map((s) => `${s.ok ? '✅' : '❌'} ${s.step} (${s.ms}ms)\n   ${s.detail}`);
    lines.push('', `→ ${r.verdict}`);
    if (out) out.textContent = lines.join('\n');
  } catch (err) {
    if (out) out.textContent = `Erreur : ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ── Types de tickets ───────────────────────────────────────
function roleNameById(id) {
  const r = state.staffRoles.find((r) => r.id === id);
  return r ? r.name : id;
}

function categoryNameById(id) {
  const c = state.staffCategories.find((cat) => cat.id === id);
  return c ? c.name : null;
}

function renderTicketTypes() {
  const container = document.getElementById('types-list');
  if (!container) return;
  container.innerHTML = '';

  if (state.ticketTypes.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🎟️</div>Aucun type de ticket. Clique sur "+ Nouveau type" pour commencer.</div>`;
    return;
  }

  for (const type of state.ticketTypes) {
    const el = document.createElement('div');
    el.className = 'ticket-stub';
    const roleChips = (type.allowedRoles || [])
      .map((rid) => `<span class="role-chip">${escapeHtml(roleNameById(rid))}</span>`)
      .join('');

    const specificCategory = type.categoryId ? categoryNameById(type.categoryId) : null;
    const catBadge = specificCategory 
      ? `<span class="badge-ultra" style="margin-left:8px;">📁 ${escapeHtml(specificCategory)}</span>` 
      : '';

    el.innerHTML = `
      <div class="stub-emoji">${escapeHtml(type.emoji) || '🎫'}</div>
      <div class="stub-body">
        <div class="stub-title-row">
          <span class="color-dot" style="background:#${(type.color || '5865F2').replace('#', '')}"></span>
          <span class="stub-title">${escapeHtml(type.label)}</span>
          <span class="stub-id mono">${escapeHtml(type.id)}</span>
          ${catBadge}
        </div>
        <div class="stub-desc">${escapeHtml(type.description || '')}</div>
        <div class="stub-roles">${roleChips || '<span class="field-hint">Aucun rôle assigné — personne ne verra ce ticket.</span>'}</div>
      </div>
      <div class="stub-actions">
        <button class="btn-ghost edit-type-btn">✏️ Modifier</button>
      </div>
    `;
    el.querySelector('.edit-type-btn').addEventListener('click', () => openTypeModal(type));
    container.appendChild(el);
  }
}

// ── Modal type de ticket ───────────────────────────────────
let selectedRoleIds = new Set();

function renderRolesPicker() {
  const picker = document.getElementById('type-roles-picker');
  if (!picker) return;
  picker.innerHTML = '';

  if (state.staffRoles.length === 0) {
    picker.innerHTML = `<span class="field-hint">Aucun rôle disponible — sélectionne d'abord un serveur staff connecté dans "Configuration générale".</span>`;
    return;
  }

  for (const role of state.staffRoles) {
    const label = document.createElement('label');
    label.className = 'role-option' + (selectedRoleIds.has(role.id) ? ' selected' : '');
    label.innerHTML = `<input type="checkbox" value="${role.id}" ${selectedRoleIds.has(role.id) ? 'checked' : ''}> ${escapeHtml(role.name)}`;
    label.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) selectedRoleIds.add(role.id);
      else selectedRoleIds.delete(role.id);
      label.classList.toggle('selected', e.target.checked);
    });
    picker.appendChild(label);
  }
}

function openTypeModal(type = null) {
  document.getElementById('type-modal-title').textContent = type ? 'Modifier le type de ticket' : 'Nouveau type de ticket';
  document.getElementById('type-original-id').value = type ? type.id : '';
  document.getElementById('type-emoji').value = type ? type.emoji : '';
  document.getElementById('type-label').value = type ? type.label : '';
  document.getElementById('type-id').value = type ? type.id : '';
  document.getElementById('type-id').disabled = !!type;
  document.getElementById('type-desc').value = type ? type.description : '';
  document.getElementById('type-color').value = type ? type.color : '5865F2';
  document.getElementById('type-delete-btn').style.display = type ? 'inline-flex' : 'none';

  const categorySelect = document.getElementById('type-category');
  if (categorySelect) {
    categorySelect.innerHTML = '<option value="">Utiliser la catégorie par défaut (Globale)</option>';
    
    if (state.staffCategories && state.staffCategories.length > 0) {
      state.staffCategories.forEach((cat) => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = `📁 ${cat.name}`;
        categorySelect.appendChild(opt);
      });
    }
    categorySelect.value = type ? (type.categoryId || '') : '';
  }

  const welcomeInput = document.getElementById('type-welcome-msg');
  if (welcomeInput) {
    welcomeInput.value = type ? (type.welcomeMessage || '') : '';
  }

  selectedRoleIds = new Set(type ? type.allowedRoles || [] : []);
  renderRolesPicker();

  document.getElementById('type-modal-backdrop')?.classList.add('show');
}

function closeTypeModal() {
  document.getElementById('type-modal-backdrop')?.classList.remove('show');
}

document.getElementById('add-type-btn')?.addEventListener('click', () => openTypeModal());
document.getElementById('type-cancel-btn')?.addEventListener('click', closeTypeModal);

document.getElementById('type-save-btn')?.addEventListener('click', async () => {
  const originalId = document.getElementById('type-original-id').value;
  const id = document.getElementById('type-id').value.trim().toLowerCase().replace(/\s+/g, '-');
  const label = document.getElementById('type-label').value.trim();
  const emoji = document.getElementById('type-emoji').value.trim();
  const description = document.getElementById('type-desc').value.trim();
  const color = document.getElementById('type-color').value.trim().replace('#', '') || '5865F2';
  
  const categoryId = document.getElementById('type-category')?.value || '';
  const welcomeMessage = document.getElementById('type-welcome-msg')?.value.trim() || '';

  if (!id || !label || !emoji) {
    return toast('Emoji, nom et identifiant sont obligatoires.', true);
  }
  // Miroir de lib/config.js#isValidEmoji côté serveur : évite un aller-retour
  // API inutile pour une erreur qu'on peut détecter tout de suite. La
  // validation serveur reste la source de vérité (voir /api/settings/ticket-types).
  const CUSTOM_EMOJI_RE = /^<a?:\w{2,32}:\d{17,20}>$/;
  const UNICODE_EMOJI_RE = /^(\p{Extended_Pictographic}\uFE0F?)(\u200d\p{Extended_Pictographic}\uFE0F?)*$/u;
  if (!CUSTOM_EMOJI_RE.test(emoji) && !UNICODE_EMOJI_RE.test(emoji)) {
    return toast(`Emoji invalide : "${emoji}". Utilise un emoji Unicode (ex: 🎫) ou un emoji du serveur (ex: <:nom:1234567890>).`, true);
  }

  const newType = { 
    id, 
    label, 
    emoji, 
    description, 
    color, 
    categoryId,
    welcomeMessage,
    allowedRoles: [...selectedRoleIds] 
  };

  let updated;
  if (originalId) {
    updated = state.ticketTypes.map((t) => (t.id === originalId ? newType : t));
  } else {
    if (state.ticketTypes.some((t) => t.id === id)) {
      return toast('Cet identifiant est déjà utilisé.', true);
    }
    updated = [...state.ticketTypes, newType];
  }

  try {
    const res = await api('POST', '/api/settings/ticket-types', { ticketTypes: updated });
    state.ticketTypes = res.ticketTypes;
    renderTicketTypes();
    closeTypeModal();
    toast('Type de ticket enregistré !');
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('type-delete-btn')?.addEventListener('click', async () => {
  const originalId = document.getElementById('type-original-id').value;
  if (!confirm('Supprimer ce type de ticket ? Les boutons du panel seront mis à jour.')) return;

  const updated = state.ticketTypes.filter((t) => t.id !== originalId);
  try {
    const res = await api('POST', '/api/settings/ticket-types', { ticketTypes: updated });
    state.ticketTypes = res.ticketTypes;
    renderTicketTypes();
    closeTypeModal();
    toast('Type de ticket supprimé.');
  } catch (err) {
    toast(err.message, true);
  }
});

// ── Statistiques ───────────────────────────────────────────
function typeLabel(typeId) {
  const t = state.ticketTypes.find((t) => t.id === typeId);
  return t ? `${t.emoji} ${t.label}` : typeId;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours} h ${remMins} min`;
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

async function loadStats() {
  let stats;
  try {
    stats = await api('GET', '/api/stats');
  } catch (err) {
    return toast(err.message, true);
  }

  const grid = document.getElementById('stat-grid');
  if (grid) {
    grid.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${stats.total}</div>
        <div class="stat-label">Tickets créés</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--green)">${stats.open}</div>
        <div class="stat-label">Actuellement ouverts</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.closed}</div>
        <div class="stat-label">Fermés</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:${stats.unclaimedOpen > 0 ? 'var(--amber)' : 'var(--text)'}">${stats.unclaimedOpen}</div>
        <div class="stat-label">Ouverts non pris en charge</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatDuration(stats.avgResolutionMs)}</div>
        <div class="stat-label">Temps de résolution moyen</div>
      </div>
    `;
  }

  const byTypeEl = document.getElementById('stat-by-type');
  if (byTypeEl) {
    const entries = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      byTypeEl.innerHTML = `<div class="empty-state"><div class="icon">📊</div>Aucun ticket pour l'instant.</div>`;
    } else {
      const max = Math.max(...entries.map(([, count]) => count));
      byTypeEl.innerHTML = entries
        .map(
          ([typeId, count]) => `
          <div class="bar-row">
            <div class="bar-label">${escapeHtml(typeLabel(typeId))}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${(count / max) * 100}%"></div></div>
            <div class="bar-count">${count}</div>
          </div>`
        )
        .join('');
    }
  }

  const recentEl = document.getElementById('stat-recent');
  if (recentEl) {
    if (stats.recent.length === 0) {
      recentEl.innerHTML = `<div class="empty-state"><div class="icon">🕓</div>Rien à afficher pour l'instant.</div>`;
    } else {
      recentEl.innerHTML = stats.recent
        .map(
          (t) => `
          <div class="activity-row">
            <span class="status-dot ${t.status === 'open' ? 'online' : 'offline'}"></span>
            <div class="activity-body">
              <div><strong>${escapeHtml(typeLabel(t.typeId))}</strong> — ${escapeHtml(t.userTag || 'inconnu')} <span class="stub-id mono">#${escapeHtml(t.id)}</span></div>
              <div class="field-hint" style="margin-top:2px;">
                ${t.status === 'open' ? `Ouvert le ${formatDate(t.createdAt)}` : `Fermé le ${formatDate(t.closedAt)}`}
                ${t.claimedByTag ? ` · pris en charge par ${escapeHtml(t.claimedByTag)}` : ''}
              </div>
            </div>
          </div>`
        )
        .join('');
    }
  }
}

document.getElementById('export-csv-btn')?.addEventListener('click', () => {
  window.location.href = '/api/tickets/export.csv';
});

// ── Tickets ouverts ─────────────────────────────────────────
function ticketStatusBadge(t) {
  const base = 'display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;color:#fff;';
  if (t.claimedByTag) {
    return `<span style="${base}background:var(--green);">Pris en charge · ${escapeHtml(t.claimedByTag)}</span>`;
  }
  return `<span style="${base}background:var(--amber);">Ouvert · non pris en charge</span>`;
}

async function loadOpenTickets() {
  const tbody = document.getElementById('open-tickets-list');
  if (!tbody) return;

  let tickets;
  try {
    tickets = await api('GET', '/api/tickets/open');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#e04b4b;padding:20px;">Erreur de chargement : ${escapeHtml(err.message)}</td></tr>`;
    return;
  }

  if (!tickets.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#888;padding:20px;">Aucun ticket ouvert pour l'instant.</td></tr>`;
    return;
  }

  tbody.innerHTML = tickets
    .map((t) => {
      const discordLink =
        t.guildId && t.channelId ? `https://discord.com/channels/${t.guildId}/${t.channelId}` : null;
      return `
        <tr>
          <td class="mono">#${escapeHtml(t.id)}</td>
          <td>${escapeHtml(t.userTag || 'inconnu')}</td>
          <td>${escapeHtml(typeLabel(t.typeId))}</td>
          <td>${ticketStatusBadge(t)}</td>
          <td>${discordLink ? `<a class="btn-ghost" href="${discordLink}" target="_blank" rel="noopener">Ouvrir sur Discord</a>` : '—'}</td>
        </tr>`;
    })
    .join('');
}

document.getElementById('refresh-open-tickets-btn')?.addEventListener('click', loadOpenTickets);

// ── Accès admin ─────────────────────────────────────────────
async function loadAdmins() {
  let data;
  try {
    data = await api('GET', '/api/admins');
  } catch (err) {
    return toast(err.message, true);
  }
  state.admins = data.adminIds;

  const list = document.getElementById('admins-list');
  if (!list) return;

  list.innerHTML = data.adminIds
    .map((id) => {
      const isSelf = id === data.selfId;
      return `
      <div class="admin-row">
        <span class="mono">${escapeHtml(id)}</span>
        ${isSelf ? '<span class="role-chip">Toi</span>' : ''}
        <button class="btn-ghost admin-remove-btn" data-id="${escapeHtml(id)}" ${data.adminIds.length <= 1 ? 'disabled' : ''}>Retirer</button>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.admin-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm("Retirer l'accès de cet administrateur ?")) return;
      try {
        await api('DELETE', `/api/admins/${btn.dataset.id}`);
        toast('Administrateur retiré.');
        loadAdmins();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// ── Journal d'activités (audit log) ───────────────────────
const AUDIT_ACTION_LABELS = {
  'admins.add': 'Administrateur ajouté',
  'admins.remove': 'Administrateur retiré',
  'admins.role_change': "Rôle d'un administrateur modifié",
  'settings.bot.update': 'Configuration du bot modifiée',
  'settings.dayz.update': 'Configuration DayZ modifiée',
};

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action;
}

async function loadAuditLog() {
  let data;
  try {
    data = await api('GET', '/api/audit-log?limit=100');
  } catch (err) {
    return toast(err.message, true);
  }

  const list = document.getElementById('audit-log-list');
  if (!list) return;

  if (!data.entries || data.entries.length === 0) {
    list.innerHTML = '<div class="audit-empty">Aucune action enregistrée pour l\'instant.</div>';
    return;
  }

  list.innerHTML = data.entries
    .map((e) => {
      const who = e.actorTag || e.actorDiscordId || 'Inconnu';
      const target = e.target ? ` · <span class="mono">${escapeHtml(e.target)}</span>` : '';
      const details = e.details ? `<div class="audit-row-details">${escapeHtml(JSON.stringify(e.details))}</div>` : '';
      return `
      <div class="audit-row">
        <svg class="icon-svg audit-row-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        <div class="audit-row-body">
          <div class="audit-row-action">${escapeHtml(auditActionLabel(e.action))}${target}</div>
          <div class="audit-row-meta">Par ${escapeHtml(who)} · ${formatDate(e.createdAt)}</div>
          ${details}
        </div>
      </div>`;
    })
    .join('');
}

document.getElementById('audit-refresh-btn')?.addEventListener('click', () => loadAuditLog());

document.getElementById('add-admin-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('input-new-admin');
  const id = input.value.trim();
  if (!/^\d{15,25}$/.test(id)) return toast('ID Discord invalide.', true);
  try {
    await api('POST', '/api/admins', { discordId: id });
    input.value = '';
    toast('Administrateur ajouté.');
    loadAdmins();
  } catch (err) {
    toast(err.message, true);
  }
});

// ── LIVE CONSOLE & SUPPORT DIRECT ─────────────────────────
window.activeTicketsData = {};

async function loadTickets() {
  const ticketSelect = document.getElementById('select-active-ticket');
  if (!ticketSelect) return;

  const previousValue = ticketSelect.value;

  try {
    const tickets = await api('GET', '/api/tickets/open');

    ticketSelect.innerHTML = '<option value="">-- Sélectionner un ticket ouvert --</option>';
    window.activeTicketsData = {};

    tickets.forEach((ticket) => {
      window.activeTicketsData[ticket.id] = ticket;
      const option = document.createElement('option');
      option.value = ticket.id;
      option.textContent = `#${ticket.id} — ${ticket.userTag || 'inconnu'} (${typeLabel(ticket.typeId)})`;
      ticketSelect.appendChild(option);
    });

    if ([...ticketSelect.options].some((o) => o.value === previousValue)) {
      ticketSelect.value = previousValue;
    }
  } catch (err) {
    console.error('Erreur de connexion au bot :', err);
    toast(err.message, true);
  }
}

async function renderMessages(ticketId) {
  const chatMessages = document.getElementById('chat-messages-container');
  if (!chatMessages) return;

  if (!ticketId) {
    chatMessages.innerHTML = '<p style="color:#777; text-align:center; margin:auto;">Sélectionne un ticket pour voir le fil de discussion...</p>';
    return;
  }

  chatMessages.innerHTML = '<p style="color:#777; text-align:center; margin:auto;">Chargement…</p>';

  let data;
  try {
    data = await api('GET', `/api/tickets/${encodeURIComponent(ticketId)}/messages`);
  } catch (err) {
    chatMessages.innerHTML = `<p style="color:#e04b4b; text-align:center; margin:auto;">${escapeHtml(err.message)}</p>`;
    return;
  }

  chatMessages.innerHTML = '';

  if (!data.messages.length) {
    chatMessages.innerHTML = '<p style="color:#777; text-align:center; margin:auto;">Aucun message pour l\'instant.</p>';
    return;
  }

  data.messages.forEach((msg) => {
    const msgDiv = document.createElement('div');
    msgDiv.style.padding = '8px 12px';
    msgDiv.style.borderRadius = '6px';
    msgDiv.style.marginBottom = '6px';
    msgDiv.style.maxWidth = '80%';
    msgDiv.style.fontSize = '13px';

    if (msg.from === 'staff') {
      msgDiv.style.background = 'rgba(88, 101, 242, 0.2)';
      msgDiv.style.borderLeft = '3px solid #5865f2';
      msgDiv.style.alignSelf = 'flex-end';
    } else if (msg.from === 'user') {
      msgDiv.style.background = 'rgba(87, 242, 135, 0.12)';
      msgDiv.style.borderLeft = '3px solid #57f287';
      msgDiv.style.alignSelf = 'flex-start';
    } else {
      msgDiv.style.background = 'rgba(255, 255, 255, 0.06)';
      msgDiv.style.borderLeft = '3px solid #666';
      msgDiv.style.alignSelf = 'center';
      msgDiv.style.fontStyle = 'italic';
      msgDiv.style.opacity = '0.8';
    }

    msgDiv.innerHTML = `<strong>${escapeHtml(msg.sender)}</strong> <span style="font-size:10px; color:#aaa; margin-left:6px;">${escapeHtml(msg.time)}</span><br>${escapeHtml(msg.text)}`;
    chatMessages.appendChild(msgDiv);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendMessage() {
  const ticketSelect = document.getElementById('select-active-ticket');
  const chatInput = document.getElementById('live-chat-input');

  const activeTicketId = ticketSelect?.value;
  const text = chatInput?.value.trim();

  if (!activeTicketId || !text) return;

  try {
    await api('POST', `/api/tickets/${encodeURIComponent(activeTicketId)}/reply`, { message: text });
    chatInput.value = '';
    await renderMessages(activeTicketId);
  } catch (err) {
    toast(err.message, true);
  }
}

// ── STUDIO, THÈMES & FOND D'ÉCRAN ─────────────────────────
function applyThemeConfig(config) {
  const previewBox = document.getElementById('wallpaper-preview');
  const wallpaperUrlInput = document.getElementById('input-wallpaper-url');
  const blurRange = document.getElementById('range-blur');
  const blurVal = document.getElementById('blur-val');
  const opacityRange = document.getElementById('range-opacity');
  const opacityVal = document.getElementById('opacity-val');

  if (config.wallpaper) {
    document.body.style.backgroundImage = `url('${config.wallpaper}')`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';

    if (previewBox) {
      previewBox.style.backgroundImage = `url('${config.wallpaper}')`;
      previewBox.textContent = '';
    }
    if (wallpaperUrlInput) wallpaperUrlInput.value = config.wallpaper;
  }

  if (config.blur !== undefined) {
    if (blurRange) blurRange.value = config.blur;
    if (blurVal) blurVal.textContent = config.blur;
    document.querySelectorAll('.panel, .sidebar').forEach((el) => {
      el.style.backdropFilter = `blur(${config.blur}px)`;
    });
  }

  if (config.opacity !== undefined) {
    if (opacityRange) opacityRange.value = config.opacity;
    if (opacityVal) opacityVal.textContent = config.opacity;
    const opacityHex = Math.round((config.opacity / 100) * 255).toString(16).padStart(2, '0');
    document.querySelectorAll('.panel').forEach((el) => {
      el.style.backgroundColor = `#18191c${opacityHex}`;
    });
  }
}

// ── INITIALISATION COMPLÈTE AU DOM ────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();

  // Live Console Events
  const ticketSelect = document.getElementById('select-active-ticket');
  const chatInput = document.getElementById('live-chat-input');
  const sendBtn = document.getElementById('send-chat-btn');
  const refreshChatBtn = document.getElementById('refresh-chat-btn');

  ticketSelect?.addEventListener('change', (e) => renderMessages(e.target.value));
  sendBtn?.addEventListener('click', sendMessage);
  chatInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  refreshChatBtn?.addEventListener('click', () => {
    loadTickets();
    if (ticketSelect?.value) renderMessages(ticketSelect.value);
  });

  // Theme Controls
  const blurRange = document.getElementById('range-blur');
  const opacityRange = document.getElementById('range-opacity');
  const wallpaperUrlInput = document.getElementById('input-wallpaper-url');
  const wallpaperFileInput = document.getElementById('input-wallpaper-file');
  const previewBox = document.getElementById('wallpaper-preview');

  blurRange?.addEventListener('input', (e) => {
    const val = e.target.value;
    const blurVal = document.getElementById('blur-val');
    if (blurVal) blurVal.textContent = val;
    document.querySelectorAll('.panel, .sidebar').forEach((el) => {
      el.style.backdropFilter = `blur(${val}px)`;
    });
  });

  opacityRange?.addEventListener('input', (e) => {
    const val = e.target.value;
    const opacityVal = document.getElementById('opacity-val');
    if (opacityVal) opacityVal.textContent = val;
    const opacityHex = Math.round((val / 100) * 255).toString(16).padStart(2, '0');
    document.querySelectorAll('.panel').forEach((el) => {
      el.style.backgroundColor = `#18191c${opacityHex}`;
    });
  });

  wallpaperUrlInput?.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    if (url && previewBox) {
      previewBox.style.backgroundImage = `url('${url}')`;
      previewBox.textContent = '';
    }
  });

  wallpaperFileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = event.target.result;
        if (previewBox) {
          previewBox.style.backgroundImage = `url('${result}')`;
          previewBox.textContent = '';
        }
        if (wallpaperUrlInput) wallpaperUrlInput.value = result;
      };
      reader.readAsDataURL(file);
    }
  });

  document.getElementById('save-theme-btn')?.addEventListener('click', () => {
    const config = {
      blur: blurRange?.value || 10,
      opacity: opacityRange?.value || 80,
      wallpaper: wallpaperUrlInput?.value || '',
    };
    localStorage.setItem('dashboard_theme_config', JSON.stringify(config));
    applyThemeConfig(config);
    toast('Thème enregistré avec succès !');
  });

  document.getElementById('reset-theme-btn')?.addEventListener('click', () => {
    localStorage.removeItem('dashboard_theme_config');
    location.reload();
  });

  // Restauration du thème sauvegardé
  const savedTheme = localStorage.getItem('dashboard_theme_config');
  if (savedTheme) {
    try {
      applyThemeConfig(JSON.parse(savedTheme));
    } catch {}
  }
});

// ── SERVEUR MINECRAFT ───────────────────────────────────────
let mcLogsPollTimer = null;
const MC_STATUS_LABELS = {
  stopped: 'Arrêté', starting: 'Démarrage…', running: 'En ligne',
  stopping: 'Arrêt en cours…', provisioning: 'Installation…', crashed: 'Erreur',
};

let mcSelectedEdition = 'java';

async function loadMinecraft() {
  try {
    const data = await api('GET', '/api/minecraft');
    state.minecraft = data;
    renderMinecraftPanel();
    if (data.config.created) {
      startMcLogsPolling();
      loadMcProperties();
      loadMcAdmins();
    } else {
      setMcEdition(data.config.edition || 'java');
      if (mcSelectedEdition === 'java') loadMcVersions();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ── Sélecteur Java / Bedrock du formulaire de création ─────────────
function setMcEdition(edition) {
  mcSelectedEdition = edition === 'bedrock' ? 'bedrock' : 'java';
  document.querySelectorAll('#mc-edition-toggle .mc-edition-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.edition === mcSelectedEdition);
  });

  const versionField = document.getElementById('mc-version-field');
  const sub = document.getElementById('mc-edition-sub');
  const portInput = document.getElementById('mc-port-input');
  const isBedrock = mcSelectedEdition === 'bedrock';

  if (versionField) versionField.style.display = isBedrock ? 'none' : '';
  if (sub) {
    sub.textContent = isBedrock
      ? "Le Bedrock Dedicated Server officiel (Mojang) est téléchargé automatiquement — toujours la dernière version, pas de choix à faire."
      : 'Le jar Paper officiel est téléchargé automatiquement pour la version choisie.';
  }
  // Change le port par défaut affiché uniquement s'il n'a pas déjà été
  // modifié à la main par l'utilisateur (on ne veut pas écraser sa saisie).
  if (portInput && (portInput.value === '25565' || portInput.value === '19132')) {
    portInput.value = isBedrock ? '19132' : '25565';
  }
}

document.getElementById('mc-edition-toggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.mc-edition-option');
  if (!btn) return;
  const wasJava = mcSelectedEdition === 'java';
  setMcEdition(btn.dataset.edition);
  if (mcSelectedEdition === 'java' && !wasJava) loadMcVersions();
});

function renderMcConnectionBox() {
  const box = document.getElementById('mc-connection-box');
  if (!box) return;
  const { connection } = state.minecraft;
  if (!connection) { box.style.display = 'none'; return; }
  box.style.display = '';
  const publicEl = document.getElementById('mc-ip-public');
  const localEl = document.getElementById('mc-ip-local');
  if (publicEl) publicEl.textContent = connection.publicIp ? `${connection.publicIp}:${connection.port}` : `${connection.localIp}:${connection.port}`;
  if (localEl) {
    localEl.textContent = connection.publicIp && connection.publicIp !== connection.localIp
      ? `Réseau local (LAN) : ${connection.localIp}:${connection.port}`
      : 'Ouvre/redirige ce port sur ton pare-feu ou ta box pour que tes joueurs puissent se connecter depuis internet.';
  }
}

document.getElementById('mc-ip-copy-btn')?.addEventListener('click', () => {
  const text = document.getElementById('mc-ip-public')?.textContent;
  if (!text || text === '—') return;
  navigator.clipboard?.writeText(text).then(() => toast('Adresse copiée.')).catch(() => {});
});

function renderMinecraftPanel() {
  const { config, runtime } = state.minecraft;
  const createBox = document.getElementById('mc-create-box');
  const manageBox = document.getElementById('mc-manage-box');
  if (!createBox || !manageBox) return;

  const isCreated = !!config.created;
  createBox.style.display = isCreated ? 'none' : '';
  manageBox.style.display = isCreated ? '' : 'none';

  // Copie autonome de la console (vue "Console Minecraft") : même logique
  // d'affichage, indépendante de l'onglet Configuration.
  const consoleBox = document.getElementById('mc-console-standalone-box');
  const consoleEmpty = document.getElementById('mc-console-standalone-empty');
  if (consoleBox) {
    document.getElementById('mc-console-2').style.display = isCreated ? '' : 'none';
    document.getElementById('mc-command-form-2').style.display = isCreated ? '' : 'none';
    if (consoleEmpty) consoleEmpty.style.display = isCreated ? 'none' : '';
  }
  if (!isCreated) return;

  const badge = document.getElementById('mc-status-badge');
  const badge2 = document.getElementById('mc-status-badge-2');
  [badge, badge2].forEach((el) => {
    if (!el) return;
    el.className = `mc-status-badge ${runtime.status}`;
    el.textContent = MC_STATUS_LABELS[runtime.status] || runtime.status;
  });
  const isBedrock = config.edition === 'bedrock';
  const nameLabel = isBedrock
    ? `${config.name} — port ${config.port}`
    : `${config.name} — ${config.mcVersion} (Paper) — port ${config.port}`;
  const nameEl = document.getElementById('mc-server-name');
  const nameEl2 = document.getElementById('mc-server-name-2');
  if (nameEl) nameEl.textContent = nameLabel;
  if (nameEl2) nameEl2.textContent = nameLabel;
  const editionBadge = document.getElementById('mc-edition-badge');
  const editionBadge2 = document.getElementById('mc-edition-badge-2');
  [editionBadge, editionBadge2].forEach((el) => {
    if (!el) return;
    el.className = `mc-edition-badge ${isBedrock ? 'bedrock' : 'java'}`;
    el.textContent = isBedrock ? 'Bedrock' : 'Java';
  });

  renderMcConnectionBox();

  const startBtn = document.getElementById('mc-start-btn');
  const stopBtn = document.getElementById('mc-stop-btn');
  const restartBtn = document.getElementById('mc-restart-btn');
  const running = runtime.status === 'running' || runtime.status === 'starting';
  if (startBtn) startBtn.disabled = running || runtime.status === 'stopping';
  if (stopBtn) stopBtn.disabled = !running;
  if (restartBtn) restartBtn.disabled = !running;
}

// ── Onglet "Configuration" : formulaire généré depuis le schéma renvoyé
// par l'API (une clé server.properties par champ), propre à l'édition
// (java/bedrock) du serveur du tenant. ──────────────────────────────
async function loadMcProperties() {
  const box = document.getElementById('mc-properties-box');
  if (!box) return;
  try {
    const data = await api('GET', '/api/minecraft/properties');
    renderMcPropertiesForm(data.schema, data.properties);
    box.style.display = '';
  } catch (err) {
    box.style.display = 'none';
  }
}

function renderMcPropertiesForm(schema, properties) {
  const container = document.getElementById('mc-properties-fields');
  if (!container) return;
  container.innerHTML = '';
  (schema || []).forEach((field) => {
    const value = properties?.[field.key] ?? '';
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.dataset.propKey = field.key;
    const inputId = `mc-prop-${field.key}`;

    if (field.type === 'bool') {
      wrap.classList.add('mc-prop-bool');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = inputId;
      input.checked = value === 'true';
      const label = document.createElement('label');
      label.htmlFor = inputId;
      label.style.margin = '0';
      label.textContent = field.label;
      wrap.append(input, label);
    } else {
      const label = document.createElement('label');
      label.htmlFor = inputId;
      label.textContent = field.label;
      wrap.appendChild(label);
      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        (field.options || []).forEach((o) => {
          const opt = document.createElement('option');
          opt.value = o;
          opt.textContent = o;
          opt.selected = o === value;
          input.appendChild(opt);
        });
      } else {
        input = document.createElement('input');
        input.type = field.type === 'number' ? 'number' : 'text';
        input.value = value;
      }
      input.id = inputId;
      wrap.appendChild(input);
    }
    container.appendChild(wrap);
  });
}

document.getElementById('mc-properties-save-btn')?.addEventListener('click', async () => {
  const container = document.getElementById('mc-properties-fields');
  const statusEl = document.getElementById('mc-properties-status');
  const btn = document.getElementById('mc-properties-save-btn');
  if (!container || !btn) return;
  const properties = {};
  container.querySelectorAll('[data-prop-key]').forEach((wrap) => {
    const key = wrap.dataset.propKey;
    const input = wrap.querySelector('input, select');
    if (!input) return;
    properties[key] = input.type === 'checkbox' ? (input.checked ? 'true' : 'false') : input.value;
  });
  btn.disabled = true;
  try {
    await api('POST', '/api/minecraft/properties', { properties });
    if (statusEl) {
      statusEl.textContent = 'Enregistré ✓ — redémarre le serveur pour appliquer les changements.';
      statusEl.style.color = 'var(--green)';
    }
    toast('Configuration enregistrée.');
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--coral)';
    }
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ── Panneau "Administrateurs" : liste de pseudos qui passent en Creative
// automatiquement à leur connexion (le reste des joueurs reste en Survie —
// voir MinecraftController._checkPlayerJoin côté serveur). ──────────────
let mcAdmins = [];

async function loadMcAdmins() {
  const box = document.getElementById('mc-admins-box');
  if (!box) return;
  try {
    const data = await api('GET', '/api/minecraft/admins');
    mcAdmins = data.admins || [];
    renderMcAdminList();
    box.style.display = '';
  } catch (err) {
    box.style.display = 'none';
  }
}

function renderMcAdminList() {
  const list = document.getElementById('mc-admin-list');
  if (!list) return;
  list.innerHTML = '';
  if (!mcAdmins.length) {
    const empty = document.createElement('div');
    empty.className = 'mc-admin-empty';
    empty.textContent = 'Aucun admin — tous les joueurs sont en Survie.';
    list.appendChild(empty);
    return;
  }
  mcAdmins.forEach((name) => {
    const chip = document.createElement('div');
    chip.className = 'mc-admin-chip';
    const label = document.createElement('span');
    label.textContent = name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'mc-admin-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Retirer';
    removeBtn.addEventListener('click', () => saveMcAdmins(mcAdmins.filter((a) => a !== name)));
    chip.append(label, removeBtn);
    list.appendChild(chip);
  });
}

async function saveMcAdmins(nextAdmins) {
  try {
    const data = await api('POST', '/api/minecraft/admins', { admins: nextAdmins });
    mcAdmins = data.admins || [];
    renderMcAdminList();
    toast('Liste des admins mise à jour.');
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('mc-admin-add-btn')?.addEventListener('click', () => {
  const input = document.getElementById('mc-admin-input');
  const name = input?.value.trim();
  if (!name) return;
  if (mcAdmins.some((a) => a.toLowerCase() === name.toLowerCase())) {
    toast('Ce pseudo est déjà admin.', true);
    return;
  }
  saveMcAdmins([...mcAdmins, name]);
  input.value = '';
});

document.getElementById('mc-admin-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('mc-admin-add-btn')?.click();
  }
});

// ── Console du serveur : conso CPU/RAM réelle (hôte + process suivi) ──
// Graphiques dessinés à la main sur <canvas> (pas de dépendance externe) :
// deux historiques glissants (CPU%, RAM Mo) redessinés à chaque sondage.
const scHistory = { cpu: [], mem: [] };
const SC_HISTORY_MAX = 60; // 60 points * 2s = 2 min d'historique affiché
let scPollTimer = null;

function loadServerConsole() {
  pollServerStats();
  if (scPollTimer) clearInterval(scPollTimer);
  scPollTimer = setInterval(pollServerStats, 2000);
}

async function pollServerStats() {
  try {
    const data = await api('GET', '/api/server/stats');
    renderServerStats(data);
  } catch {
    // Silencieux : on retentera au prochain tick.
  }
}

function renderServerStats(data) {
  const { host, process: proc } = data;

  const labelEl = document.getElementById('sc-proc-label');
  const statusEl = document.getElementById('sc-proc-status');
  const cpuEl = document.getElementById('sc-proc-cpu');
  const memEl = document.getElementById('sc-proc-mem');
  const hostMemEl = document.getElementById('sc-host-mem');
  const hostDetailsEl = document.getElementById('sc-host-details');

  if (labelEl) labelEl.textContent = proc?.label || '—';
  if (statusEl) {
    statusEl.textContent = proc?.running ? 'En ligne' : 'Hors ligne';
    statusEl.className = `mc-status-badge ${proc?.running ? 'running' : 'stopped'}`;
  }
  // statsUnavailable : le process tourne (running: true) mais la lecture
  // CPU/RAM a échoué côté serveur (ex: /proc absent sous Windows). On
  // l'affiche explicitement au lieu d'un "0%" trompeur ou d'un tiret qui
  // laisserait penser que le process est arrêté.
  if (cpuEl) cpuEl.textContent = proc?.statsUnavailable ? 'indisponible' : (proc ? `${proc.cpuPercent ?? 0}%` : '—');
  if (memEl) memEl.textContent = proc?.statsUnavailable ? 'indisponible' : (proc ? `${proc.memMb ?? 0} Mo` : '—');
  if (hostMemEl) hostMemEl.textContent = `${host.usedMb} / ${host.totalMb} Mo`;
  const loadBar = document.getElementById('sc-load-bar');
  const loadValue = document.getElementById('sc-load-value');
  if (loadBar) loadBar.style.width = `${Math.max(0, Math.min(100, host.loadPercent))}%`;
  if (loadValue) loadValue.textContent = `${host.loadPercent}%`;
  if (hostDetailsEl) {
    const hours = Math.floor(host.uptimeSec / 3600);
    hostDetailsEl.innerHTML = `
      <div>🧮 Cœurs CPU : <b>${host.cpuCount}</b></div>
      <div>📈 Load average (1 min) : <b>${host.loadAvg[0].toFixed(2)}</b></div>
      <div>⏱️ Uptime de l'hôte : <b>${hours}h</b></div>
    `;
  }

  // On alimente les graphiques dès qu'on a un `proc` avec une mesure fiable :
  // - proc null (aucun process suivi du tout) → rien à tracer.
  // - statsUnavailable (mesure impossible, ex: /proc absent) → on ne pousse
  //   rien plutôt que de mentir avec un faux 0.
  // - proc.running === false (serveur arrêté) → on pousse quand même 0 :
  //   le graphique doit rester "fonctionnel" et continuer à tracer une
  //   ligne (plate à 0) plutôt que de rester bloqué indéfiniment sur
  //   "En attente de données" simplement parce que le serveur est éteint.
  if (proc && !proc.statsUnavailable) {
    scHistory.cpu.push(proc.cpuPercent ?? 0);
    scHistory.mem.push(proc.memMb ?? 0);
    if (scHistory.cpu.length > SC_HISTORY_MAX) scHistory.cpu.shift();
    if (scHistory.mem.length > SC_HISTORY_MAX) scHistory.mem.shift();
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  drawLineChart(document.getElementById('sc-chart-cpu'), scHistory.cpu, {
    color: cssVar('--cyan'), suffix: '%', min: 0, max: 100,
  });
  drawLineChart(document.getElementById('sc-chart-mem'), scHistory.mem, {
    color: cssVar('--amber'), suffix: ' Mo', min: 0,
  });
}

// Petit line-chart "maison" : pas de lib externe, juste un canvas redessiné
// à chaque sondage. `opts.max` fixe le plafond de l'axe Y (sinon calculé
// depuis les données, avec un peu de marge au-dessus du pic). La courbe est
// lissée (segments arrondis via quadraticCurveTo, technique du "midpoint")
// et remplie d'un dégradé doux, dans le même esprit que le graphique
// "Historique des joueurs" d'un panel de stats classique.
function drawLineChart(canvas, points, opts = {}) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(rect.width, 100);
  const h = Math.max(rect.height, 100);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padding = { top: 16, right: 12, bottom: 22, left: 42 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  if (!points.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '13px Inter, sans-serif';
    ctx.fillText('En attente de données…', padding.left, h / 2);
    return;
  }

  const dataMax = Math.max(...points, 1);
  const max = opts.max ?? Math.ceil(dataMax * 1.25);
  const min = opts.min ?? 0;
  const color = opts.color || '#0f9c8f';

  const xAt = (i) => padding.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v) => padding.top + plotH - ((v - min) / Math.max(1, max - min)) * plotH;
  const xs = points.map((_, i) => xAt(i));
  const ys = points.map((v) => yAt(v));

  // Grille horizontale + labels (0%, 50%, 100% de l'échelle)
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '11px Inter, sans-serif';
  ctx.lineWidth = 1;
  [0, 0.5, 1].forEach((ratio) => {
    const y = padding.top + plotH * (1 - ratio);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
    const value = Math.round(min + (max - min) * ratio);
    ctx.fillText(`${value}${opts.suffix || ''}`, 2, y + 4);
  });

  // Trace un chemin lissé passant par tous les points : chaque segment est
  // une courbe quadratique dont le point de contrôle est le point de
  // données lui-même et le point d'arrivée le milieu du segment suivant —
  // ça arrondit les angles sans faire "déborder" la courbe au-delà des
  // valeurs réelles (contrairement à un vrai Catmull-Rom).
  const tracePath = () => {
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 0; i < xs.length - 1; i++) {
      const midX = (xs[i] + xs[i + 1]) / 2;
      const midY = (ys[i] + ys[i + 1]) / 2;
      ctx.quadraticCurveTo(xs[i], ys[i], midX, midY);
    }
    ctx.lineTo(xs[xs.length - 1], ys[xs.length - 1]);
  };

  // Zone remplie sous la courbe, en dégradé (opaque en haut, transparent
  // en bas) pour un rendu plus doux qu'un simple aplat de couleur.
  tracePath();
  ctx.lineTo(xs[xs.length - 1], padding.top + plotH);
  ctx.lineTo(xs[0], padding.top + plotH);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
  gradient.addColorStop(0, color.startsWith('#') ? `${color}40` : color); // ~25%
  gradient.addColorStop(1, color.startsWith('#') ? `${color}00` : color); // 0%
  ctx.fillStyle = gradient;
  ctx.fill();

  // Ligne de la courbe (lissée)
  tracePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Point + valeur courante en fin de courbe
  const lastX = xs[xs.length - 1];
  const lastY = ys[ys.length - 1];
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '12px Inter, sans-serif';
  const label = `${Math.round(points[points.length - 1] * 10) / 10}${opts.suffix || ''}`;
  ctx.fillText(label, Math.min(lastX + 6, w - ctx.measureText(label).width - 4), Math.max(lastY - 6, 14));
}

async function loadMcVersions() {
  const select = document.getElementById('mc-version-select');
  if (!select) return;
  select.innerHTML = '<option>Chargement des versions…</option>';
  try {
    const versions = await api('GET', '/api/minecraft/versions');
    select.innerHTML = '';
    versions.slice(0, 40).forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });
  } catch (err) {
    select.innerHTML = '<option value="">Impossible de charger les versions</option>';
  }
}

document.getElementById('mc-create-btn')?.addEventListener('click', async () => {
  const name = document.getElementById('mc-name-input')?.value.trim() || 'Mon serveur';
  const edition = mcSelectedEdition === 'bedrock' ? 'bedrock' : 'java';
  const mcVersion = document.getElementById('mc-version-select')?.value;
  const memoryMb = parseInt(document.getElementById('mc-memory-input')?.value, 10) || 1024;
  const port = parseInt(document.getElementById('mc-port-input')?.value, 10) || (edition === 'bedrock' ? 19132 : 25565);
  if (edition === 'java' && !mcVersion) return toast('Choisis une version Minecraft.', true);

  const btn = document.getElementById('mc-create-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Installation en cours…'; }
  try {
    await api('POST', '/api/minecraft/create', { name, edition, mcVersion, memoryMb, port });
    toast('Serveur installé — tu peux le démarrer.');
    await loadMinecraft();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Installer le serveur'; }
  }
});

document.getElementById('mc-start-btn')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/minecraft/start');
    toast('Démarrage du serveur…');
    startMcLogsPolling();
    setTimeout(loadMinecraft, 1500);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('mc-stop-btn')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/minecraft/stop');
    toast('Arrêt du serveur…');
    setTimeout(loadMinecraft, 1500);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('mc-restart-btn')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/minecraft/restart');
    toast('Redémarrage du serveur…');
    setTimeout(loadMinecraft, 1500);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('mc-delete-btn')?.addEventListener('click', async () => {
  if (!confirm('Supprimer définitivement ce serveur (monde, plugins, config) ?')) return;
  try {
    await api('DELETE', '/api/minecraft');
    toast('Serveur supprimé.');
    stopMcLogsPolling();
    await loadMinecraft();
  } catch (err) { toast(err.message, true); }
});

document.querySelectorAll('.mc-command-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('.mc-command-input');
    const command = input?.value.trim();
    if (!command) return;

    // Petite commande utilitaire côté dashboard (pas envoyée au process
    // Minecraft) : affiche direct l'adresse de connexion dans la console
    // (celle du formulaire qui a servi à l'envoyer — config ou standalone).
    if (/^\/?ip$/i.test(command)) {
      const box = form.closest('.panel')?.querySelector('.mc-console');
      const { connection } = state.minecraft;
      const line = connection
        ? `[Dashboard] Adresse de connexion : ${connection.publicIp || connection.localIp}:${connection.port}`
        : '[Dashboard] Adresse indisponible pour le moment.';
      if (box) { box.textContent += `\n${line}`; box.scrollTop = box.scrollHeight; }
      input.value = '';
      return;
    }

    try {
      await api('POST', '/api/minecraft/command', { command });
      input.value = '';
    } catch (err) { toast(err.message, true); }
  });
});

function startMcLogsPolling() {
  stopMcLogsPolling();
  pollMcLogs();
  mcLogsPollTimer = setInterval(pollMcLogs, 2000);
}
function stopMcLogsPolling() {
  if (mcLogsPollTimer) clearInterval(mcLogsPollTimer);
  mcLogsPollTimer = null;
}
async function pollMcLogs() {
  // .mc-console existe désormais en double (onglet Configuration + onglet
  // Console dédié) : on met à jour toutes les instances trouvées dans le DOM.
  const boxes = document.querySelectorAll('.mc-console');
  if (!boxes.length) return;
  try {
    const { logs } = await api('GET', '/api/minecraft/logs');
    const text = logs.join('\n');
    boxes.forEach((box) => {
      const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
      box.textContent = text;
      if (wasAtBottom) box.scrollTop = box.scrollHeight;
    });
  } catch {}
}

// ── GESTIONNAIRE DE FICHIERS (Discord & Minecraft) ──────────
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

async function loadFiles(relPath) {
  state.files.path = relPath || '';
  state.files.openFile = null;
  renderFileEditor();
  try {
    const { items } = await api('GET', `/api/files?path=${encodeURIComponent(state.files.path)}`);
    state.files.items = items;
    renderFileList();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderBreadcrumb() {
  const el = document.getElementById('fm-breadcrumb');
  if (!el) return;
  const parts = state.files.path.split('/').filter(Boolean);
  let acc = '';
  const crumbs = [`<span data-path="">racine</span>`];
  for (const part of parts) {
    acc += (acc ? '/' : '') + part;
    crumbs.push(`<span data-path="${escapeHtml(acc)}">${escapeHtml(part)}</span>`);
  }
  el.innerHTML = crumbs.join(' / ');
  el.querySelectorAll('span[data-path]').forEach((span) => {
    span.addEventListener('click', () => loadFiles(span.dataset.path));
  });
}

function renderFileList() {
  renderBreadcrumb();
  const list = document.getElementById('fm-list');
  if (!list) return;
  if (!state.files.items.length) {
    list.innerHTML = '<div class="fm-row"><span class="fm-name" style="opacity:.6">Dossier vide.</span></div>';
    return;
  }
  list.innerHTML = state.files.items.map((item) => `
    <div class="fm-row" data-name="${escapeHtml(item.name)}" data-dir="${item.isDir}" data-editable="${item.editable}">
      <span>${item.isDir ? '📁' : '📄'}</span>
      <span class="fm-name">${escapeHtml(item.name)}</span>
      ${!item.isDir ? `<span class="fm-size">${humanSize(item.size)}</span>` : ''}
      <button class="btn-ghost fm-delete-btn" type="button" style="padding:2px 8px;">Suppr.</button>
    </div>
  `).join('');

  list.querySelectorAll('.fm-row').forEach((row) => {
    const name = row.dataset.name;
    const isDir = row.dataset.dir === 'true';
    const editable = row.dataset.editable === 'true';
    const childPath = state.files.path ? `${state.files.path}/${name}` : name;

    row.addEventListener('click', (e) => {
      if (e.target.closest('.fm-delete-btn')) return;
      if (isDir) return loadFiles(childPath);
      if (editable) return openFileForEdit(childPath);
      toast('Ce type de fichier ne peut pas être édité en ligne — utilise le téléchargement/upload.');
    });
    row.querySelector('.fm-delete-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Supprimer "${name}" ?`)) return;
      try {
        await api('DELETE', `/api/files?path=${encodeURIComponent(childPath)}`);
        await loadFiles(state.files.path);
      } catch (err) { toast(err.message, true); }
    });
  });
}

async function openFileForEdit(relPath) {
  try {
    const { content } = await api('GET', `/api/files/content?path=${encodeURIComponent(relPath)}`);
    state.files.openFile = relPath;
    renderFileEditor(content);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderFileEditor(content) {
  const wrap = document.getElementById('fm-editor-wrap');
  const editor = document.getElementById('fm-editor');
  const label = document.getElementById('fm-editor-filename');
  if (!wrap || !editor) return;
  if (!state.files.openFile) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  if (label) label.textContent = state.files.openFile;
  editor.value = content ?? editor.value;
}

document.getElementById('fm-save-btn')?.addEventListener('click', async () => {
  if (!state.files.openFile) return;
  try {
    await api('POST', '/api/files/content', {
      path: state.files.openFile,
      content: document.getElementById('fm-editor')?.value ?? '',
    });
    toast('Fichier enregistré.');
  } catch (err) { toast(err.message, true); }
});

document.getElementById('fm-close-editor-btn')?.addEventListener('click', () => {
  state.files.openFile = null;
  renderFileEditor();
});

document.getElementById('fm-new-folder-btn')?.addEventListener('click', async () => {
  const name = prompt('Nom du nouveau dossier :');
  if (!name) return;
  const target = state.files.path ? `${state.files.path}/${name}` : name;
  try {
    await api('POST', '/api/files/mkdir', { path: target });
    await loadFiles(state.files.path);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('fm-upload-input')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) {
    toast('Fichier trop volumineux (max 60 Mo par upload).', true);
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = String(reader.result).split(',')[1];
    const target = state.files.path ? `${state.files.path}/${file.name}` : file.name;
    try {
      await api('POST', '/api/files/upload', { path: target, base64 });
      toast('Fichier envoyé.');
      await loadFiles(state.files.path);
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsDataURL(file);
});

// ── Module DayZ ─────────────────────────────────────────────
state.dayz = { safeZones: [], staffWhitelist: [] };

function fmtPlaytime(seconds) {
  const h = Math.floor((seconds || 0) / 3600);
  const m = Math.floor(((seconds || 0) % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}`;
}

async function loadDayz() {
  let data;
  try {
    data = await api('GET', '/api/dayz/settings');
  } catch (err) {
    return toast(err.message, true);
  }
  state.dayz = data;

  document.getElementById('dayz-enabled-toggle').checked = !!data.enabled;
  document.getElementById('dayz-currency-input').value = data.currencySymbol || '💰';
  document.getElementById('dayz-rcon-host').value = data.rcon?.host || '';
  document.getElementById('dayz-rcon-port').value = data.rcon?.port || 2302;
  document.getElementById('dayz-rcon-password').value = '';
  document.getElementById('dayz-rcon-password').placeholder = data.rcon?.password ? data.rcon.password : '••••••••';
  document.getElementById('dayz-log-dir').value = data.admLogDir || '';

  const guildSelect = document.getElementById('select-dayz-guild');
  const opts = { value: (g) => g.id, label: (g) => g.name, placeholder: 'Même serveur que le panel de tickets' };
  fillSelect(guildSelect, state.guilds || [], opts);
  guildSelect.value = data.commandsGuildId || '';

  renderDayzZones();
  renderDayzStaff();
  await Promise.all([loadDayzLeaderboard(), loadDayzBanLog(), loadDayzNitradoStatus()]);
}

// ── Liaison compte Nitrado ───────────────────────────────────
async function loadDayzNitradoStatus() {
  let n;
  try {
    n = await api('GET', '/api/dayz/nitrado');
  } catch (err) {
    return; // pas bloquant pour le reste du panneau
  }
  state.dayzNitrado = n;
  renderDayzNitradoStatus();
}

function renderDayzNitradoStatus() {
  const box = document.getElementById('dayz-nitrado-status');
  const linkedActions = document.getElementById('dayz-nitrado-linked-actions');
  if (!box) return;
  const n = state.dayzNitrado || {};

  if (n.linked) {
    const syncedAt = n.lastSyncAt ? new Date(n.lastSyncAt).toLocaleString('fr-FR') : 'jamais';
    const warning = n.lastSyncError ? `<br><span style="color:#faa61a;">⚠️ Infos manquantes côté Nitrado : ${escapeHtml(n.lastSyncError)} — complète-les dans "Connexion manuelle" ci-dessous.</span>` : '';
    box.innerHTML = `<span style="color:#57f287;">✅ Compte Nitrado lié</span> — dernière synchro : ${syncedAt}${warning}`;
    linkedActions.style.display = '';
  } else {
    box.innerHTML = `<span style="color:#b5bac1;">Aucun compte Nitrado lié pour l'instant.</span>`;
    linkedActions.style.display = 'none';
  }
}

function applyDayzSyncResult(dayzData) {
  state.dayz = { ...state.dayz, ...dayzData };
  state.dayzNitrado = dayzData.nitrado || state.dayzNitrado;
  document.getElementById('dayz-rcon-host').value = dayzData.rcon?.host || '';
  document.getElementById('dayz-rcon-port').value = dayzData.rcon?.port || 2302;
  document.getElementById('dayz-rcon-password').value = '';
  document.getElementById('dayz-rcon-password').placeholder = dayzData.rcon?.password || '••••••••';
  document.getElementById('dayz-log-dir').value = dayzData.admLogDir || '';
  renderDayzNitradoStatus();
}

document.getElementById('dayz-nitrado-link-btn')?.addEventListener('click', async (e) => {
  const token = document.getElementById('dayz-nitrado-token').value.trim();
  if (!token) return toast('Colle ton token API Nitrado.', true);
  e.target.disabled = true;
  try {
    const res = await api('POST', '/api/dayz/nitrado/link', { token });
    const select = document.getElementById('dayz-nitrado-service-select');
    fillSelect(select, res.services || [], {
      value: (s) => s.id,
      label: (s) => `${s.game || 'Service'} — ${s.address || s.id} (${s.status})`,
    });
    document.getElementById('dayz-nitrado-services').style.display = res.services?.length ? '' : 'none';
    if (!res.services?.length) toast('Token valide, mais aucun service trouvé sur ce compte.', true);
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('dayz-nitrado-select-btn')?.addEventListener('click', async (e) => {
  const token = document.getElementById('dayz-nitrado-token').value.trim();
  const serviceId = document.getElementById('dayz-nitrado-service-select').value;
  if (!token || !serviceId) return toast('Choisis un serveur dans la liste.', true);
  e.target.disabled = true;
  try {
    const res = await api('POST', '/api/dayz/nitrado/select', { token, serviceId });
    applyDayzSyncResult(res.dayz);
    document.getElementById('dayz-nitrado-token').value = '';
    document.getElementById('dayz-nitrado-services').style.display = 'none';
    toast(res.warning || 'Compte Nitrado lié et synchronisé.', !!res.warning);
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('dayz-nitrado-sync-btn')?.addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const res = await api('POST', '/api/dayz/nitrado/sync', {});
    applyDayzSyncResult(res.dayz);
    toast('Synchronisation Nitrado effectuée.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('dayz-nitrado-unlink-btn')?.addEventListener('click', async (e) => {
  if (!confirm('Délier ce compte Nitrado ? Le RCon manuel restera tel quel.')) return;
  e.target.disabled = true;
  try {
    const res = await api('DELETE', '/api/dayz/nitrado');
    state.dayzNitrado = res.dayz.nitrado;
    renderDayzNitradoStatus();
    toast('Compte Nitrado délié.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('dayz-enabled-toggle')?.addEventListener('change', async (e) => {
  try {
    const updated = await api('POST', '/api/dayz/settings', { enabled: e.target.checked });
    state.dayz = updated.dayz;
    toast(e.target.checked ? 'Module DayZ activé.' : 'Module DayZ désactivé.');
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message, true);
  }
});

document.getElementById('dayz-save-connection-btn')?.addEventListener('click', async () => {
  const patch = {
    currencySymbol: document.getElementById('dayz-currency-input').value.trim() || '💰',
    commandsGuildId: document.getElementById('select-dayz-guild').value,
    admLogDir: document.getElementById('dayz-log-dir').value.trim(),
    rcon: {
      host: document.getElementById('dayz-rcon-host').value.trim(),
      port: Number(document.getElementById('dayz-rcon-port').value) || 2302,
      password: document.getElementById('dayz-rcon-password').value || document.getElementById('dayz-rcon-password').placeholder,
    },
  };
  try {
    const updated = await api('POST', '/api/dayz/settings', patch);
    state.dayz = updated.dayz;
    document.getElementById('dayz-rcon-password').value = '';
    document.getElementById('dayz-rcon-password').placeholder = updated.dayz.rcon.password || '••••••••';
    toast('Connexion DayZ enregistrée.');
  } catch (err) {
    toast(err.message, true);
  }
});

function renderDayzZones() {
  const list = document.getElementById('dayz-zones-list');
  if (!list) return;
  const zones = state.dayz.safeZones || [];
  if (!zones.length) {
    list.innerHTML = '<p class="field-hint" style="margin:0;">Aucune safe zone configurée.</p>';
    return;
  }
  list.innerHTML = zones
    .map(
      (z) => `
      <div class="admin-row">
        <span><strong>${escapeHtml(z.name)}</strong> — X:${escapeHtml(String(z.x))} Z:${escapeHtml(String(z.z))} — rayon ${escapeHtml(String(z.radius))}m</span>
        <button class="btn-ghost dayz-zone-remove-btn" data-id="${escapeHtml(z.id)}">Retirer</button>
      </div>`
    )
    .join('');

  list.querySelectorAll('.dayz-zone-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Retirer cette safe zone ?')) return;
      try {
        const res = await api('DELETE', `/api/dayz/safezones/${btn.dataset.id}`);
        state.dayz.safeZones = res.safeZones;
        renderDayzZones();
        toast('Safe zone retirée.');
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

document.getElementById('dayz-add-zone-btn')?.addEventListener('click', async () => {
  const name = document.getElementById('dayz-zone-name').value.trim();
  const x = Number(document.getElementById('dayz-zone-x').value);
  const z = Number(document.getElementById('dayz-zone-z').value);
  const radius = Number(document.getElementById('dayz-zone-radius').value);
  if (!name || Number.isNaN(x) || Number.isNaN(z) || Number.isNaN(radius)) {
    return toast('Renseigne un nom et des coordonnées/rayon valides.', true);
  }
  try {
    const res = await api('POST', '/api/dayz/safezones', { name, x, z, radius });
    state.dayz.safeZones = res.safeZones;
    renderDayzZones();
    ['dayz-zone-name', 'dayz-zone-x', 'dayz-zone-z', 'dayz-zone-radius'].forEach((id) => (document.getElementById(id).value = ''));
    toast('Safe zone ajoutée.');
  } catch (err) {
    toast(err.message, true);
  }
});

function renderDayzStaff() {
  const list = document.getElementById('dayz-staff-list');
  if (!list) return;
  const staff = state.dayz.staffWhitelist || [];
  if (!staff.length) {
    list.innerHTML = '<p class="field-hint" style="margin:0;">Aucun staff DayZ ajouté (les admins du dashboard ont déjà accès).</p>';
    return;
  }
  list.innerHTML = staff
    .map(
      (id) => `
      <div class="admin-row">
        <span class="mono">${escapeHtml(id)}</span>
        <button class="btn-ghost dayz-staff-remove-btn" data-id="${escapeHtml(id)}">Retirer</button>
      </div>`
    )
    .join('');

  list.querySelectorAll('.dayz-staff-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await api('DELETE', `/api/dayz/staff/${btn.dataset.id}`);
        state.dayz.staffWhitelist = res.staffWhitelist;
        renderDayzStaff();
        toast('Staff retiré.');
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

document.getElementById('dayz-add-staff-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('dayz-staff-input');
  const id = input.value.trim();
  if (!/^\d{15,25}$/.test(id)) return toast('ID Discord invalide.', true);
  try {
    const res = await api('POST', '/api/dayz/staff', { discordId: id });
    state.dayz.staffWhitelist = res.staffWhitelist;
    renderDayzStaff();
    input.value = '';
    toast('Staff ajouté.');
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadDayzLeaderboard() {
  const list = document.getElementById('dayz-leaderboard-list');
  if (!list) return;
  const type = document.getElementById('dayz-leaderboard-type').value;
  let data;
  try {
    data = await api('GET', `/api/dayz/leaderboard?type=${type}`);
  } catch (err) {
    return toast(err.message, true);
  }
  if (!data.rows.length) {
    list.innerHTML = '<p class="field-hint" style="margin:0;">Aucune donnée pour le moment.</p>';
    return;
  }
  const currency = state.dayz.currencySymbol || '💰';
  list.innerHTML = `<div class="tickets-table"><table><thead><tr>
    <th>#</th><th>Joueur</th><th>Discord</th>
    ${type === 'money' ? '<th>Solde</th>' : ''}
    ${type === 'kills' ? '<th>Kills</th><th>Deaths</th>' : ''}
    ${type === 'ratio' ? '<th>Ratio</th><th>K/D</th>' : ''}
  </tr></thead><tbody>
    ${data.rows
      .map(
        (r, i) => `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(r.player_name || r.steam_id)}</td>
          <td>${r.discord_id ? `<@${escapeHtml(r.discord_id)}>` : '—'}</td>
          ${type === 'money' ? `<td>${r.balance} ${currency}</td>` : ''}
          ${type === 'kills' ? `<td>${r.kills}</td><td>${r.deaths}</td>` : ''}
          ${type === 'ratio' ? `<td>${Number(r.ratio).toFixed(2)}</td><td>${r.kills}/${r.deaths}</td>` : ''}
        </tr>`
      )
      .join('')}
  </tbody></table></div>`;
}

document.getElementById('dayz-leaderboard-type')?.addEventListener('change', loadDayzLeaderboard);

async function loadDayzBanLog() {
  const list = document.getElementById('dayz-banlog-list');
  if (!list) return;
  let data;
  try {
    data = await api('GET', '/api/dayz/ban-log');
  } catch (err) {
    return toast(err.message, true);
  }
  if (!data.rows.length) {
    list.innerHTML = '<p class="field-hint" style="margin:0;">Aucun ban automatique pour le moment.</p>';
    return;
  }
  list.innerHTML = data.rows
    .map(
      (r) => `
      <div class="admin-row" style="align-items:flex-start;">
        <div>
          <strong>${escapeHtml(r.player_name || r.steam_id)}</strong> (<span class="mono">${escapeHtml(r.steam_id)}</span>)
          <div class="field-hint" style="margin:2px 0 0;">${escapeHtml(r.reason || '')} · ${new Date(r.created_at).toLocaleString('fr-FR')}</div>
        </div>
        <span class="mc-status-badge" style="background:${r.rcon_ok ? 'rgba(87,242,135,0.15)' : 'rgba(255,77,77,0.15)'}; color:${r.rcon_ok ? 'var(--green)' : 'var(--coral)'};">
          ${r.rcon_ok ? 'Ban confirmé' : 'Échec RCon'}
        </span>
      </div>`
    )
    .join('');
}

// ── Démarrage Système ──────────────────────────────────────
(async function init() {
  await loadMe();

  try {
    const svc = await api('GET', '/api/service');
    state.service = svc.service || 'discord';
  } catch {
    state.service = 'discord';
  }
  applyServiceVisibility();

  await refreshStatus();

  if (state.service === 'minecraft') {
    setInterval(refreshStatus, 5000);
    return;
  }

  await loadSettings();
  await loadGuilds();
  setInterval(refreshStatus, 5000);
})();