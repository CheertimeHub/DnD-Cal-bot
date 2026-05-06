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
  Message,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js"
import * as combatManager from "../systems/combatManager"
import * as sessionManager from "../systems/sessionManager"
import { buildCombatEmbed, buildLobbyEmbed, buildPlayerEmbed, buildSlotButtons } from "../utils/embed"
import { getDefaultHp } from "../utils/classHp"
import { findForumMonsterStat, findForumPostImage } from "../utils/forumSearch"
import { CombatActionType, CombatActor, Player, Session } from "../types/session"

// ── pending spawn state ───────────────────────────────────────────────────────

interface PendingSpawn {
  name: string
  count: number
  hp: number
  imageUrl: string | null
}
const pendingSpawns = new Map<string, PendingSpawn>()

// ── helpers ──────────────────────────────────────────────────────────────────

async function getLobbyMeta(
  session: Session,
  client: Client
): Promise<{ channelName: string; hostTag: string }> {
  const guild = client.guilds.cache.get(session.guildId)
  const channel = guild?.channels.cache.get(session.channelId)
  const channelName = channel && "name" in channel ? (channel as TextChannel).name : "DnD Session"
  const hostTag = client.users.cache.get(session.hostId)?.tag ?? `DM ${session.hostId}`
  return { channelName, hostTag }
}

async function buildPlayerImages(
  session: Session,
  client: Client
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  if (!session.forumChannelId) return result

  const guild = client.guilds.cache.get(session.guildId)
  if (!guild) return result
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
  const guild = client.guilds.cache.get(session.guildId)
  const channel = guild?.channels.cache.get(session.channelId) as TextChannel | undefined
  if (!channel) return
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

function buildCombatActionRows(session: Session): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("combat_action_attack")
        .setLabel("Attack")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("combat_action_damage")
        .setLabel("Damage")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("combat_action_heal")
        .setLabel("Heal")
        .setStyle(ButtonStyle.Success)
    ),
  ]

  for (const attack of session.activeAttacks.filter((a) => a.status === "awaiting_response").slice(0, 4)) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`combat_dodge_${attack.id}`)
          .setLabel("Dodge")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`combat_take_${attack.id}`)
          .setLabel("Take Hit")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`combat_cancel_${attack.id}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
      )
    )
  }

  return rows
}

async function updateCombatMessage(session: Session, client: Client): Promise<void> {
  const guild = client.guilds.cache.get(session.guildId)
  const channel = guild?.channels.cache.get(session.channelId) as TextChannel | undefined
  if (!channel) return
  const embed = buildCombatEmbed(session)
  const components = buildCombatActionRows(session)

  if (session.combatMessageId) {
    try {
      const existing = await channel.messages.fetch(session.combatMessageId)
      await existing.edit({ embeds: [embed], components })
      return
    } catch {
      // If the combat message was deleted, post a fresh one below.
    }
  }

  const msg = await channel.send({ embeds: [embed], components })
  sessionManager.setCombatMessageId(session.channelId, msg.id)
}

function actorSelectOption(session: Session, actor: CombatActor): { label: string; value: string } {
  return {
    label: combatManager.getActorLabel(session, actor).slice(0, 100),
    value: combatManager.encodeActor(actor),
  }
}

function buildSourceSelect(
  session: Session,
  action: CombatActionType,
  userId: string
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const actors = combatManager
    .getActors(session)
    .filter((actor) => combatManager.canControlActor(session, userId, actor))

  if (actors.length === 0) return null

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`combat_source_${action}`)
      .setPlaceholder(`Choose ${combatManager.actionLabel(action)} source`)
      .addOptions(actors.slice(0, 25).map((actor) => actorSelectOption(session, actor)))
  )
}

function buildTargetSelect(
  session: Session,
  action: CombatActionType,
  source: CombatActor
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const sourceKey = combatManager.encodeActor(source)
  const actors = combatManager
    .getActors(session)
    .filter((actor) => action === "heal" || combatManager.encodeActor(actor) !== sourceKey)

  if (actors.length === 0) return null

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`combat_target_${action}_${sourceKey}`)
      .setPlaceholder(`Choose ${combatManager.actionLabel(action)} target`)
      .addOptions(actors.slice(0, 25).map((actor) => actorSelectOption(session, actor)))
  )
}

// ── modals ────────────────────────────────────────────────────────────────────

function makeSetupModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("setup_session_modal")
    .setTitle("เปิด DnD Session")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("slot_count")
          .setLabel("จำนวน Slot (1–8)")
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
    .setTitle("ปรับจำนวน Slot")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("slot_count")
          .setLabel("จำนวน Slot ใหม่ (1–8)")
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
    .setTitle(`ลงทะเบียน Slot ${slotIndex + 1}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("char_name")
          .setLabel("ชื่อตัวละคร")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(32)
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("char_class")
          .setLabel("คลาส")
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
          .setLabel("ชื่อมอนสเตอร์")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(64)
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("monster_count")
          .setLabel("จำนวน (1–20)")
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
    .setTitle("กรอก Stat มอนสเตอร์")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("monster_name")
          .setLabel("ชื่อมอนสเตอร์")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(64)
          .setValue(name)
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("monster_count")
          .setLabel("จำนวน (1–20)")
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
    .setTitle("⚠️ ยืนยันการ Spawn")
    .setDescription(`**${name}** x${count} | ❤️ ${hp} HP each`)
  if (imageUrl) embed.setThumbnail(imageUrl)
  return embed
}

function buildSpawnConfirmRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("spawn_confirm").setLabel("✅ Spawn").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("spawn_edit").setLabel("✏️ แก้ stat").setStyle(ButtonStyle.Secondary)
  )
}

function buildSpawnManualRow(name: string, count: number): ActionRowBuilder<ButtonBuilder> {
  const encoded = encodeURIComponent(`${name}|||${count}`)
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`spawn_manual_${encoded}`)
      .setLabel("📝 กรอก stat เอง")
      .setStyle(ButtonStyle.Primary)
  )
}

async function executeSpawn(
  channelId: string,
  _guildId: string,
  name: string,
  count: number,
  hp: number,
  client: Client
): Promise<void> {
  sessionManager.spawnEnemies(channelId, name, count, hp)
  const session = sessionManager.getSession(channelId)!
  session.state = "combat"
  await updateCombatMessage(session, client)
}

// ── slash commands ────────────────────────────────────────────────────────────

async function handleStartSessionCommand(
  interaction: ChatInputCommandInteraction,
  client: Client
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  if (sessionManager.getSession(interaction.channelId!)) {
    await interaction.editReply({ content: "There is already an active session in this channel." })
    return
  }

  const count = interaction.options.getInteger("slots") ?? 4
  if (count < 1 || count > 8) {
    await interaction.editReply({ content: "Slot count must be between 1 and 8." })
    return
  }

  const session = sessionManager.createSession(
    interaction.channelId!,
    interaction.guildId!,
    interaction.user.id,
    count
  )

  const guild = interaction.guild ?? client.guilds.cache.get(session.guildId)
  const allChannels = guild?.channels.cache
  const forumChannels = allChannels?.filter(
    (ch): ch is ForumChannel => ch?.type === ChannelType.GuildForum
  )

  const channel = interaction.channel as TextChannel

  if (!forumChannels || forumChannels.size === 0) {
    await postLobbyEmbed(session, channel, client)
    await interaction.editReply({ content: `Session opened with ${count} slots.` })
    return
  }

  if (forumChannels.size === 1) {
    sessionManager.setForumChannel(session.channelId, forumChannels.first()!.id)
    await postLobbyEmbed(session, channel, client)
    await interaction.editReply({ content: `Session opened with ${count} slots.` })
    return
  }

  const options = forumChannels.map((ch) => ({ label: ch.name, value: ch.id }))
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("select_forum_channel")
    .setPlaceholder("Choose Forum Channel for character/monster lookup")
    .addOptions(options.slice(0, 25))

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)
  await interaction.editReply({
    content: "Multiple Forum Channels found. Choose one for character/monster lookup.",
    components: [row],
  })
}

async function handleStartSessionCommandOld(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (sessionManager.getSession(interaction.channelId!)) {
    await interaction.reply({ content: "⚠️ มี session ที่เปิดอยู่แล้วใน channel นี้", ephemeral: true })
    return
  }
  await interaction.showModal(makeSetupModal())
}

