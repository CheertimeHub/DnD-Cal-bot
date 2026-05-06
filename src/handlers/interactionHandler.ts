import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  ForumChannel,
  Interaction,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js"
import * as sessionManager from "../systems/sessionManager"
import { buildEnemyEmbed, buildLobbyEmbed, buildPlayerEmbed, buildSlotButtons } from "../utils/embed"
import { getDefaultHp } from "../utils/classHp"
import { findForumMonsterStat, findForumPostImage } from "../utils/forumSearch"
import { Player, Session } from "../types/session"

interface PendingSpawn {
  name: string
  count: number
  hp: number
  imageUrl: string | null
}

const pendingSpawns = new Map<string, PendingSpawn>()

async function getLobbyMeta(
  session: Session,
  client: Client
): Promise<{ channelName: string; hostTag: string }> {
  const guild = await client.guilds.fetch(session.guildId)
  const channel = await guild.channels.fetch(session.channelId)
  const channelName = channel && "name" in channel ? (channel as TextChannel).name : "DnD Session"
  const host = await client.users.fetch(session.hostId)
  return { channelName, hostTag: host.tag }
}

async function buildPlayerImages(
  session: Session,
  client: Client
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  if (!session.forumChannelId) return result

  const guild = await client.guilds.fetch(session.guildId)
  const registeredPlayers = session.players.filter(
    (p): p is Player => p !== null && p.name !== ""
  )

  await Promise.all(
    registeredPlayers.map(async (p) => {
      const url = await findForumPostImage(guild, session.forumChannelId!, p.name)
      if (url) result[p.userId] = url
    })
  )

  return result
}

async function updateLobbyMessage(session: Session, client: Client): Promise<void> {
  const { channelName, hostTag } = await getLobbyMeta(session, client)
  const guild = await client.guilds.fetch(session.guildId)
  const channel = (await guild.channels.fetch(session.channelId)) as TextChannel
  const msg = await channel.messages.fetch(session.lobbyMessageId)

  const lobbyEmbed = buildLobbyEmbed(session, channelName, hostTag)
  const rows = buildSlotButtons(session)

  const playerImages = await buildPlayerImages(session, client)
  const registeredPlayers = session.players.filter(
    (p): p is Player => p !== null && p.name !== ""
  )
  const playerEmbeds = registeredPlayers.map((p) =>
    buildPlayerEmbed(p, playerImages[p.userId])
  )

  await msg.edit({ embeds: [lobbyEmbed, ...playerEmbeds], components: rows })
}

async function postLobbyEmbed(
  session: Session,
  channel: TextChannel,
  client: Client
): Promise<void> {
  const { channelName, hostTag } = await getLobbyMeta(session, client)
  const embed = buildLobbyEmbed(session, channelName, hostTag)
  const rows = buildSlotButtons(session)
  const lobbyMsg = await channel.send({ embeds: [embed], components: rows })
  sessionManager.setLobbyMessageId(session.channelId, lobbyMsg.id)
}

function makeSetupModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("setup_session_modal")
    .setTitle("Open DnD Session")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("slot_count")
          .setLabel("Slot count (1-8)")
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(1)
          .setPlaceholder("4")
          .setRequired(true)
      )
    )
}

function makeAdjustSlotsModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("adjust_slots_modal")
    .setTitle("Adjust Slot Count")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("slot_count")
          .setLabel("New slot count (1-8)")
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(1)
          .setPlaceholder("4")
          .setRequired(true)
      )
    )
}

