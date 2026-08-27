const { EmbedBuilder } = require('discord.js');

// ─────────────────────────────────────────────────────────
// Toutes les fonctions ci-dessous prennent désormais le TenantStore
// du client concerné EN PARAMÈTRE, au lieu d'importer un store global
// singleton. C'est ce qui garantit que le bot du client A ne peut
// jamais lire/afficher la config du client B : il n'y a plus de
// variable globale partagée à s'emmêler.
// ─────────────────────────────────────────────────────────

function getTicketTypes(store) {
  return store.getTicketTypes();
}

function getTicketType(store, id) {
  return getTicketTypes(store).find((t) => t.id === id) || null;
}

function getAllKnownRoles(store) {
  return store.getAllKnownRoleIds();
}

function safeColor(hex, fallback = 0x5865f2) {
  if (!hex) return fallback;
  const parsed = parseInt(String(hex).replace('#', ''), 16);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const CUSTOM_EMOJI_RE = /^<a?:\w{2,32}:\d{17,20}>$/;
const UNICODE_EMOJI_RE =
  /^(\p{Extended_Pictographic}\uFE0F?)(\u200d\p{Extended_Pictographic}\uFE0F?)*$/u;

function isValidEmoji(emoji) {
  if (typeof emoji !== 'string') return false;
  const trimmed = emoji.trim();
  if (!trimmed) return false;
  return CUSTOM_EMOJI_RE.test(trimmed) || UNICODE_EMOJI_RE.test(trimmed);
}

// ─────────────────────────────────────────────────────────
// EMBEDS
// ─────────────────────────────────────────────────────────

function createPanelEmbed(store) {
  const bot = store.getBot();
  const types = getTicketTypes(store);
  const typeList = types.map((t) => `${t.emoji} **${t.label}** — ${t.description}`).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(bot.panelTitle || '🎫 Support')
    .setDescription(`${bot.panelDescription || ''}\n\n${typeList}`)
    .setColor(safeColor(bot.embedColor))
    .setFooter({ text: bot.footerText || 'Un seul ticket ouvert à la fois par utilisateur.' })
    .setTimestamp();

  if (bot.panelBanner) embed.setImage(bot.panelBanner);
  return embed;
}

function createUserOpenEmbed(ticketType, ticketId) {
  return new EmbedBuilder()
    .setTitle(`${ticketType.emoji} Ticket ouvert — ${ticketType.label}`)
    .setDescription(
      `Ton ticket a bien été créé !\n\n**Tape ton message ci-dessous**, notre équipe te répondra dès que possible.\n\nLe ticket sera fermé par le staff une fois résolu.`
    )
    .setColor(safeColor(ticketType.color))
    .setFooter({ text: `ID du ticket : ${ticketId}` })
    .setTimestamp();
}

function createStaffEmbed(user, ticketType, ticketId) {
  return new EmbedBuilder()
    .setTitle(`${ticketType.emoji} Nouveau ticket — ${ticketType.label}`)
    .setDescription(`Un ticket a été ouvert par **${user.tag}**`)
    .addFields(
      { name: '👤 Utilisateur', value: `<@${user.id}> (\`${user.id}\`)`, inline: true },
      { name: '📋 Type', value: `${ticketType.emoji} ${ticketType.label}`, inline: true },
      { name: '🆔 Ticket ID', value: `\`${ticketId}\``, inline: true }
    )
    .setThumbnail(user.displayAvatarURL({ dynamic: true }))
    .setColor(safeColor(ticketType.color))
    .setFooter({ text: 'Utilisez les boutons ci-dessous pour gérer ce ticket.' })
    .setTimestamp();
}

function createUserClosedEmbed(closedBy) {
  return new EmbedBuilder()
    .setTitle('🔒 Ticket fermé')
    .setDescription(
      `Ton ticket a été **fermé** par le staff.\n\nMerci d'avoir contacté notre équipe ! Si tu as besoin d'aide à nouveau, ouvre un nouveau ticket depuis le serveur.`
    )
    .setColor(0x99aab5)
    .setFooter({ text: closedBy ? `Fermé par ${closedBy}` : 'Ticket fermé' })
    .setTimestamp();
}

function createMessageRelayEmbed(author, content, isStaff = false) {
  return new EmbedBuilder()
    .setAuthor({
      name: isStaff ? `Staff · ${author.tag}` : author.tag,
      iconURL: author.displayAvatarURL({ dynamic: true }),
    })
    .setDescription(content || '*[Pas de contenu textuel]*')
    .setColor(isStaff ? 0x5865f2 : 0x57f287)
    .setTimestamp();
}

module.exports = {
  getTicketTypes,
  getTicketType,
  getAllKnownRoles,
  safeColor,
  isValidEmoji,
  createPanelEmbed,
  createUserOpenEmbed,
  createStaffEmbed,
  createUserClosedEmbed,
  createMessageRelayEmbed,
};