async function handleAdjustSlotsCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "⚠️ ยังไม่มี session ใน channel นี้", ephemeral: true })
    return
  }
  if (session.hostId !== interaction.user.id) {
    await interaction.reply({ content: "❌ เฉพาะ DM เท่านั้นที่ปรับได้", ephemeral: true })
    return
  }
  await interaction.showModal(makeAdjustSlotsModal())
}

// ── buttons ───────────────────────────────────────────────────────────────────

async function handleClaimSlotButton(
  interaction: ButtonInteraction,
  client: Client
): Promise<void> {
  const slotIndex = parseInt(interaction.customId.replace("claim_slot_", ""), 10)
  const session = sessionManager.getSession(interaction.channelId!)

  if (!session) {
    await interaction.reply({ content: "⚠️ ไม่พบ session", ephemeral: true })
    return
  }
  if (slotIndex >= session.maxSlots) {
    await interaction.reply({ content: "⚠️ Slot นี้ไม่มีอยู่แล้ว", ephemeral: true })
    return
  }

  const owner = sessionManager.getSlotOwner(session.channelId, slotIndex)
  if (owner && owner !== interaction.user.id) {
    await interaction.reply({ content: `❌ Slot ${slotIndex + 1} ถูกจองไปแล้ว`, ephemeral: true })
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

// ── modal submits ─────────────────────────────────────────────────────────────

async function handleSetupSessionModal(
  interaction: ModalSubmitInteraction,
  client: Client
): Promise<void> {
  const countStr = interaction.fields.getTextInputValue("slot_count").trim()
  const count = parseInt(countStr, 10)

  if (isNaN(count) || count < 1 || count > 8) {
    await interaction.reply({ content: "⚠️ กรุณากรอกตัวเลข 1–8", ephemeral: true })
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
    await interaction.reply({ content: `✅ Session เปิดแล้ว! ${count} slot พร้อมใช้งาน`, ephemeral: true })

  } else if (forumChannels.size === 1) {
    sessionManager.setForumChannel(session.channelId, forumChannels.first()!.id)
    await postLobbyEmbed(session, channel, client)
    await interaction.reply({ content: `✅ Session เปิดแล้ว! ${count} slot พร้อมใช้งาน`, ephemeral: true })

  } else {
    const options = forumChannels.map((ch) => ({ label: ch.name, value: ch.id }))

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("select_forum_channel")
      .setPlaceholder("เลือก Forum Channel สำหรับค้นหารูปตัวละคร")
      .addOptions(options)

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await interaction.reply({
      content: "🗂️ พบหลาย Forum Channel — เลือกที่จะใช้ค้นหารูปตัวละคร",
      components: [row],
      ephemeral: true,
    })
  }
}

async function handleForumSelectMenu(
  interaction: StringSelectMenuInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.update({ content: "⚠️ ไม่พบ session", components: [] })
    return
  }
  if (session.hostId !== interaction.user.id) {
    await interaction.reply({ content: "❌ เฉพาะ DM เท่านั้นที่เลือกได้", ephemeral: true })
    return
  }

  sessionManager.setForumChannel(session.channelId, interaction.values[0])

  const channel = interaction.channel as TextChannel
  await postLobbyEmbed(session, channel, client)

  await interaction.update({ content: "✅ Session เปิดแล้ว!", components: [] })
}

async function handleRegisterPlayerModal(
  interaction: ModalSubmitInteraction,
  client: Client
): Promise<void> {
  const slotIndex = parseInt(interaction.customId.replace("register_player_modal_", ""), 10)
  const session = sessionManager.getSession(interaction.channelId!)

  if (!session) {
    await interaction.reply({ content: "⚠️ ไม่พบ session", ephemeral: true })
    return
  }

  const name = interaction.fields.getTextInputValue("char_name").trim()
  const className = interaction.fields.getTextInputValue("char_class").trim()
  const hpRaw = interaction.fields.getTextInputValue("char_hp").trim()

  let maxHp: number
  if (hpRaw) {
    maxHp = parseInt(hpRaw, 10)
    if (isNaN(maxHp) || maxHp <= 0) {
      await interaction.reply({ content: "⚠️ HP ต้องเป็นตัวเลขที่มากกว่า 0", ephemeral: true })
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
    await interaction.reply({ content: "❌ เกิดข้อผิดพลาด ไม่สามารถลงทะเบียนได้", ephemeral: true })
    return
  }

  await interaction.reply({
    content: `✅ ลงทะเบียนสำเร็จ! **${name}** the **${className}** ❤️ ${maxHp} HP (Slot ${slotIndex + 1})`,
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
    await interaction.reply({ content: "⚠️ ไม่พบ session", ephemeral: true })
    return
  }

  const countStr = interaction.fields.getTextInputValue("slot_count").trim()
  const newCount = parseInt(countStr, 10)

  if (isNaN(newCount) || newCount < 1 || newCount > 8) {
    await interaction.reply({ content: "⚠️ กรุณากรอกตัวเลข 1–8", ephemeral: true })
    return
  }

  const evicted = sessionManager.setSlotCount(session.channelId, newCount)

  await interaction.reply({ content: `✅ ปรับเป็น ${newCount} slot แล้ว`, ephemeral: true })

  if (evicted.length > 0) {
    const mentions = evicted.map((id) => `<@${id}>`).join(", ")
    await interaction.followUp({ content: `⚠️ ผู้เล่นที่ถูกนำออก: ${mentions}`, ephemeral: true })
  }

  const updatedSession = sessionManager.getSession(session.channelId)!
  updateLobbyMessage(updatedSession, client).catch(console.error)
}

async function handleSpawnMonsterCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "⚠️ ยังไม่มี session ใน channel นี้", ephemeral: true })
    return
  }
  if (session.hostId !== interaction.user.id) {
    await interaction.reply({ content: "❌ เฉพาะ DM เท่านั้นที่ใช้คำสั่งนี้ได้", ephemeral: true })
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
    await interaction.reply({ content: "⚠️ ไม่พบ session", ephemeral: true })
    return
  }

  const name = interaction.fields.getTextInputValue("monster_name").trim()
  const countStr = interaction.fields.getTextInputValue("monster_count").trim()
  const count = parseInt(countStr, 10)

  if (isNaN(count) || count < 1 || count > 20) {
    await interaction.reply({ content: "⚠️ จำนวนต้องเป็นตัวเลข 1–20", ephemeral: true })
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

  // ไม่เจอ forum stat → ให้กดปุ่มเพื่อเปิด stat modal (modal-from-modal ไม่ได้)
  await interaction.reply({
    content: `ไม่พบ **${name}** ใน Forum กรุณากรอก stat เอง`,
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
    await interaction.update({ content: "⚠️ ไม่พบ session", components: [], embeds: [] })
    return
  }
  const pending = pendingSpawns.get(interaction.user.id)
  if (!pending) {
    await interaction.update({ content: "⚠️ หมดเวลา กรุณาลอง /spawn-monster ใหม่", components: [], embeds: [] })
    return
  }
  pendingSpawns.delete(interaction.user.id)
  await interaction.update({ content: "⏳ กำลัง spawn...", components: [], embeds: [] })
  await executeSpawn(session.channelId, session.guildId, pending.name, pending.count, pending.hp, client)
  await interaction.editReply({ content: `✅ Spawned **${pending.name}** x${pending.count}!` })
}

async function handleSpawnEditButton(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingSpawns.get(interaction.user.id)
  if (!pending) {
    await interaction.update({ content: "⚠️ หมดเวลา กรุณาลอง /spawn-monster ใหม่", components: [], embeds: [] })
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
    await interaction.reply({ content: "⚠️ ข้อมูลไม่ถูกต้อง กรุณาลอง /spawn-monster ใหม่", ephemeral: true })
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
    await interaction.reply({ content: "⚠️ ไม่พบ session", ephemeral: true })
    return
  }

  const name = interaction.fields.getTextInputValue("monster_name").trim()
  const countStr = interaction.fields.getTextInputValue("monster_count").trim()
  const hpStr = interaction.fields.getTextInputValue("monster_hp").trim()
  const count = parseInt(countStr, 10)
  const hp = parseInt(hpStr, 10)

  if (isNaN(count) || count < 1 || count > 20) {
    await interaction.reply({ content: "⚠️ จำนวนต้องเป็นตัวเลข 1–20", ephemeral: true })
    return
  }
  if (isNaN(hp) || hp <= 0) {
    await interaction.reply({ content: "⚠️ HP ต้องเป็นตัวเลขที่มากกว่า 0", ephemeral: true })
    return
  }

  pendingSpawns.delete(interaction.user.id)
  await interaction.reply({ content: "⏳ กำลัง spawn...", ephemeral: true })
  await executeSpawn(session.channelId, session.guildId, name, count, hp, client)
  await interaction.editReply({ content: `✅ Spawned **${name}** x${count}!` })
}

// ── main router ───────────────────────────────────────────────────────────────

async function handleCombatActionButton(
  interaction: ButtonInteraction,
  action: CombatActionType
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "No active session in this channel.", ephemeral: true })
    return
  }

  const row = buildSourceSelect(session, action, interaction.user.id)
  if (!row) {
    await interaction.reply({ content: "You do not control any combat actor.", ephemeral: true })
    return
  }

  await interaction.reply({
    content: `Choose who will ${combatManager.actionLabel(action).toLowerCase()}.`,
    components: [row],
    ephemeral: true,
  })
}

