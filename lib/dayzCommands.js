'use strict';

// ── Slash commands DayZ (module additionnel du bot Discord) ─────────
// /dayz-solde       : tout le monde peut voir SON PROPRE solde.
// /dayz-give        : réservé au staff whitelisté (store.isDayzStaff).
// /dayz-link        : réservé au staff whitelisté — lie un SteamID à un
//                      compte Discord (seul moyen de lier un compte).
// /dayz-classement  : classement richesse / kills / ratio de survie.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const dayz = require('./dayzManager');
const { runOnce: rconRunOnce } = require('./dayzRcon');

const COMMAND_BUILDERS = [
  new SlashCommandBuilder()
    .setName('dayz-solde')
    .setDescription('Affiche ton solde DayZ (compte lié à ton Discord).'),

  new SlashCommandBuilder()
    .setName('dayz-give')
    .setDescription('[Staff] Donne (ou retire) de l\'argent à un joueur DayZ.')
    .addUserOption((opt) => opt.setName('utilisateur').setDescription('Le joueur Discord lié au compte').setRequired(true))
    .addIntegerOption((opt) => opt.setName('montant').setDescription("Montant (négatif pour retirer)").setRequired(true))
    .addStringOption((opt) => opt.setName('raison').setDescription('Raison (optionnel)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('dayz-link')
    .setDescription('[Staff] Lie un SteamID DayZ à un compte Discord.')
    .addStringOption((opt) => opt.setName('steamid').setDescription('SteamID64 du joueur').setRequired(true))
    .addUserOption((opt) => opt.setName('utilisateur').setDescription('Compte Discord à lier').setRequired(true)),

  new SlashCommandBuilder()
    .setName('dayz-classement')
    .setDescription('Affiche le classement des joueurs DayZ.')
    .addStringOption((opt) =>
      opt
        .setName('type')
        .setDescription('Type de classement')
        .setRequired(true)
        .addChoices(
          { name: 'Richesse', value: 'money' },
          { name: 'Kills', value: 'kills' },
          { name: 'Ratio (K/D)', value: 'ratio' }
        )
    ),

  // ── Gestion quotidienne du serveur (staff whitelisté) ────────────
  // Objectif : sur PS4/PS5, l'admin n'a pas d'accès FTP/RCon direct,
  // donc TOUT le pilotage "au jour le jour" du serveur doit pouvoir se
  // faire depuis Discord (le dashboard reste pour la config de fond :
  // safe zones, whitelist staff, liaison Nitrado).
  new SlashCommandBuilder()
    .setName('dayz-joueurs')
    .setDescription('[Staff] Liste les joueurs actuellement connectés (RCon).'),

  new SlashCommandBuilder()
    .setName('dayz-kick')
    .setDescription('[Staff] Expulse un joueur connecté.')
    .addStringOption((opt) => opt.setName('nom').setDescription('Nom exact du joueur (voir /dayz-joueurs)').setRequired(true))
    .addStringOption((opt) => opt.setName('raison').setDescription('Raison (optionnel)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('dayz-ban')
    .setDescription('[Staff] Bannit un joueur connecté.')
    .addStringOption((opt) => opt.setName('nom').setDescription('Nom exact du joueur (voir /dayz-joueurs)').setRequired(true))
    .addIntegerOption((opt) => opt.setName('duree').setDescription('Durée en minutes (0 = permanent)').setRequired(false))
    .addStringOption((opt) => opt.setName('raison').setDescription('Raison (optionnel)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('dayz-unban')
    .setDescription("[Staff] Lève un ban via son n° (voir la sortie d'un ban RCon).")
    .addIntegerOption((opt) => opt.setName('id').setDescription('N° du ban côté RCon').setRequired(true)),

  new SlashCommandBuilder()
    .setName('dayz-annonce')
    .setDescription('[Staff] Diffuse un message à tous les joueurs connectés.')
    .addStringOption((opt) => opt.setName('message').setDescription('Message à afficher en jeu').setRequired(true)),

  new SlashCommandBuilder()
    .setName('dayz-restart')
    .setDescription('[Staff] Redémarre le serveur DayZ (RCon #shutdown).')
    .addIntegerOption((opt) => opt.setName('delai').setDescription('Délai avant redémarrage, en minutes (défaut: 0)').setRequired(false)),
].map((b) => b.toJSON());

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}`;
}

async function handleInteraction(interaction, store) {
  if (!interaction.isChatInputCommand()) return false;
  if (!interaction.commandName.startsWith('dayz-')) return false;

  const dayzConfig = store.getDayz();
  if (!dayzConfig.enabled) {
    await interaction.reply({ content: '❌ Le module DayZ est désactivé sur ce serveur.', ephemeral: true });
    return true;
  }

  const currency = dayzConfig.currencySymbol || '💰';

  switch (interaction.commandName) {
    case 'dayz-solde': {
      const player = await dayz.getPlayerByDiscordId(store.tenantId, interaction.user.id);
      if (!player) {
        await interaction.reply({
          content: "❌ Aucun compte DayZ lié à ton Discord. Demande au staff de faire `/dayz-link`.",
          ephemeral: true,
        });
        return true;
      }
      const embed = new EmbedBuilder()
        .setTitle(`${currency} Solde de ${player.player_name || interaction.user.username}`)
        .addFields(
          { name: 'Solde', value: `${player.balance} ${currency}`, inline: true },
          { name: 'Kills / Deaths', value: `${player.kills} / ${player.deaths}`, inline: true },
          { name: 'Temps de jeu', value: formatDuration(player.playtime_seconds), inline: true }
        )
        .setColor(0x57f287);
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return true;
    }

    case 'dayz-give': {
      if (!store.isDayzStaff(interaction.user.id)) {
        await interaction.reply({ content: '❌ Réservé au staff whitelisté DayZ.', ephemeral: true });
        return true;
      }
      const targetUser = interaction.options.getUser('utilisateur', true);
      const amount = interaction.options.getInteger('montant', true);
      const reason = interaction.options.getString('raison') || null;

      const targetPlayer = await dayz.getPlayerByDiscordId(store.tenantId, targetUser.id);
      if (!targetPlayer) {
        await interaction.reply({
          content: `❌ ${targetUser} n'a pas de compte DayZ lié. Utilise \`/dayz-link\` d'abord.`,
          ephemeral: true,
        });
        return true;
      }

      const updated = await dayz.addBalance(store.tenantId, targetPlayer.steam_id, amount, interaction.user.id, reason);
      const embed = new EmbedBuilder()
        .setTitle(`${currency} Transaction effectuée`)
        .setDescription(`${amount >= 0 ? 'Crédit' : 'Débit'} de **${Math.abs(amount)} ${currency}** pour ${targetUser}.`)
        .addFields({ name: 'Nouveau solde', value: `${updated.balance} ${currency}` })
        .setFooter({ text: reason ? `Raison : ${reason}` : `Par ${interaction.user.tag}` })
        .setColor(0x5865f2);
      await interaction.reply({ embeds: [embed] });
      return true;
    }

    case 'dayz-link': {
      if (!store.isDayzStaff(interaction.user.id)) {
        await interaction.reply({ content: '❌ Réservé au staff whitelisté DayZ.', ephemeral: true });
        return true;
      }
      const steamId = interaction.options.getString('steamid', true).trim();
      if (!/^\d{10,20}$/.test(steamId)) {
        await interaction.reply({ content: '❌ SteamID invalide (attendu : SteamID64, uniquement des chiffres).', ephemeral: true });
        return true;
      }
      const targetUser = interaction.options.getUser('utilisateur', true);

      const existing = await dayz.getPlayerByDiscordId(store.tenantId, targetUser.id);
      if (existing && existing.steam_id !== steamId) {
        await interaction.reply({
          content: `❌ ${targetUser} est déjà lié au SteamID \`${existing.steam_id}\`. Délie-le d'abord si besoin.`,
          ephemeral: true,
        });
        return true;
      }

      await dayz.linkDiscord(store.tenantId, steamId, targetUser.id);
      await interaction.reply({ content: `✅ Compte DayZ \`${steamId}\` lié à ${targetUser}.` });
      return true;
    }

    case 'dayz-classement': {
      const type = interaction.options.getString('type', true);
      const rows = await dayz.getLeaderboard(store.tenantId, type, 10);
      if (!rows.length) {
        await interaction.reply({ content: 'Aucune donnée pour le moment.', ephemeral: true });
        return true;
      }

      const titleByType = { money: `${currency} Classement — Richesse`, kills: '☠️ Classement — Kills', ratio: '📊 Classement — Ratio K/D' };
      const lines = rows.map((r, i) => {
        const label = r.player_name || r.steam_id;
        const mention = r.discord_id ? ` (<@${r.discord_id}>)` : '';
        if (type === 'money') return `**${i + 1}.** ${label}${mention} — ${r.balance} ${currency}`;
        if (type === 'kills') return `**${i + 1}.** ${label}${mention} — ${r.kills} kills (${r.deaths} morts)`;
        return `**${i + 1}.** ${label}${mention} — ratio ${Number(r.ratio).toFixed(2)} (${r.kills}K / ${r.deaths}D)`;
      });

      const embed = new EmbedBuilder().setTitle(titleByType[type]).setDescription(lines.join('\n')).setColor(0xfee75c);
      await interaction.reply({ embeds: [embed] });
      return true;
    }

    // ── Gestion quotidienne (staff whitelisté, via RCon BattlEye) ────
    case 'dayz-joueurs': {
      if (!store.isDayzStaff(interaction.user.id)) {
        await interaction.reply({ content: '❌ Réservé au staff whitelisté DayZ.', ephemeral: true });
        return true;
      }
      if (!dayzConfig.rcon?.host || !dayzConfig.rcon?.password) {
        await interaction.reply({ content: "❌ RCon non configuré (lie ton compte Nitrado ou renseigne le RCon dans le dashboard).", ephemeral: true });
        return true;
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const output = await rconRunOnce(dayzConfig.rcon, 'players');
        await interaction.editReply({ content: `\`\`\`\n${String(output).slice(0, 1900)}\n\`\`\`` });
      } catch (err) {
        await interaction.editReply({ content: `❌ Échec RCon : ${err.message}` });
      }
      return true;
    }

    case 'dayz-kick':
    case 'dayz-ban': {
      if (!store.isDayzStaff(interaction.user.id)) {
        await interaction.reply({ content: '❌ Réservé au staff whitelisté DayZ.', ephemeral: true });
        return true;
      }
      if (!dayzConfig.rcon?.host || !dayzConfig.rcon?.password) {
        await interaction.reply({ content: "❌ RCon non configuré (lie ton compte Nitrado ou renseigne le RCon dans le dashboard).", ephemeral: true });
        return true;
      }
      const name = interaction.options.getString('nom', true).trim();
      const reason = interaction.options.getString('raison') || (interaction.commandName === 'dayz-kick' ? 'Expulsion par le staff' : 'Ban par le staff');
      await interaction.deferReply();
      try {
        const playersOutput = await rconRunOnce(dayzConfig.rcon, 'players');
        const slot = dayz.findPlayerSlot(playersOutput, name);
        if (slot === null) {
          await interaction.editReply({ content: `❌ Joueur "${name}" introuvable parmi les joueurs connectés (vérifie \`/dayz-joueurs\`).` });
          return true;
        }
        if (interaction.commandName === 'dayz-kick') {
          await rconRunOnce(dayzConfig.rcon, `kick ${slot} ${reason}`);
          await interaction.editReply({ content: `✅ ${name} a été expulsé. (${reason})` });
        } else {
          const durationMin = interaction.options.getInteger('duree') ?? 0;
          await rconRunOnce(dayzConfig.rcon, `ban ${slot} ${durationMin} ${reason}`);
          await interaction.editReply({
            content: `✅ ${name} a été banni ${durationMin > 0 ? `pour ${durationMin} min` : 'définitivement'}. (${reason})`,
          });
        }
      } catch (err) {
        await interaction.editReply({ content: `❌ Échec RCon : ${err.message}` });
      }
      return true;
    }

    case 'dayz-unban': {
      if (!store.isDayzStaff(interaction.user.id)) {
        await interaction.reply({ content: '❌ Réservé au staff whitelisté DayZ.', ephemeral: true });
        return true;
      }
      if (!dayzConfig.rcon?.host || !dayzConfig.rcon?.password) {
        await interaction.reply({ content: "❌ RCon non configuré (lie ton compte Nitrado ou renseigne le RCon dans le dashboard).", ephemeral: true });
        return true;
      }
      const banId = interaction.options.getInteger('id', true);
      await interaction.deferReply();
      try {
        await rconRunOnce(dayzConfig.rcon, `removeBan ${banId}`);
        await interaction.editReply({ content: `✅ Ban n°${banId} levé.` });
      } catch (err) {
        await interaction.editReply({ content: `❌ Échec RCon : ${err.message}` });
      }
      return true;
    }

    case 'dayz-annonce': {
      if (!store.isDayzStaff(interaction.user.id)) {
        await interaction.reply({ content: '❌ Réservé au staff whitelisté DayZ.', ephemeral: true });
        return true;
      }
      if (!dayzConfig.rcon?.host || !dayzConfig.rcon?.password) {
        await interaction.reply({ content: "❌ RCon non configuré (lie ton compte Nitrado ou renseigne le RCon dans le dashboard).", ephemeral: true });
        return true;
      }
      const message = interaction.options.getString('message', true);
      await interaction.deferReply();
      try {
        await rconRunOnce(dayzConfig.rcon, `say -1 ${message}`);
        await interaction.editReply({ content: `📢 Annonce diffusée : "${message}"` });
      } catch (err) {
        await interaction.editReply({ content: `❌ Échec RCon : ${err.message}` });
      }
      return true;
    }

    case 'dayz-restart': {
      if (!store.isDayzStaff(interaction.user.id)) {
        await interaction.reply({ content: '❌ Réservé au staff whitelisté DayZ.', ephemeral: true });
        return true;
      }
      if (!dayzConfig.rcon?.host || !dayzConfig.rcon?.password) {
        await interaction.reply({ content: "❌ RCon non configuré (lie ton compte Nitrado ou renseigne le RCon dans le dashboard).", ephemeral: true });
        return true;
      }
      const delayMin = interaction.options.getInteger('delai') ?? 0;
      await interaction.deferReply();
      try {
        if (delayMin > 0) {
          await rconRunOnce(dayzConfig.rcon, `say -1 Redémarrage du serveur dans ${delayMin} min.`);
        }
        // ⚠️ "#shutdown" est la commande RCon standard pour arrêter le
        // process DayZ. Sur Nitrado, le service surveille et relance
        // automatiquement le serveur après un arrêt propre — si ce
        // n'est pas le cas sur ta config, dis-le moi pour adapter.
        setTimeout(async () => {
          try {
            await rconRunOnce(dayzConfig.rcon, '#shutdown');
          } catch (err) {
            console.error(`Échec redémarrage RCon DayZ (tenant ${store.tenantId}):`, err.message);
          }
        }, delayMin * 60_000);
        await interaction.editReply({
          content: delayMin > 0 ? `✅ Redémarrage programmé dans ${delayMin} min.` : '✅ Redémarrage lancé immédiatement.',
        });
      } catch (err) {
        await interaction.editReply({ content: `❌ Échec RCon : ${err.message}` });
      }
      return true;
    }

    default:
      return false;
  }
}

module.exports = { COMMAND_BUILDERS, handleInteraction };
