const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');
const { pool, ensureSchema } = require('./db');
const {
  getTicketType,
  getAllKnownRoles,
  createUserOpenEmbed,
  createStaffEmbed,
  createUserClosedEmbed,
  createMessageRelayEmbed,
} = require('./config');

class TicketManager {
  // IMPORTANT : reçoit désormais le tenantId + le TenantStore DU CLIENT
  // concerné (passés par BotController), au lieu d'importer un store
  // global. C'est ce qui manquait et causait "store.getBot is not a
  // function" (l'ancien `require('./store')` renvoie { globalStore,
  // tenantManager }, qui n'a pas de méthode getBot()). Ça garantit aussi
  // que les tickets sont bien scopés par tenant_id (voir plus bas).
  constructor(client, tenantId, store) {
    this.client = client;
    this.tenantId = tenantId;
    this.store = store;
    this.tickets = new Map();
    this.userTickets = new Map();
    this.channelTickets = new Map();
  }

  async init() {
    await this.loadTickets();
    await this.reconnectTickets();
    console.log(`📂 ${this.tickets.size} ticket(s) actif(s) en mémoire.`);
  }

  // Les tickets sont stockés en MySQL (table `tickets`) plutôt que dans
  // data/tickets.json : ce fichier local disparaissait à chaque redeploy
  // Render, ce qui faisait perdre tous les tickets ouverts.
  async loadTickets() {
    try {
      await ensureSchema();
      const [rows] = await pool.query(
        "SELECT data FROM tickets WHERE status = 'open' AND tenant_id = ?",
        [this.tenantId]
      );
      for (const row of rows) {
        const ticket = JSON.parse(row.data);
        this.tickets.set(ticket.id, ticket);
        this.userTickets.set(ticket.userId, ticket.id);
        this.channelTickets.set(ticket.channelId, ticket.id);
      }
    } catch (err) {
      console.error('Erreur chargement tickets depuis MySQL:', err.message);
    }
  }

  // Sauvegarde immédiate d'UN ticket (appelé à chaque changement d'état).
  async saveTicket(ticket) {
    try {
      await pool.query(
        `INSERT INTO tickets (id, tenant_id, data, status, created_at) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), status = VALUES(status)`,
        [ticket.id, this.tenantId, JSON.stringify(ticket), ticket.status, ticket.createdAt || Date.now()]
      );
    } catch (err) {
      console.error('Erreur sauvegarde ticket en MySQL:', err.message);
    }
  }

  async deleteTicketRow(ticketId) {
    try {
      await pool.query('DELETE FROM tickets WHERE id = ? AND tenant_id = ?', [ticketId, this.tenantId]);
    } catch (err) {
      console.error('Erreur suppression ticket en MySQL:', err.message);
    }
  }

  // Conservé pour compat : sauvegarde tous les tickets actuellement en mémoire.
  async saveTickets() {
    for (const ticket of this.tickets.values()) {
      await this.saveTicket(ticket);
    }
  }

  async reconnectTickets() {
    const { staffGuildId } = this.store.getBot();
    if (!staffGuildId) return;

    try {
      const staffGuild = await this.client.guilds.fetch(staffGuildId);
      await staffGuild.channels.fetch();
    } catch (err) {
      console.error('❌ Impossible de charger le serveur staff:', err.message);
    }

    const toRemove = [];
    const allKnownRoles = getAllKnownRoles(this.store);

    for (const [id, ticket] of this.tickets.entries()) {
      try {
        const channel = await this.client.channels.fetch(ticket.channelId, { force: true }).catch(() => null);

        if (!channel) {
          console.warn(`⚠️ Salon introuvable pour ticket ${id} (${ticket.channelId}) — retiré de la mémoire`);
          toRemove.push(id);
          continue;
        }

        try {
          const ticketType = getTicketType(this.store, ticket.typeId);
          const allowedRoles = ticketType ? ticketType.allowedRoles : allKnownRoles;

          await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, {
            ViewChannel: false,
          });

          for (const roleId of allKnownRoles) {
            if (!allowedRoles.includes(roleId)) {
              await channel.permissionOverwrites
                .edit(roleId, {
                  ViewChannel: false,
                  SendMessages: false,
                  ReadMessageHistory: false,
                  AttachFiles: false,
                })
                .catch(() => {});
            }
          }

          for (const roleId of allowedRoles) {
            await channel.permissionOverwrites
              .edit(roleId, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                AttachFiles: true,
              })
              .catch(() => {});
          }

          await channel.permissionOverwrites.edit(this.client.user.id, {
            ViewChannel: true,
            SendMessages: true,
            ManageChannels: true,
            ReadMessageHistory: true,
            AttachFiles: true,
          });
        } catch (permErr) {
          console.warn(`⚠️ Impossible de mettre à jour les perms du ticket ${id}:`, permErr.message);
        }

        ticket._channel = channel;
        console.log(`✅ Ticket ${id} restauré (salon: #${channel.name})`);
      } catch (err) {
        console.warn(`⚠️ Erreur restauration ticket ${id}:`, err.message);
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      const ticket = this.tickets.get(id);
      if (ticket) {
        this.userTickets.delete(ticket.userId);
        this.channelTickets.delete(ticket.channelId);
      }
      this.tickets.delete(id);
      await this.deleteTicketRow(id);
    }