async function handleCombatSourceSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.update({ content: "No active session in this channel.", components: [] })
    return
  }

  const action = interaction.customId.replace("combat_source_", "") as CombatActionType
  const source = combatManager.decodeActor(interaction.values[0])
  if (!source || !combatManager.canControlActor(session, interaction.user.id, source)) {
    await interaction.update({ content: "Invalid source.", components: [] })
    return
  }

  const row = buildTargetSelect(session, action, source)
  if (!row) {
    await interaction.update({ content: "No valid targets.", components: [] })
    return
  }

  await interaction.update({
    content: `Choose ${combatManager.actionLabel(action).toLowerCase()} target for ${combatManager.getActorLabel(session, source)}.`,
    components: [row],
  })
}

async function handleCombatTargetSelect(
  interaction: StringSelectMenuInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.update({ content: "No active session in this channel.", components: [] })
    return
  }

  const raw = interaction.customId.replace("combat_target_", "")
  const firstSeparator = raw.indexOf("_")
  const action = raw.slice(0, firstSeparator) as CombatActionType
  const source = combatManager.decodeActor(raw.slice(firstSeparator + 1))
  const target = combatManager.decodeActor(interaction.values[0])

  if (!source || !target || !combatManager.canControlActor(session, interaction.user.id, source)) {
    await interaction.update({ content: "Invalid combat action.", components: [] })
    return
  }

  combatManager.startPendingAction(session, {
    userId: interaction.user.id,
    type: action,
    source,
    target,
  })
  combatManager.addCombatLog(
    session,
    `${combatManager.getActorLabel(session, source)} will ${combatManager.actionLabel(action).toLowerCase()} ${combatManager.getActorLabel(session, target)}. Waiting for <@${interaction.user.id}> to roll.`
  )

  await updateCombatMessage(session, client)
  await interaction.update({
    content: `Ready. Roll with Rollem now; the next matching Rollem result will be used for ${combatManager.actionLabel(action)}.`,
    components: [],
  })
}