function makeRegisterModal(slotIndex: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`register_player_modal_${slotIndex}`)
    .setTitle(`Register Slot ${slotIndex + 1}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("char_name")
          .setLabel("Character name")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(32)
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("char_class")
          .setLabel("Class")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(32)
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("char_hp")
          .setLabel("Max HP")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(5)
          .setRequired(false)
      )
    )
}

function makeSpawnMonsterModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("spawn_monster_modal")
    .setTitle("Spawn Monster")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("monster_name")
          .setLabel("Monster name")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(64)
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("monster_count")
          .setLabel("Count (1-20)")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(2)
          .setPlaceholder("1")
          .setRequired(true)
      )
    )
}

function makeSpawnMonsterStatModal(name: string, count: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("spawn_monster_stat_modal")
    .setTitle("Monster Stat")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("monster_name")
          .setLabel("Monster name")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(64)
          .setValue(name)
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("monster_count")
          .setLabel("Count (1-20)")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(2)
          .setValue(String(count))
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("monster_hp")
          .setLabel("HP")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(5)
          .setRequired(true)
      )
    )
}

function buildSpawnConfirmEmbed(name: string, count: number, hp: number, imageUrl: string | null): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle("Confirm Spawn")
    .setDescription(`**${name}** x${count} | ${hp} HP each`)
  if (imageUrl) embed.setThumbnail(imageUrl)
  return embed
}

function buildSpawnConfirmRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("spawn_confirm").setLabel("Spawn").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("spawn_edit").setLabel("Edit stat").setStyle(ButtonStyle.Secondary)
  )
}

function buildSpawnManualRow(name: string, count: number): ActionRowBuilder<ButtonBuilder> {
  const encoded = encodeURIComponent(`${name}|||${count}`)
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`spawn_manual_${encoded}`)
      .setLabel("Enter stat manually")
      .setStyle(ButtonStyle.Primary)
  )
}

async function executeSpawn(
  channelId: string,
  guildId: string,
  name: string,
  count: number,
  hp: number,
  client: Client
): Promise<void> {
  sessionManager.spawnEnemies(channelId, name, count, hp)
  const session = sessionManager.getSession(channelId)!
  const guild = await client.guilds.fetch(guildId)
  const channel = (await guild.channels.fetch(channelId)) as TextChannel
  const enemies = sessionManager.getEnemies(channelId)
  const embed = buildEnemyEmbed(enemies)

  if (session.combatMessageId) {
    try {
      const existing = await channel.messages.fetch(session.combatMessageId)
      await existing.edit({ embeds: [embed] })
      return
    } catch {
      // If the message was deleted, post a fresh one below.
    }
  }

  const msg = await channel.send({ embeds: [embed] })
  sessionManager.setCombatMessageId(channelId, msg.id)
}

async function handleStartSessionCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (sessionManager.getSession(interaction.channelId!)) {
    await interaction.reply({ content: "There is already an active session in this channel.", ephemeral: true })
    return
  }
  await interaction.showModal(makeSetupModal())
}

async function handleAdjustSlotsCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "No active session in this channel.", ephemeral: true })
    return
  }
  if (session.hostId !== interaction.user.id) {
    await interaction.reply({ content: "Only DM can adjust slots.", ephemeral: true })
    return
  }
  await interaction.showModal(makeAdjustSlotsModal())
}

async function handleClaimSlotButton(
  interaction: ButtonInteraction,
  client: Client
): Promise<void> {
  const slotIndex = parseInt(interaction.customId.replace("claim_slot_", ""), 10)
  const session = sessionManager.getSession(interaction.channelId!)

  if (!session) {
    await interaction.reply({ content: "Session not found.", ephemeral: true })
    return
  }
  if (slotIndex >= session.maxSlots) {
    await interaction.reply({ content: "This slot no longer exists.", ephemeral: true })
    return
  }

  const owner = sessionManager.getSlotOwner(session.channelId, slotIndex)
  if (owner && owner !== interaction.user.id) {
    await interaction.reply({ content: `Slot ${slotIndex + 1} is already taken.`, ephemeral: true })
    return
  }
  if (owner === interaction.user.id) {
    await interaction.showModal(makeRegisterModal(slotIndex))
    return
  }

  sessionManager.claimSlot(session.channelId, interaction.user.id, slotIndex)
  await interaction.showModal(makeRegisterModal(slotIndex))

  const updatedSession = sessionManager.getSession(session.channelId)!
  updateLobbyMessage(updatedSession, client).catch(console.error)
}

async function handleSetupSessionModal(
  interaction: ModalSubmitInteraction,
  client: Client
): Promise<void> {
  const countStr = interaction.fields.getTextInputValue("slot_count").trim()
  const count = parseInt(countStr, 10)

  if (isNaN(count) || count < 1 || count > 8) {
    await interaction.reply({ content: "Please enter a number from 1 to 8.", ephemeral: true })
    return
  }

  const session = sessionManager.createSession(
    interaction.channelId!,
    interaction.guildId!,
    interaction.user.id,
    count
  )

  const guild = await client.guilds.fetch(session.guildId)
  const allChannels = await guild.channels.fetch()
  const forumChannels = allChannels.filter(
    (ch): ch is ForumChannel => ch?.type === ChannelType.GuildForum
  )

  const channel = interaction.channel as TextChannel

  if (forumChannels.size === 0) {
    await postLobbyEmbed(session, channel, client)
    await interaction.reply({ content: `Session opened with ${count} slots.`, ephemeral: true })
    return
  }

  if (forumChannels.size === 1) {
    sessionManager.setForumChannel(session.channelId, forumChannels.first()!.id)
    await postLobbyEmbed(session, channel, client)
    await interaction.reply({ content: `Session opened with ${count} slots.`, ephemeral: true })
    return
  }

  const options = forumChannels.map((ch) => ({ label: ch.name, value: ch.id }))
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("select_forum_channel")
    .setPlaceholder("Choose Forum Channel for character images")
    .addOptions(options.slice(0, 25))

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)
  await interaction.reply({
    content: "Multiple Forum Channels found. Choose one for character images.",
    components: [row],
    ephemeral: true,
  })
}

async function handleForumSelectMenu(
  interaction: StringSelectMenuInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.update({ content: "Session not found.", components: [] })
    return
  }
  if (session.hostId !== interaction.user.id) {
    await interaction.reply({ content: "Only DM can choose this.", ephemeral: true })
    return
  }

  sessionManager.setForumChannel(session.channelId, interaction.values[0])
  const channel = interaction.channel as TextChannel
  await postLobbyEmbed(session, channel, client)
  await interaction.update({ content: "Session opened.", components: [] })
}

async function handleRegisterPlayerModal(
  interaction: ModalSubmitInteraction,
  client: Client
): Promise<void> {
  const slotIndex = parseInt(interaction.customId.replace("register_player_modal_", ""), 10)
  const session = sessionManager.getSession(interaction.channelId!)

  if (!session) {
    await interaction.reply({ content: "Session not found.", ephemeral: true })
    return
  }

  const name = interaction.fields.getTextInputValue("char_name").trim()
  const className = interaction.fields.getTextInputValue("char_class").trim()
  const hpRaw = interaction.fields.getTextInputValue("char_hp").trim()

  let maxHp: number
  if (hpRaw) {
    maxHp = parseInt(hpRaw, 10)
    if (isNaN(maxHp) || maxHp <= 0) {
      await interaction.reply({ content: "HP must be a number greater than 0.", ephemeral: true })
      return
    }
  } else {
    maxHp = getDefaultHp(className)
  }

  const success = sessionManager.registerPlayer(session.channelId, {
    userId: interaction.user.id,
    slotIndex,
    name,
    className,
    maxHp,
  })

  if (!success) {
    await interaction.reply({ content: "Could not register this slot.", ephemeral: true })
    return
  }

  await interaction.reply({
    content: `Registered **${name}** the **${className}** with ${maxHp} HP (Slot ${slotIndex + 1}).`,
    ephemeral: true,
  })

  const updatedSession = sessionManager.getSession(session.channelId)!
  updateLobbyMessage(updatedSession, client).catch(console.error)
}

async function handleAdjustSlotsModal(
  interaction: ModalSubmitInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "Session not found.", ephemeral: true })
    return
  }

  const countStr = interaction.fields.getTextInputValue("slot_count").trim()
  const newCount = parseInt(countStr, 10)

  if (isNaN(newCount) || newCount < 1 || newCount > 8) {
    await interaction.reply({ content: "Please enter a number from 1 to 8.", ephemeral: true })
    return
  }

  const evicted = sessionManager.setSlotCount(session.channelId, newCount)
  await interaction.reply({ content: `Slot count adjusted to ${newCount}.`, ephemeral: true })

  if (evicted.length > 0) {
    const mentions = evicted.map((id) => `<@${id}>`).join(", ")
    await interaction.followUp({ content: `Removed players: ${mentions}`, ephemeral: true })
  }

  const updatedSession = sessionManager.getSession(session.channelId)!
  updateLobbyMessage(updatedSession, client).catch(console.error)
}

async function handleSpawnMonsterCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "No active session in this channel.", ephemeral: true })
    return
  }
  if (session.hostId !== interaction.user.id) {
    await interaction.reply({ content: "Only DM can use this command.", ephemeral: true })
    return
  }
  await interaction.showModal(makeSpawnMonsterModal())
}

async function handleSpawnMonsterModal(
  interaction: ModalSubmitInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "Session not found.", ephemeral: true })
    return
  }

  const name = interaction.fields.getTextInputValue("monster_name").trim()
  const countStr = interaction.fields.getTextInputValue("monster_count").trim()
  const count = parseInt(countStr, 10)

  if (isNaN(count) || count < 1 || count > 20) {
    await interaction.reply({ content: "Count must be a number from 1 to 20.", ephemeral: true })
    return
  }

  if (session.forumChannelId) {
    const guild = await client.guilds.fetch(session.guildId)
    const stat = await findForumMonsterStat(guild, session.forumChannelId, name)
    if (stat) {
      pendingSpawns.set(interaction.user.id, { name, count, hp: stat.hp, imageUrl: stat.imageUrl })
      await interaction.reply({
        embeds: [buildSpawnConfirmEmbed(name, count, stat.hp, stat.imageUrl)],
        components: [buildSpawnConfirmRow()],
        ephemeral: true,
      })
      return
    }
  }

  await interaction.reply({
    content: `Could not find **${name}** in Forum. Please enter stats manually.`,
    components: [buildSpawnManualRow(name, count)],
    ephemeral: true,
  })
}

async function handleSpawnConfirmButton(
  interaction: ButtonInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.update({ content: "Session not found.", components: [], embeds: [] })
    return
  }
  const pending = pendingSpawns.get(interaction.user.id)
  if (!pending) {
    await interaction.update({ content: "Spawn expired. Please try /spawn-monster again.", components: [], embeds: [] })
    return
  }
  pendingSpawns.delete(interaction.user.id)
  await interaction.update({ content: "Spawning...", components: [], embeds: [] })
  await executeSpawn(session.channelId, session.guildId, pending.name, pending.count, pending.hp, client)
  await interaction.editReply({ content: `Spawned **${pending.name}** x${pending.count}.` })
}

async function handleSpawnEditButton(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingSpawns.get(interaction.user.id)
  if (!pending) {
    await interaction.update({ content: "Spawn expired. Please try /spawn-monster again.", components: [], embeds: [] })
    return
  }
  await interaction.showModal(makeSpawnMonsterStatModal(pending.name, pending.count))
}

async function handleSpawnManualButton(interaction: ButtonInteraction): Promise<void> {
  const encoded = interaction.customId.replace("spawn_manual_", "")
  const decoded = decodeURIComponent(encoded)
  const [name, countStr] = decoded.split("|||")
  const count = parseInt(countStr, 10)
  if (!name || isNaN(count)) {
    await interaction.reply({ content: "Invalid data. Please try /spawn-monster again.", ephemeral: true })
    return
  }
  await interaction.showModal(makeSpawnMonsterStatModal(name, count))
}

async function handleSpawnMonsterStatModal(
  interaction: ModalSubmitInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "Session not found.", ephemeral: true })
    return
  }

  const name = interaction.fields.getTextInputValue("monster_name").trim()
  const countStr = interaction.fields.getTextInputValue("monster_count").trim()
  const hpStr = interaction.fields.getTextInputValue("monster_hp").trim()
  const count = parseInt(countStr, 10)
  const hp = parseInt(hpStr, 10)

  if (isNaN(count) || count < 1 || count > 20) {
    await interaction.reply({ content: "Count must be a number from 1 to 20.", ephemeral: true })
    return
  }
  if (isNaN(hp) || hp <= 0) {
    await interaction.reply({ content: "HP must be a number greater than 0.", ephemeral: true })
    return
  }

  pendingSpawns.delete(interaction.user.id)
  await interaction.reply({ content: "Spawning...", ephemeral: true })
  await executeSpawn(session.channelId, session.guildId, name, count, hp, client)
  await interaction.editReply({ content: `Spawned **${name}** x${count}.` })
}

export async function handleInteraction(interaction: Interaction, client: Client): Promise<void> {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "start-session") return handleStartSessionCommand(interaction)
    if (interaction.commandName === "adjust-slots") return handleAdjustSlotsCommand(interaction)
    if (interaction.commandName === "spawn-monster") return handleSpawnMonsterCommand(interaction)
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("claim_slot_")) return handleClaimSlotButton(interaction, client)
    if (interaction.customId === "spawn_confirm") return handleSpawnConfirmButton(interaction, client)
    if (interaction.customId === "spawn_edit") return handleSpawnEditButton(interaction)
    if (interaction.customId.startsWith("spawn_manual_")) return handleSpawnManualButton(interaction)
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "select_forum_channel") return handleForumSelectMenu(interaction, client)
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "setup_session_modal") return handleSetupSessionModal(interaction, client)
    if (interaction.customId === "adjust_slots_modal") return handleAdjustSlotsModal(interaction, client)
    if (interaction.customId.startsWith("register_player_modal_")) return handleRegisterPlayerModal(interaction, client)
    if (interaction.customId === "spawn_monster_modal") return handleSpawnMonsterModal(interaction, client)
    if (interaction.customId === "spawn_monster_stat_modal") return handleSpawnMonsterStatModal(interaction, client)
  }
}