    await this.saveTickets();
  }

  generateId() {
    return Math.random().toString(36).substr(2, 8).toUpperCase();
  }

  hasOpenTicket(userId) {
    return this.userTickets.has(userId);
  }

  getTicketById(id) {
    return this.tickets.get(id) || null;
  }

  getTicketByChannel(channelId) {
    const id = this.channelTickets.get(channelId);
    return id ? this.tickets.get(id) : null;
  }

  getTicketByUser(userId) {
    const id = this.userTickets.get(userId);
    return id ? this.tickets.get(id) : null;
  }

  buildStaffButtons(ticketId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_claim_${ticketId}`)
        .setLabel('Prendre en charge')
        .setEmoji('✋')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`ticket_close_${ticketId}`)
        .setLabel('Fermer')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`ticket_delete_${ticketId}`)
        .setLabel('Supprimer')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  async createTicket(user, ticketType, sourceGuild) {
    const ticketId = this.generateId();
    const { staffGuildId, staffCategoryId } = this.store.getBot();

    if (!staffGuildId) throw new Error('Aucun serveur staff configuré dans le dashboard.');

    const staffGuild = await this.client.guilds.fetch(staffGuildId);
    if (!staffGuild) throw new Error('Serveur staff introuvable');

    const channelName = `${ticketType.id}-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}-${ticketId.toLowerCase()}`;

    const allowedRoles = ticketType.allowedRoles || [];

    const permissionOverwrites = [
      {
        id: staffGuild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
      },
      {
        id: this.client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AttachFiles,
        ],
      },
      ...allowedRoles.map((roleId) => ({
        id: roleId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AttachFiles,
        ],
      })),
    ];

    const channelOptions = {
      name: channelName,
      type: ChannelType.GuildText,
      topic: `Ticket ${ticketId} | ${ticketType.label} | Utilisateur: ${user.tag} (${user.id})`,
      lockPermissions: false,
      permissionOverwrites,
    };

    if (staffCategoryId) channelOptions.parent = staffCategoryId;

    const staffChannel = await staffGuild.channels.create(channelOptions);

    const staffEmbed = createStaffEmbed(user, ticketType, ticketId);
    const buttons = this.buildStaffButtons(ticketId);
    await staffChannel.send({ embeds: [staffEmbed], components: [buttons] });

    try {
      const dm = await user.createDM();
      const userEmbed = createUserOpenEmbed(ticketType, ticketId);
      await dm.send({ embeds: [userEmbed] });
    } catch {
      await staffChannel.send({
        embeds: [
          new EmbedBuilder()
            .setDescription(`⚠️ Impossible d'envoyer un DM à **${user.tag}**. Ses DMs sont peut-être fermés.`)
            .setColor(0xfee75c),
        ],
      });
    }

    const ticketData = {
      id: ticketId,
      userId: user.id,
      userTag: user.tag,
      typeId: ticketType.id,
      channelId: staffChannel.id,
      guildId: staffGuild.id,
      status: 'open',
      claimedBy: null,
      claimedByTag: null,
      createdAt: Date.now(),
    };

    this.tickets.set(ticketId, ticketData);
    this.userTickets.set(user.id, ticketId);
    this.channelTickets.set(staffChannel.id, ticketId);
    await this.saveTicket(ticketData);

    console.log(`🎫 Ticket ${ticketId} créé pour ${user.tag} (type: ${ticketType.id})`);
    return ticketData;
  }

  async claimTicket(interaction, ticket) {
    if (ticket.claimedBy) {
      return interaction.reply({
        content: `❌ Ce ticket est déjà pris en charge par <@${ticket.claimedBy}>.`,
        ephemeral: true,
      });
    }

    ticket.claimedBy = interaction.user.id;
    ticket.claimedByTag = interaction.user.tag;
    await this.saveTicket(ticket);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setDescription(`✋ **${interaction.user.tag}** a pris en charge ce ticket.`)
          .setColor(0x57f287)
          .setTimestamp(),
      ],
    });

    try {
      const user = await this.client.users.fetch(ticket.userId);
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setDescription(`✋ Un membre du staff s'occupe maintenant de ton ticket !`)
            .setColor(0x57f287)
            .setTimestamp(),
        ],
      });
    } catch {}
  }

  async closeTicket(interaction, ticket) {
    await interaction.deferReply();

    ticket.status = 'closed';
    ticket.closedAt = Date.now();
    ticket.closedBy = interaction.user.tag;

    this.userTickets.delete(ticket.userId);
    this.channelTickets.delete(ticket.channelId);
    await this.saveTicket(ticket);

    try {
      const user = await this.client.users.fetch(ticket.userId);
      await user.send({ embeds: [createUserClosedEmbed(interaction.user.tag)] });
    } catch {}

    const closedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_delete_${ticket.id}`)
        .setLabel('Supprimer le salon')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🔒 Ticket fermé')
          .setDescription(
            `Ce ticket a été fermé par **${interaction.user.tag}**.\nClique sur "Supprimer le salon" pour supprimer ce canal.`
          )
          .setColor(0x99aab5)
          .setTimestamp(),
      ],
      components: [closedRow],
    });

    try {
      const msgs = await interaction.channel.messages.fetch({ limit: 50 });
      const panelMsg = msgs.find(
        (m) =>
          m.author.id === this.client.user.id &&
          m.components.length > 0 &&
          m.components[0].components.some((c) => c.customId?.includes('ticket_claim'))
      );
      if (panelMsg) {
        const disabledRow = new ActionRowBuilder().addComponents(
          ...panelMsg.components[0].components.map((c) => ButtonBuilder.from(c).setDisabled(true))
        );
        await panelMsg.edit({ components: [disabledRow] });
      }
    } catch {}

    console.log(`🔒 Ticket ${ticket.id} fermé par ${interaction.user.tag}`);
  }

  async deleteTicket(interaction, ticket) {
    await interaction.reply({ content: '🗑️ Suppression du salon dans 5 secondes...', ephemeral: true });

    if (ticket.status === 'open') {
      ticket.status = 'closed';
      ticket.closedAt = Date.now();
      ticket.closedBy = interaction.user.tag;
      this.userTickets.delete(ticket.userId);
      this.channelTickets.delete(ticket.channelId);

      try {
        const user = await this.client.users.fetch(ticket.userId);
        await user.send({ embeds: [createUserClosedEmbed(interaction.user.tag)] });
      } catch {}
    }

    this.tickets.delete(ticket.id);
    await this.deleteTicketRow(ticket.id);

    setTimeout(async () => {
      try {
        await interaction.channel.delete(`Ticket ${ticket.id} supprimé par ${interaction.user.tag}`);
      } catch (err) {
        console.error('Erreur suppression salon:', err);
      }
    }, 5000);

    console.log(`🗑️ Ticket ${ticket.id} supprimé par ${interaction.user.tag}`);
  }

  async relayUserToStaff(message) {
    const ticket = this.getTicketByUser(message.author.id);
    if (!ticket || ticket.status !== 'open') return;

    try {
      const channel = await this.client.channels.fetch(ticket.channelId);
      const embed = createMessageRelayEmbed(message.author, message.content, false);
      const files = message.attachments.size > 0 ? [...message.attachments.values()] : [];
      await channel.send({ embeds: [embed], files });
      await message.react('✅');
    } catch (err) {
      console.error('Erreur relay user→staff:', err);
      await message.react('❌');
    }
  }

  async relayStaffToUser(message) {
    if (message.content.startsWith('!') || message.content.startsWith('/')) return;
    if (message.reference && message.reference.messageId) return;

    const ticket = this.getTicketByChannel(message.channel.id);
    if (!ticket || ticket.status !== 'open') return;

    const hasContent = message.content && message.content.trim().length > 0;
    const hasAttachments = message.attachments.size > 0;
    if (!hasContent && !hasAttachments) return;

    try {
      const user = await this.client.users.fetch(ticket.userId);
      const embed = createMessageRelayEmbed(message.author, message.content, true);
      const files = hasAttachments ? [...message.attachments.values()] : [];
      await user.send({ embeds: [embed], files });
      await message.react('✅');
    } catch (err) {
      console.error('Erreur relay staff→user:', err);
      await message.react('❌').catch(() => {});
    }
  }

  // Utilisé par la console live du dashboard. Important : les messages envoyés
  // par le bot lui-même (channel.send) sont ignorés par le handler
  // messageCreate (message.author.bot === true), donc un simple "post dans le
  // salon" ne relaie JAMAIS le message à l'utilisateur en DM. On doit donc
  // explicitement dupliquer ici ce que fait relayStaffToUser.
  async sendDashboardReply(ticket, staffLabel, text) {
    if (!ticket || ticket.status !== 'open') {
      throw new Error('Ce ticket est introuvable ou déjà fermé.');
    }

    const channel = await this.client.channels.fetch(ticket.channelId).catch(() => null);
    if (channel) {
      await channel.send(`**[Dashboard] ${staffLabel} :** ${text}`);
    }

    try {
      const user = await this.client.users.fetch(ticket.userId);
      const embed = createMessageRelayEmbed(
        { tag: staffLabel, displayAvatarURL: () => undefined },
        text,
        true
      );
      await user.send({ embeds: [embed] });
    } catch (err) {
      console.error('Erreur relay dashboard→user:', err.message);
      throw new Error("Message posté dans le salon, mais impossible d'envoyer le DM à l'utilisateur (DMs probablement fermés).");
    }
  }
}

module.exports = TicketManager;