async function handleCombatDodgeButton(
  interaction: ButtonInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "No active session in this channel.", ephemeral: true })
    return
  }
  const result = combatManager.requestDodge(session, interaction.customId.replace("combat_dodge_", ""), interaction.user.id)
  await updateCombatMessage(session, client)
  await interaction.reply({ content: result.message ?? "Roll Dodge with Rollem now.", ephemeral: true })
}

async function handleCombatTakeHitButton(
  interaction: ButtonInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "No active session in this channel.", ephemeral: true })
    return
  }
  const result = combatManager.takeHit(session, interaction.customId.replace("combat_take_", ""), interaction.user.id)
  await updateCombatMessage(session, client)
  await interaction.reply({ content: result.message ?? "Resolved.", ephemeral: true })
}

async function handleCombatCancelButton(
  interaction: ButtonInteraction,
  client: Client
): Promise<void> {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) {
    await interaction.reply({ content: "No active session in this channel.", ephemeral: true })
    return
  }
  const result = combatManager.cancelAttack(session, interaction.customId.replace("combat_cancel_", ""), interaction.user.id)
  await updateCombatMessage(session, client)
  await interaction.reply({ content: result.message ?? "Cancelled.", ephemeral: true })
}

function parseRollemNumericValue(content: string): number | null {
  const equalsMatch = content.match(/=\s*(-?\d+)(?!.*=\s*-?\d+)/s)
  if (equalsMatch) return parseInt(equalsMatch[1], 10)

  const matches = [...content.matchAll(/-?\d+/g)]
  if (matches.length === 0) return null
  return parseInt(matches[matches.length - 1][0], 10)
}

