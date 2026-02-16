const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const GUILD_ID = "1407474049793265815";
const STAFF_ROLE_ID = "1473068224307400898";
const TICKET_CATEGORY_ID = "1473091923630887056";
const TRANSCRIPTS_CHANNEL_ID = "1473092162462679091";

// userId -> channelId
const openTickets = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

function safeChannelName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}

async function getDisplayName(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member?.displayName || member?.user?.username || "user";
  } catch {
    const u = await client.users.fetch(userId).catch(() => null);
    return u?.username || "user";
  }
}

async function createTicketChannel(guild, userId) {
  const displayName = await getDisplayName(guild, userId);
  const channelName = safeChannelName(`ticket-${displayName}`);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: STAFF_ROLE_ID,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
    reason: `Modmail ticket for ${displayName} (${userId})`,
  });

  return { channel, displayName };
}

async function sendTranscript(guild, ticketChannel, displayName) {
  const messages = await ticketChannel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].reverse();

  const lines = sorted.map((m) => {
    const time = new Date(m.createdTimestamp).toISOString();
    const content = m.content?.length ? m.content : "[no text]";
    return `[${time}] ${m.author.tag}: ${content}`;
  });

  const transcriptText = lines.join("\n");
  const filePath = path.join(__dirname, `transcript-${ticketChannel.id}.txt`);
  fs.writeFileSync(filePath, transcriptText, "utf8");

  const transcriptChannel = await guild.channels.fetch(TRANSCRIPTS_CHANNEL_ID).catch(() => null);
  if (transcriptChannel) {
    await transcriptChannel.send({
      content: `Transcript for **${displayName}** (${ticketChannel.name})`,
      files: [filePath],
    });
  }

  fs.unlinkSync(filePath);
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// USER -> DM -> STAFF CHANNEL
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Only DMs from users
  if (message.channel.type !== ChannelType.DM) return;

  const guild = await client.guilds.fetch(GUILD_ID);
  const userId = message.author.id;

  // Ticket exists? forward message
  if (openTickets.has(userId)) {
    const channelId = openTickets.get(userId);
    const ticketChannel = await guild.channels.fetch(channelId).catch(() => null);

    if (ticketChannel) {
      const displayName = await getDisplayName(guild, userId);

      const embed = new EmbedBuilder()
        .setTitle("User Message")
        .setDescription(message.content || "[no text]")
        .setFooter({ text: `${displayName} • ${userId}` })
        .setTimestamp();

      await ticketChannel.send({ embeds: [embed] });
      return;
    } else {
      openTickets.delete(userId);
    }
  }

  // Create new ticket
  const { channel: ticketChannel, displayName } = await createTicketChannel(guild, userId);
  openTickets.set(userId, ticketChannel.id);

  // DM user opening message
  await message.author.send(
    "Thank you for contacting Kingsley academy support team, the team will be with you shortly state your reason for opening the ticket."
  );

  // Staff controls + first message
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("close_ticket").setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
  );

  const firstEmbed = new EmbedBuilder()
    .setTitle("New Ticket Opened")
    .setDescription(message.content || "[no text]")
    .setFooter({ text: `${displayName} • ${userId}` })
    .setTimestamp();

  await ticketChannel.send({ content: `Ticket opened by **${displayName}** (<@${userId}>)`, embeds: [firstEmbed], components: [row] });
});

// STAFF -> SERVER TICKET CHANNEL -> USER DM
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  // only ticket category channels
  if (message.channel.parentId !== TICKET_CATEGORY_ID) return;

  // find userId for this ticket channel
  const entry = [...openTickets.entries()].find(([, chId]) => chId === message.channel.id);
  if (!entry) return;

  // staff only
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

  const [userId] = entry;
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;

  const staffName = message.member.displayName;

  // Don't DM the command text if they type it
  if (message.content?.toLowerCase() === "!close") return;

  const embed = new EmbedBuilder()
    .setTitle("Support Reply")
    .setDescription(message.content || "[no text]")
    .setFooter({ text: staffName })
    .setTimestamp();

  await user.send({ embeds: [embed] });
});

// CLOSE BUTTON
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== "close_ticket") return;

  if (!interaction.guild) return;
  if (interaction.channel?.parentId !== TICKET_CATEGORY_ID) return;

  const member = interaction.member;
  if (!member.roles.cache.has(STAFF_ROLE_ID)) {
    return interaction.reply({ content: "You don't have permission to close tickets.", ephemeral: true });
  }

  // find userId for this ticket channel
  const entry = [...openTickets.entries()].find(([, chId]) => chId === interaction.channel.id);
  if (!entry) {
    return interaction.reply({ content: "Ticket not found.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const [userId] = entry;
  const guild = interaction.guild;
  const ticketChannel = interaction.channel;

  const displayName = await getDisplayName(guild, userId);
  const closedBy = member.displayName;

  // DM user closed message
  const user = await client.users.fetch(userId).catch(() => null);
  if (user) {
    await user.send(`Thank you for contacting kingsley support team your ticket has been closed by ${closedBy}.`);
  }

  // transcript
  await sendTranscript(guild, ticketChannel, displayName);

  // cleanup
  openTickets.delete(userId);
  await ticketChannel.delete(`Ticket closed by ${closedBy}`);

  await interaction.editReply({ content: "Ticket closed." });
});

// LOGIN (Railway will provide TOKEN)
client.login(process.env.TOKEN);