async function findRollOwnerId(message: Message, session: Session): Promise<string | null> {
  const pendingUserIds = new Set(session.pendingActions.map((a) => a.userId))

  if (message.reference?.messageId && "messages" in message.channel) {
    try {
      const channel = message.channel as TextChannel
      const referenced = await channel.messages.fetch(message.reference.messageId)
      if (pendingUserIds.has(referenced.author.id)) return referenced.author.id
    } catch {
      // Fall back to content matching below.
    }
  }

  const mentionedUser = message.mentions.users.find((user) => pendingUserIds.has(user.id))
  if (mentionedUser) return mentionedUser.id

  return pendingUserIds.size === 1 ? [...pendingUserIds][0] : null
}

export async function handleRollemMessage(message: Message, client: Client): Promise<void> {
  if (!message.author.bot || message.author.id === client.user?.id) return
  const rollemBotId = process.env.ROLLEM_BOT_ID
  if (rollemBotId && message.author.id !== rollemBotId) return
  if (!rollemBotId && !message.author.username.toLowerCase().includes("rollem")) return

  const session = sessionManager.getSession(message.channelId)
  if (!session || session.pendingActions.length === 0) return

  const value = parseRollemNumericValue(message.content)
  if (value === null) return

  const userId = await findRollOwnerId(message, session)
  if (!userId) return

  const result = combatManager.consumeRollemRoll(session, userId, value, message.content)
  if (!result.consumed) return
  await updateCombatMessage(session, client)
}

export async function handleInteraction(interaction: Interaction, client: Client): Promise<void> {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "start-session") return handleStartSessionCommand(interaction, client)
    if (interaction.commandName === "adjust-slots") return handleAdjustSlotsCommand(interaction)
    if (interaction.commandName === "spawn-monster") return handleSpawnMonsterCommand(interaction)
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("claim_slot_")) return handleClaimSlotButton(interaction, client)
    if (interaction.customId === "spawn_confirm") return handleSpawnConfirmButton(interaction, client)
    if (interaction.customId === "spawn_edit") return handleSpawnEditButton(interaction)
    if (interaction.customId.startsWith("spawn_manual_")) return handleSpawnManualButton(interaction)
    if (interaction.customId === "combat_action_attack") return handleCombatActionButton(interaction, "attack")
    if (interaction.customId === "combat_action_damage") return handleCombatActionButton(interaction, "damage")
    if (interaction.customId === "combat_action_heal") return handleCombatActionButton(interaction, "heal")
    if (interaction.customId.startsWith("combat_dodge_")) return handleCombatDodgeButton(interaction, client)
    if (interaction.customId.startsWith("combat_take_")) return handleCombatTakeHitButton(interaction, client)
    if (interaction.customId.startsWith("combat_cancel_")) return handleCombatCancelButton(interaction, client)
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "select_forum_channel") {
      return handleForumSelectMenu(interaction, client)
    }
    if (interaction.customId.startsWith("combat_source_")) {
      return handleCombatSourceSelect(interaction)
    }
    if (interaction.customId.startsWith("combat_target_")) {
      return handleCombatTargetSelect(interaction, client)
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "setup_session_modal") return handleSetupSessionModal(interaction, client)
    if (interaction.customId === "adjust_slots_modal") return handleAdjustSlotsModal(interaction, client)
    if (interaction.customId.startsWith("register_player_modal_")) return handleRegisterPlayerModal(interaction, client)
    if (interaction.customId === "spawn_monster_modal") return handleSpawnMonsterModal(interaction, client)
    if (interaction.customId === "spawn_monster_stat_modal") return handleSpawnMonsterStatModal(interaction, client)
  }
}
