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
import * as combatManager from "../systems/combatManager"
import * as sessionManager from "../systems/sessionManager"
import {
  buildCombatEmbed,
  buildLobbyComponents,
  buildLobbyEmbed,
  buildPlayerEmbed,
} from "../utils/embed"
import { getDefaultHp } from "../utils/classHp"
import { findForumMonsterStat, findForumPostImage, findThreadIdByName, getImageFromThreadId, listForumThreads, parseStatsFromThread } from "../utils/forumSearch"
import { CombatActionType, CombatActor, Player, Session } from "../types/session"

// ── pending spawn ─────────────────────────────────────────────────────────────

interface PendingSpawn { name: string; count: number; hp: number; imageUrl: string | null }
const pendingSpawns = new Map<string, PendingSpawn>()

// เก็บ spawn manual data แยก เพราะชื่อมอนอาจยาวเกิน customId 100 ตัว
const pendingSpawnManual = new Map<string, { name: string; count: number }>()

// เก็บ rollText ไว้แยกต่างหาก เพราะ customId จำกัด 100 ตัวอักษร
const pendingRollTexts = new Map<string, string>()  // key = `${userId}_${value}` → rollText

// เก็บ CC target ไว้รอให้เลือก status
export const pendingCcTargets = new Map<string, { targetKey: string; targetName: string }>()  // key = userId

// ── shared helpers ────────────────────────────────────────────────────────────

async function getLobbyMeta(session: Session, client: Client) {
  const guild = await client.guilds.fetch(session.guildId)
  const channel = await guild.channels.fetch(session.channelId)
  const channelName = channel && "name" in channel ? (channel as TextChannel).name : "DnD Session"
  const host = await client.users.fetch(session.hostId)
  return { channelName, hostTag: host.tag }
}

function buildPlayerImages(session: Session): Record<number, string> {
  const result: Record<number, string> = {}
  for (const p of session.players) {
    if (p && p.name && p.avatarUrl) result[p.slotIndex] = p.avatarUrl
  }
  return result
}

export async function updateLobbyMessage(session: Session, client: Client): Promise<void> {
  const { channelName, hostTag } = await getLobbyMeta(session, client)
  const guild = await client.guilds.fetch(session.guildId)
  const channel = (await guild.channels.fetch(session.channelId)) as TextChannel
  const msg = await channel.messages.fetch(session.lobbyMessageId)

  const playerImages = buildPlayerImages(session)
  const registered = session.players.filter((p): p is Player => p !== null && p.name !== "")
  const playerEmbeds = registered.map((p) => buildPlayerEmbed(p, playerImages[p.slotIndex]))

  await msg.edit({
    embeds: [buildLobbyEmbed(session, channelName, hostTag), ...playerEmbeds],
    components: buildLobbyComponents(session),
  })
}

async function postLobbyEmbed(session: Session, channel: TextChannel, client: Client): Promise<void> {
  const { channelName, hostTag } = await getLobbyMeta(session, client)
  const msg = await channel.send({
    embeds: [buildLobbyEmbed(session, channelName, hostTag)],
    components: buildLobbyComponents(session),
  })
  sessionManager.setLobbyMessageId(session.channelId, msg.id)
}

export async function updateCombatMessage(session: Session, client: Client): Promise<void> {
  const guild = await client.guilds.fetch(session.guildId)
  const channel = (await guild.channels.fetch(session.channelId)) as TextChannel
  const embed = buildCombatEmbed(session)
  const components = buildCombatActionRows(session)

  if (session.combatMessageId) {
    try {
      const existing = await channel.messages.fetch(session.combatMessageId)
      await existing.edit({ embeds: [embed], components })
      return
    } catch { /* ถูกลบ → โพสต์ใหม่ */ }
  }

  const msg = await channel.send({ embeds: [embed], components })
  sessionManager.setCombatMessageId(session.channelId, msg.id)
}

export function buildAttackResponseRow(attackId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`combat_dodge_${attackId}`).setLabel("🛡️ Dodge").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`combat_defend_${attackId}`).setLabel("🔰 Defend").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`combat_take_${attackId}`).setLabel("⚔️ Take Hit").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`combat_cancel_${attackId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  )
}

function buildCombatActionRows(session: Session): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = []

  if (session.state === "combat") {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("combat_action_attack").setLabel("⚔️ Attack").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("combat_action_heal").setLabel("🩹 Heal").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("combat_action_monster").setLabel("🐉 Monster").setStyle(ButtonStyle.Secondary),
      )
    )
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("combat_action_cc").setLabel("🔮 CC").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("combat_action_buff").setLabel("✨ Buff/Debuff").setStyle(ButtonStyle.Primary),
      )
    )

    for (const attack of session.activeAttacks.filter((a) => a.status === "awaiting_response").slice(0, 3)) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`combat_dodge_${attack.id}`).setLabel("🛡️ Dodge").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`combat_defend_${attack.id}`).setLabel("🔰 Defend").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`combat_take_${attack.id}`).setLabel("⚔️ Take Hit").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`combat_cancel_${attack.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
        )
      )
    }
  }

  return rows
}

function actorOption(session: Session, actor: CombatActor) {
  return { label: combatManager.getActorLabel(session, actor).slice(0, 100), value: combatManager.encodeActor(actor) }
}

function buildTargetSelect(
  session: Session,
  action: CombatActionType,
  source: CombatActor
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const sourceKey = combatManager.encodeActor(source)
  let actors: CombatActor[]
  if (action === "heal" || action === "buff") {
    // heal/buff: เฉพาะ player (รวม dead), ไม่กรอง source ออก
    actors = combatManager.getActors(session).filter((a) => a.type === "player")
  } else if (action === "cc") {
    // cc: เป้าหมายได้ทั้ง player และ enemy ที่ยังมีชีวิต, ไม่รวม source
    actors = combatManager.getActors(session, true).filter(
      (a) => combatManager.encodeActor(a) !== sourceKey
    )
  } else {
    // attack/dodge/defend/explore: เฉพาะ actor ที่ยังมีชีวิต, ไม่รวม source
    actors = combatManager.getActors(session, true).filter(
      (a) => combatManager.encodeActor(a) !== sourceKey
    )
  }
  if (actors.length === 0) return null
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`combat_target_${action}_${sourceKey}`)
      .setPlaceholder(`Choose ${combatManager.actionLabel(action)} target`)
      .addOptions(actors.slice(0, 25).map((a) => actorOption(session, a)))
  )
}

// ── modals ────────────────────────────────────────────────────────────────────

function makeSetupModal() {
  return new ModalBuilder().setCustomId("setup_session_modal").setTitle("Open DnD Lobby").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("slot_count").setLabel("Slot count (1-8)")
        .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(1).setPlaceholder("4").setRequired(true)
    )
  )
}

function makeAdjustSlotsModal() {
  return new ModalBuilder().setCustomId("adjust_slots_modal").setTitle("Adjust Slot Count").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("slot_count").setLabel("New slot count (1-8)")
        .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(1).setPlaceholder("4").setRequired(true)
    )
  )
}

function makeRegisterModal(slotIndex: number) {
  return new ModalBuilder().setCustomId(`register_player_modal_${slotIndex}`).setTitle(`Register Slot ${slotIndex + 1}`).addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("char_name").setLabel("Character name").setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("char_class").setLabel("Class").setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("char_hp").setLabel("Max HP").setStyle(TextInputStyle.Short).setMaxLength(5).setRequired(false)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("tupper_name").setLabel("Tupperbox name (optional)").setStyle(TextInputStyle.Short).setMaxLength(64).setRequired(false)
    )
  )
}

function makeSpawnMonsterModal() {
  return new ModalBuilder().setCustomId("spawn_monster_modal").setTitle("Spawn Monster").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("monster_name").setLabel("Monster name").setStyle(TextInputStyle.Short).setMaxLength(64).setRequired(true)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("monster_count").setLabel("Count (1-20)").setStyle(TextInputStyle.Short).setMaxLength(2).setPlaceholder("1").setRequired(true)
    )
  )
}

function makeSpawnMonsterStatModal(name: string, count: number) {
  return new ModalBuilder().setCustomId("spawn_monster_stat_modal").setTitle("Monster Stat").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("monster_name").setLabel("Monster name").setStyle(TextInputStyle.Short).setMaxLength(64).setValue(name).setRequired(true)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("monster_count").setLabel("Count (1-20)").setStyle(TextInputStyle.Short).setMaxLength(2).setValue(String(count)).setRequired(true)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("monster_hp").setLabel("HP").setStyle(TextInputStyle.Short).setMaxLength(5).setRequired(true)
    )
  )
}

// ── spawn helpers ─────────────────────────────────────────────────────────────

function buildSpawnConfirmEmbed(name: string, count: number, hp: number, imageUrl: string | null) {
  const embed = new EmbedBuilder().setColor(0xe67e22).setTitle("Confirm Spawn").setDescription(`**${name}** x${count} | ${hp} HP each`)
  if (imageUrl) embed.setThumbnail(imageUrl)
  return embed
}

function buildSpawnConfirmRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("spawn_confirm").setLabel("Spawn").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("spawn_edit").setLabel("Edit stat").setStyle(ButtonStyle.Secondary),
  )
}

function buildSpawnManualRow(userId: string, name: string, count: number) {
  pendingSpawnManual.set(userId, { name, count })
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("spawn_manual").setLabel("Enter stat manually").setStyle(ButtonStyle.Primary)
  )
}

async function executeSpawn(channelId: string, guildId: string, name: string, count: number, hp: number, client: Client) {
  sessionManager.spawnEnemies(channelId, name, count, hp)
  const session = sessionManager.getSession(channelId)!
  // อัปเดต combat embed เฉพาะตอน combat แล้ว -lobby ยังไม่สร้าง embed
  if (session.state === "combat") {
    await updateCombatMessage(session, client)
  } else if (session.lobbyMessageId) {
    updateLobbyMessage(session, client).catch(console.error)
  }
}

// ── slash command handlers ────────────────────────────────────────────────────

async function handleLobbyCommand(interaction: ChatInputCommandInteraction) {
  if (sessionManager.getSession(interaction.channelId!)) {
    await interaction.reply({ content: "There is already an active session in this channel.", ephemeral: true })
    return
  }
  await interaction.showModal(makeSetupModal())
}

async function handleAdjustSlotsCommand(interaction: ChatInputCommandInteraction) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "No active session.", ephemeral: true }); return }
  if (session.hostId !== interaction.user.id) { await interaction.reply({ content: "Only DM can adjust slots.", ephemeral: true }); return }
  await interaction.showModal(makeAdjustSlotsModal())
}

async function handleSpawnMonsterCommand(interaction: ChatInputCommandInteraction) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "No active session.", ephemeral: true }); return }
  if (session.hostId !== interaction.user.id) { await interaction.reply({ content: "Only DM can spawn monsters.", ephemeral: true }); return }
  await interaction.showModal(makeSpawnMonsterModal())
}

// ── button handlers ───────────────────────────────────────────────────────────

async function handleClaimSlotButton(interaction: ButtonInteraction, client: Client) {
  const slotIndex = parseInt(interaction.customId.replace("claim_slot_", ""), 10)
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }
  if (session.state !== "lobby") { await interaction.reply({ content: "Session has already started.", ephemeral: true }); return }
  if (slotIndex >= session.maxSlots) { await interaction.reply({ content: "This slot no longer exists.", ephemeral: true }); return }

  const owner = sessionManager.getSlotOwner(session.channelId, slotIndex)
  if (owner && owner !== interaction.user.id) { await interaction.reply({ content: `Slot ${slotIndex + 1} is taken.`, ephemeral: true }); return }

  if (!owner) sessionManager.claimSlot(session.channelId, interaction.user.id, slotIndex)
  await interaction.showModal(makeRegisterModal(slotIndex))
  updateLobbyMessage(sessionManager.getSession(session.channelId)!, client).catch(console.error)
}

async function handleStartSessionButton(interaction: ButtonInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }
  if (session.hostId !== interaction.user.id) { await interaction.reply({ content: "Only DM can start.", ephemeral: true }); return }

  session.state = "combat"
  await interaction.reply({ content: ">>> # ระบบกำลังดำเนินการ" })
  await updateCombatMessage(session, client)
}

async function handleCombatAttackButton(interaction: ButtonInteraction) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  // หา source อัตโนมัติ -เฉพาะ actor ที่มีชีวิตและ user ควบคุมได้
  const controllable = combatManager.getActors(session, true).filter(
    (a) => combatManager.canControlActor(session, interaction.user.id, a)
  )
  if (controllable.length === 0) { await interaction.reply({ content: "No actor you can control.", ephemeral: true }); return }

  // ถ้ามีแค่ตัวเดียว → ข้ามไปเลือก target เลย
  if (controllable.length === 1) {
    const source = controllable[0]
    const targetRow = buildTargetSelect(session, "attack", source)
    if (!targetRow) { await interaction.reply({ content: "No valid targets.", ephemeral: true }); return }
    await interaction.reply({
      content: `**${combatManager.getActorLabel(session, source)}** → choose target:`,
      components: [targetRow],
      ephemeral: true,
    })
    return
  }

  // มีหลายตัว → ให้เลือก source ก่อน
  const sourceRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("combat_source_attack")
      .setPlaceholder("Choose attacker")
      .addOptions(controllable.slice(0, 25).map((a) => actorOption(session, a)))
  )
  await interaction.reply({ content: "Choose attacker:", components: [sourceRow], ephemeral: true })
}

async function handleCombatHealButton(interaction: ButtonInteraction) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const controllable = combatManager.getActors(session).filter(
    (a) => combatManager.canControlActor(session, interaction.user.id, a)
  )
  if (controllable.length === 0) { await interaction.reply({ content: "No actor you can control.", ephemeral: true }); return }

  if (controllable.length === 1) {
    const source = controllable[0]
    const targetRow = buildTargetSelect(session, "heal", source)
    if (!targetRow) { await interaction.reply({ content: "No valid targets.", ephemeral: true }); return }
    await interaction.reply({
      content: `**${combatManager.getActorLabel(session, source)}** → choose heal target:`,
      components: [targetRow],
      ephemeral: true,
    })
    return
  }

  const sourceRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("combat_source_heal")
      .setPlaceholder("Choose healer")
      .addOptions(controllable.slice(0, 25).map((a) => actorOption(session, a)))
  )
  await interaction.reply({ content: "Choose healer:", components: [sourceRow], ephemeral: true })
}

async function handleCombatDodgeButton(interaction: ButtonInteraction, client: Client) {
  const attackId = interaction.customId.replace("combat_dodge_", "")
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const result = combatManager.requestDodge(session, attackId, interaction.user.id)
  if (!result.consumed) { await interaction.reply({ content: result.message ?? "Cannot dodge.", ephemeral: true }); return }

  await interaction.reply({ content: `${result.message}\nRoll now with Rollem (e.g. \`d20\`)`, ephemeral: true })
  updateCombatMessage(session, client).catch(console.error)
}

async function handleCombatTakeButton(interaction: ButtonInteraction, client: Client) {
  const attackId = interaction.customId.replace("combat_take_", "")
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const result = combatManager.takeHit(session, attackId, interaction.user.id)
  if (!result.consumed) { await interaction.reply({ content: result.message ?? "Cannot take hit.", ephemeral: true }); return }

  await interaction.update({ content: "✅", components: [] })
  const channel = interaction.channel as TextChannel
  if (result.message) await channel.send(result.message).catch(console.error)
  if (result.deathMessage) await channel.send(result.deathMessage).catch(console.error)
  updateCombatMessage(session, client).catch(console.error)
}

async function handleCombatCancelButton(interaction: ButtonInteraction, client: Client) {
  const attackId = interaction.customId.replace("combat_cancel_", "")
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const result = combatManager.cancelAttack(session, attackId, interaction.user.id)
  if (!result.consumed) { await interaction.reply({ content: result.message ?? "Cannot cancel.", ephemeral: true }); return }

  await interaction.reply({ content: result.message, ephemeral: true })
  updateCombatMessage(session, client).catch(console.error)
}

async function handleSpawnConfirmButton(interaction: ButtonInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [], embeds: [] }); return }
  const pending = pendingSpawns.get(interaction.user.id)
  if (!pending) { await interaction.update({ content: "Spawn expired. Try /spawn-monster again.", components: [], embeds: [] }); return }
  pendingSpawns.delete(interaction.user.id)
  await interaction.update({ content: "Spawning...", components: [], embeds: [] })
  await executeSpawn(session.channelId, session.guildId, pending.name, pending.count, pending.hp, client)
  await interaction.editReply({ content: `Spawned **${pending.name}** x${pending.count}.` })
}

async function handleSpawnEditButton(interaction: ButtonInteraction) {
  const pending = pendingSpawns.get(interaction.user.id)
  if (!pending) { await interaction.update({ content: "Spawn expired. Try /spawn-monster again.", components: [], embeds: [] }); return }
  await interaction.showModal(makeSpawnMonsterStatModal(pending.name, pending.count))
}

async function handleSpawnManualButton(interaction: ButtonInteraction) {
  const data = pendingSpawnManual.get(interaction.user.id)
  if (!data) { await interaction.reply({ content: "Spawn expired. Try /spawn-monster again.", ephemeral: true }); return }
  pendingSpawnManual.delete(interaction.user.id)
  await interaction.showModal(makeSpawnMonsterStatModal(data.name, data.count))
}

// ── select menu handlers ──────────────────────────────────────────────────────

async function handleForumSelectMenu(interaction: StringSelectMenuInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }
  if (session.hostId !== interaction.user.id) { await interaction.reply({ content: "Only DM can choose this.", ephemeral: true }); return }
  sessionManager.setForumChannel(session.channelId, interaction.values[0])

  // ถามต่อว่าคลังมอนสเตอร์อยู่ใน Forum ไหน
  const guild = await client.guilds.fetch(session.guildId)
  const allChannels = await guild.channels.fetch()
  const forumChannels = allChannels.filter((ch): ch is ForumChannel => ch?.type === ChannelType.GuildForum)
  const options = forumChannels.map((ch) => ({ label: ch.name, value: ch.id })).slice(0, 25)
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("select_monster_forum_channel")
      .setPlaceholder("เลือก Forum คลังมอนสเตอร์")
      .addOptions(options)
  )
  await interaction.update({ content: "เลือก Forum สำหรับคลังมอนสเตอร์:", components: [row] })
}

async function handleMonsterForumSelectMenu(interaction: StringSelectMenuInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }
  if (session.hostId !== interaction.user.id) { await interaction.reply({ content: "Only DM can choose this.", ephemeral: true }); return }
  sessionManager.setMonsterForumChannel(session.channelId, interaction.values[0])
  await postLobbyEmbed(session, interaction.channel as TextChannel, client)
  await interaction.update({ content: "Session opened.", components: [] })
}

async function handleCombatSourceSelect(interaction: StringSelectMenuInteraction) {
  const action = interaction.customId.replace("combat_source_", "") as CombatActionType
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }

  const source = combatManager.decodeActor(interaction.values[0])
  if (!source) { await interaction.update({ content: "Invalid actor.", components: [] }); return }

  const targetRow = buildTargetSelect(session, action, source)
  if (!targetRow) { await interaction.update({ content: "No valid targets.", components: [] }); return }

  await interaction.update({
    content: `**${combatManager.getActorLabel(session, source)}** → choose target:`,
    components: [targetRow],
  })
}

async function handleCombatTargetSelect(interaction: StringSelectMenuInteraction, client: Client) {
  // customId: combat_target_{action}_{sourceKey}
  const withoutPrefix = interaction.customId.replace("combat_target_", "")
  const firstUnderscore = withoutPrefix.indexOf("_")
  const action = withoutPrefix.slice(0, firstUnderscore) as CombatActionType
  const sourceKey = withoutPrefix.slice(firstUnderscore + 1)

  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }

  const source = combatManager.decodeActor(sourceKey)
  const target = combatManager.decodeActor(interaction.values[0])
  if (!source || !target) { await interaction.update({ content: "Invalid actor.", components: [] }); return }

  combatManager.startPendingAction(session, { userId: interaction.user.id, type: action, source, target })
  const verb = action === "heal" ? "heals" : "attacks"
  const channel = interaction.channel as TextChannel
  await interaction.update({ content: "✅ Done.", components: [] })
  await channel.send(
    `**${combatManager.getActorLabel(session, source)}** ${verb} **${combatManager.getActorLabel(session, target)}** -<@${interaction.user.id}> roll now! (e.g. \`d20\`)`
  )
  updateCombatMessage(session, client).catch(console.error)
}

// ── modal submit handlers ─────────────────────────────────────────────────────

async function handleSetupSessionModal(interaction: ModalSubmitInteraction, client: Client) {
  const count = parseInt(interaction.fields.getTextInputValue("slot_count").trim(), 10)
  if (isNaN(count) || count < 1 || count > 8) { await interaction.reply({ content: "Please enter 1–8.", ephemeral: true }); return }

  const session = sessionManager.createSession(interaction.channelId!, interaction.guildId!, interaction.user.id, count)
  const guild = await client.guilds.fetch(session.guildId)
  const allChannels = await guild.channels.fetch()
  const forumChannels = allChannels.filter((ch): ch is ForumChannel => ch?.type === ChannelType.GuildForum)
  const channel = interaction.channel as TextChannel

  if (forumChannels.size === 0) {
    await postLobbyEmbed(session, channel, client)
    await interaction.reply({ content: `Lobby opened with ${count} slots.`, ephemeral: true })
    return
  }
  if (forumChannels.size === 1) {
    sessionManager.setForumChannel(session.channelId, forumChannels.first()!.id)
    sessionManager.setMonsterForumChannel(session.channelId, forumChannels.first()!.id)
    await postLobbyEmbed(session, channel, client)
    await interaction.reply({ content: `Lobby opened with ${count} slots.`, ephemeral: true })
    return
  }

  const options = forumChannels.map((ch) => ({ label: ch.name, value: ch.id })).slice(0, 25)
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("select_forum_channel")
      .setPlaceholder("เลือก Forum ข้อมูลตัวละคร")
      .addOptions(options)
  )
  await interaction.reply({ content: "เลือก Forum สำหรับข้อมูลตัวละคร:", components: [row], ephemeral: true })
}

async function handleRegisterPlayerModal(interaction: ModalSubmitInteraction, client: Client) {
  const slotIndex = parseInt(interaction.customId.replace("register_player_modal_", ""), 10)
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const name = interaction.fields.getTextInputValue("char_name").trim()
  const className = interaction.fields.getTextInputValue("char_class").trim()
  const hpRaw = interaction.fields.getTextInputValue("char_hp").trim()
  const tupperName = interaction.fields.getTextInputValue("tupper_name").trim() || undefined

  let maxHp: number
  if (hpRaw) {
    maxHp = parseInt(hpRaw, 10)
    if (isNaN(maxHp) || maxHp <= 0) { await interaction.reply({ content: "HP must be > 0.", ephemeral: true }); return }
  } else {
    maxHp = getDefaultHp(className)
  }

  const success = sessionManager.registerPlayer(session.channelId, { userId: interaction.user.id, slotIndex, name, className, maxHp, tupperName })
  if (!success) { await interaction.reply({ content: "Could not register this slot.", ephemeral: true }); return }

  const updatedSession = sessionManager.getSession(session.channelId)!
  const registeredPlayer = updatedSession.players[slotIndex]

  // ถ้ามี forum → ค้นหา thread ที่ชื่อตรงกับตัวละครแล้วดึงรูป + stat อัตโนมัติ
  let forumNote = ""
  if (updatedSession.forumChannelId && registeredPlayer) {
    try {
      const guild = await client.guilds.fetch(updatedSession.guildId)
      const threadId = await findThreadIdByName(guild, updatedSession.forumChannelId, name)
      if (threadId) {
        const [imageUrl, stats] = await Promise.all([
          getImageFromThreadId(guild, threadId),
          parseStatsFromThread(guild, threadId),
        ])
        if (imageUrl) registeredPlayer.avatarUrl = imageUrl
        if (stats) registeredPlayer.stats = stats
        const statLine = stats
          ? `CORE:${stats.core} MNF:${stats.mnf} RFX:${stats.rfx} SCR:${stats.scr} DEF:${stats.def}`
          : "ไม่พบ stat"
        forumNote = `\nดึงข้อมูลจาก Forum: ${imageUrl ? "พบรูป" : "ไม่พบรูป"} | ${statLine}`
      }
    } catch { /* ไม่มี forum ก็ข้ามไป */ }
  }

  await interaction.reply({ content: `Registered **${name}** the **${className}** with ${maxHp} HP (Slot ${slotIndex + 1}).${forumNote}`, ephemeral: true })
  updateLobbyMessage(updatedSession, client).catch(console.error)
}

async function handleAdjustSlotsModal(interaction: ModalSubmitInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const newCount = parseInt(interaction.fields.getTextInputValue("slot_count").trim(), 10)
  if (isNaN(newCount) || newCount < 1 || newCount > 8) { await interaction.reply({ content: "Please enter 1–8.", ephemeral: true }); return }

  const evicted = sessionManager.setSlotCount(session.channelId, newCount)
  await interaction.reply({ content: `Slot count adjusted to ${newCount}.`, ephemeral: true })
  if (evicted.length > 0) {
    await interaction.followUp({ content: `Removed players: ${evicted.map((id) => `<@${id}>`).join(", ")}`, ephemeral: true })
  }
  updateLobbyMessage(sessionManager.getSession(session.channelId)!, client).catch(console.error)
}

async function handleSpawnMonsterModal(interaction: ModalSubmitInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const name = interaction.fields.getTextInputValue("monster_name").trim()
  const count = parseInt(interaction.fields.getTextInputValue("monster_count").trim(), 10)
  if (isNaN(count) || count < 1 || count > 20) { await interaction.reply({ content: "Count must be 1–20.", ephemeral: true }); return }

  const monsterForumId = session.monsterForumChannelId ?? session.forumChannelId
  if (monsterForumId) {
    const guild = await client.guilds.fetch(session.guildId)
    const stat = await findForumMonsterStat(guild, monsterForumId, name)
    if (stat) {
      pendingSpawns.set(interaction.user.id, { name, count, hp: stat.hp, imageUrl: stat.imageUrl })
      await interaction.reply({ embeds: [buildSpawnConfirmEmbed(name, count, stat.hp, stat.imageUrl)], components: [buildSpawnConfirmRow()], ephemeral: true })
      return
    }
  }

  await interaction.reply({ content: `Could not find **${name}** in Forum. Enter stats manually.`, components: [buildSpawnManualRow(interaction.user.id, name, count)], ephemeral: true })
}

async function handleSpawnMonsterStatModal(interaction: ModalSubmitInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const name = interaction.fields.getTextInputValue("monster_name").trim()
  const count = parseInt(interaction.fields.getTextInputValue("monster_count").trim(), 10)
  const hp = parseInt(interaction.fields.getTextInputValue("monster_hp").trim(), 10)
  if (isNaN(count) || count < 1 || count > 20) { await interaction.reply({ content: "Count must be 1–20.", ephemeral: true }); return }
  if (isNaN(hp) || hp <= 0) { await interaction.reply({ content: "HP must be > 0.", ephemeral: true }); return }

  pendingSpawns.delete(interaction.user.id)
  await interaction.reply({ content: "Spawning...", ephemeral: true })
  await executeSpawn(session.channelId, session.guildId, name, count, hp, client)
  await interaction.editReply({ content: `Spawned **${name}** x${count}.` })
}

export function buildCcStatusRow(userId: string, targetKey: string, targetName: string): ActionRowBuilder<StringSelectMenuBuilder> {
  pendingCcTargets.set(userId, { targetKey, targetName })
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("cc_status_select")
      .setPlaceholder(`เลือกสถานะสำหรับ ${targetName}`)
      .addOptions(CC_STATUSES)
  )
}

const CC_STATUSES = [
  { label: "❄️ Freeze", value: "Freeze" },
  { label: "⚡ Stun", value: "Stun" },
  { label: "🔥 Burn", value: "Burn" },
  { label: "☠️ Poison", value: "Poison" },
  { label: "🐌 Slow", value: "Slow" },
  { label: "😵 Confuse", value: "Confuse" },
  { label: "🔇 Silence", value: "Silence" },
  { label: "👁️ Blind", value: "Blind" },
]

async function handleCcStatusSelect(interaction: StringSelectMenuInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }

  const pending = pendingCcTargets.get(interaction.user.id)
  if (!pending) { await interaction.update({ content: "หมดเวลา ลองใหม่อีกครั้ง", components: [] }); return }
  pendingCcTargets.delete(interaction.user.id)

  const status = interaction.values[0]
  const message = `🔮 ${pending.targetName} ติดสถานะ **${status}**!`
  const channel = interaction.channel as TextChannel
  await interaction.update({ content: "✅", components: [] })
  await channel.send(message).catch(console.error)
  await updateCombatMessage(session, client).catch(console.error)
}

async function handleCombatCcOrBuffButton(interaction: ButtonInteraction, action: "cc" | "buff") {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const controllable = combatManager.getActors(session, true).filter(
    (a) => combatManager.canControlActor(session, interaction.user.id, a)
  )
  if (controllable.length === 0) { await interaction.reply({ content: "No actor you can control.", ephemeral: true }); return }

  if (controllable.length === 1) {
    const source = controllable[0]
    const targetRow = buildTargetSelect(session, action, source)
    if (!targetRow) { await interaction.reply({ content: "No valid targets.", ephemeral: true }); return }
    await interaction.reply({
      content: `**${combatManager.getActorLabel(session, source)}** → choose target:`,
      components: [targetRow],
      ephemeral: true,
    })
    return
  }

  const sourceRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`combat_source_${action}`)
      .setPlaceholder(`Choose ${action === "cc" ? "CC" : "Buff/Debuff"} source`)
      .addOptions(controllable.slice(0, 25).map((a) => actorOption(session, a)))
  )
  await interaction.reply({ content: "Choose actor:", components: [sourceRow], ephemeral: true })
}

async function handleCombatDefendButton(interaction: ButtonInteraction, client: Client) {
  const attackId = interaction.customId.replace("combat_defend_", "")
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }

  const result = combatManager.requestDefend(session, attackId, interaction.user.id)
  if (!result.consumed) { await interaction.reply({ content: result.message ?? "Cannot defend.", ephemeral: true }); return }

  await interaction.reply({ content: `${result.message}\nRoll now with Rollem (e.g. \`d20\`)`, ephemeral: true })
  updateCombatMessage(session, client).catch(console.error)
}

// ── monster attack ────────────────────────────────────────────────────────────

function buildMonsterTargetSelect(session: Session, source: CombatActor): ActionRowBuilder<StringSelectMenuBuilder> {
  const alivePlayers = combatManager.getActors(session, true).filter((a) => a.type === "player")
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`combat_monster_target_${combatManager.encodeActor(source)}`)
      .setPlaceholder("เลือกเป้าหมาย")
      .addOptions(alivePlayers.slice(0, 25).map((a) => actorOption(session, a)))
  )
}

async function handleCombatMonsterButton(interaction: ButtonInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "Session not found.", ephemeral: true }); return }
  if (session.hostId !== interaction.user.id) {
    await interaction.reply({ content: "เฉพาะ DM เท่านั้นที่สั่งมอนโจมตีได้", ephemeral: true }); return
  }

  const aliveEnemies = combatManager.getActors(session, true).filter((a) => a.type === "enemy")
  if (aliveEnemies.length === 0) { await interaction.reply({ content: "ไม่มีมอนที่มีชีวิตอยู่", ephemeral: true }); return }

  const alivePlayers = combatManager.getActors(session, true).filter((a) => a.type === "player")
  if (alivePlayers.length === 0) { await interaction.reply({ content: "ไม่มีผู้เล่นที่มีชีวิตอยู่", ephemeral: true }); return }

  if (aliveEnemies.length === 1) {
    const targetRow = buildMonsterTargetSelect(session, aliveEnemies[0])
    await interaction.reply({ content: `**${combatManager.getActorLabel(session, aliveEnemies[0])}** → เลือกเป้าหมาย:`, components: [targetRow], ephemeral: true })
    return
  }

  const sourceRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("combat_monster_source")
      .setPlaceholder("เลือกมอนที่จะโจมตี")
      .addOptions(aliveEnemies.slice(0, 25).map((a) => actorOption(session, a)))
  )
  await interaction.reply({ content: "เลือกมอน:", components: [sourceRow], ephemeral: true })
}

async function handleCombatMonsterSourceSelect(interaction: StringSelectMenuInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }

  const source = combatManager.decodeActor(interaction.values[0])
  if (!source) { await interaction.update({ content: "Invalid actor.", components: [] }); return }

  const targetRow = buildMonsterTargetSelect(session, source)
  await interaction.update({
    content: `**${combatManager.getActorLabel(session, source)}** → เลือกเป้าหมาย:`,
    components: [targetRow],
  })
}

async function handleCombatMonsterTargetSelect(interaction: StringSelectMenuInteraction, client: Client) {
  // customId: combat_monster_target_{sourceKey}
  const sourceKey = interaction.customId.replace("combat_monster_target_", "")
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }

  const source = combatManager.decodeActor(sourceKey)
  const target = combatManager.decodeActor(interaction.values[0])
  if (!source || !target) { await interaction.update({ content: "Invalid actor.", components: [] }); return }

  const result = combatManager.monsterAttack(session, source, target, interaction.user.id)
  await interaction.update({ content: "✅ Done.", components: [] })

  const channel = interaction.channel as TextChannel
  if (result.message) await channel.send(result.message).catch(console.error)

  if (result.activeAttack && result.activeAttack.status === "awaiting_response") {
    const targetEntity = combatManager.getActorEntity(session, result.activeAttack.target)
    const mention = targetEntity && "userId" in targetEntity ? `<@${(targetEntity as import("../types/session").Player).userId}>` : ""
    await channel.send({
      content: `${mention} -choose your response:`,
      components: [buildAttackResponseRow(result.activeAttack.id)],
    }).catch(console.error)
  }

  await updateCombatMessage(session, client).catch(console.error)
}

async function handleMonsterRollCommand(interaction: ChatInputCommandInteraction) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "No active session.", ephemeral: true }); return }
  if (session.hostId !== interaction.user.id) { await interaction.reply({ content: "Only DM can change this.", ephemeral: true }); return }

  const mode = interaction.options.getString("mode", true) as "auto" | "manual"
  sessionManager.setMonsterRollMode(session.channelId, mode)
  const label = mode === "auto" ? "Auto (บอท roll ให้)" : "Manual (DM ทอยเอง)"
  await interaction.reply({ content: `Monster roll mode: **${label}**`, ephemeral: true })
}

// ── roll intent (roll-first flow) ─────────────────────────────────────────────

export function buildRollIntentMessage(
  session: Session,
  userId: string,
  value: number,
  rollText: string,
  matchedPlayer?: Player
): { content: string; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] } | null {
  const controllable = combatManager.getActors(session, true).filter(
    (a) => combatManager.canControlActor(session, userId, a)
  )
  if (controllable.length === 0) return null

  // priority: Tupper match โดยตรง → lastActiveTupper → controllable[0]
  const lastSlot = session.lastActiveTupper[userId]
  const source = matchedPlayer
    ? controllable.find((a) => a.type === "player" && a.id === String(matchedPlayer.slotIndex)) ?? controllable[0]
    : lastSlot !== undefined
      ? controllable.find((a) => a.type === "player" && a.id === String(lastSlot)) ?? controllable[0]
      : controllable[0]
  const sourceKey = combatManager.encodeActor(source)

  // เก็บ rollText แยกต่างหาก เพราะ customId จำกัด 100 ตัวอักษร
  const rollKey = `${userId}_${value}`
  pendingRollTexts.set(rollKey, rollText)
  setTimeout(() => pendingRollTexts.delete(rollKey), 120_000)

  const actionRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`roll_intent_attack_${userId}_${value}_${sourceKey}`)
      .setLabel("⚔️ Attack")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`roll_intent_heal_${userId}_${value}_${sourceKey}`)
      .setLabel("🩹 Heal")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`roll_intent_cc_${userId}_${value}_${sourceKey}`)
      .setLabel("🔮 CC")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`roll_intent_buff_${userId}_${value}_${sourceKey}`)
      .setLabel("✨ Buff/Debuff")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`roll_intent_cancel_${userId}`)
      .setLabel("ยกเลิก")
      .setStyle(ButtonStyle.Secondary),
  )

  return {
    content: `**${combatManager.getActorLabel(session, source)}** ทอยได้ **${value}** -จะทำอะไร?`,
    components: [actionRow1],
  }
}

async function handleRollIntentButton(interaction: ButtonInteraction, client: Client) {
  const parts = interaction.customId.split("_")
  // roll_intent_{action}_{userId}_{value}_{sourceKey}
  // parts: [roll, intent, action, userId, value, sourceKey]
  const action = parts[2] as "attack" | "heal" | "cc" | "buff" | "cancel"

  if (action === "cancel") {
    await interaction.update({ content: "ยกเลิกแล้ว", components: [] })
    return
  }

  const userId = parts[3]
  const value = parseInt(parts[4], 10)
  const sourceKey = parts[5]

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: "นี่ไม่ใช่ roll ของคุณ", ephemeral: true })
    return
  }

  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }

  const source = combatManager.decodeActor(sourceKey)
  if (!source) { await interaction.update({ content: "Invalid actor.", components: [] }); return }

  const targetRow = buildTargetSelect(session, action, source)
  if (!targetRow) { await interaction.update({ content: "ไม่มีเป้าหมายที่เลือกได้", components: [] }); return }

  const menu = (targetRow.components[0] as StringSelectMenuBuilder)
    .setCustomId(`roll_intent_target_${action}_${sourceKey}_${value}`)

  await interaction.update({
    content: `**${combatManager.getActorLabel(session, source)}** → เลือกเป้าหมาย:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  })
}

async function handleRollIntentTargetSelect(interaction: StringSelectMenuInteraction, client: Client) {
  // customId: roll_intent_target_{action}_{sourceKey}_{value}_{encoded}
  const withoutPrefix = interaction.customId.replace("roll_intent_target_", "")
  const firstUnderscore = withoutPrefix.indexOf("_")
  const action = withoutPrefix.slice(0, firstUnderscore) as "attack" | "heal"
  const rest = withoutPrefix.slice(firstUnderscore + 1)
  // format: {type}:{id}_{value}
  const sourceMatch = rest.match(/^(player:\d+|enemy:[^_]+)_(\d+)$/)
  if (!sourceMatch) { await interaction.update({ content: "Invalid data.", components: [] }); return }

  const sourceKey = sourceMatch[1]
  const value = parseInt(sourceMatch[2], 10)
  const userId = interaction.user.id
  const rollText = pendingRollTexts.get(`${userId}_${value}`) ?? ""
  pendingRollTexts.delete(`${userId}_${value}`)

  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }

  const source = combatManager.decodeActor(sourceKey)
  const target = combatManager.decodeActor(interaction.values[0])
  if (!source || !target) { await interaction.update({ content: "Invalid actor.", components: [] }); return }

  combatManager.startPendingAction(session, { userId: interaction.user.id, type: action, source, target })
  const result = combatManager.consumeRollemRoll(session, interaction.user.id, value, rollText)

  await interaction.update({ content: "✅ Done.", components: [] })

  const channel = interaction.channel as TextChannel
  if (result.activeAttack && result.activeAttack.status === "awaiting_response") {
    const targetEntity = combatManager.getActorEntity(session, result.activeAttack.target)
    const mention = targetEntity && "userId" in targetEntity ? `<@${(targetEntity as import("../types/session").Player).userId}>` : ""
    await channel.send({
      content: `${result.message}\n${mention} -choose your response:`,
      components: [buildAttackResponseRow(result.activeAttack.id)],
    }).catch(console.error)
  } else if (result.ccSuccess) {
    const targetKey = combatManager.encodeActor(result.ccSuccess.target)
    const targetName = combatManager.getActorLabelWithId(session, result.ccSuccess.target)
    const row = buildCcStatusRow(interaction.user.id, targetKey, targetName)
    await channel.send({
      content: `${result.message}\n<@${interaction.user.id}> เลือกสถานะ:`,
      components: [row],
    }).catch(console.error)
  } else if (result.message) {
    await channel.send(result.message).catch(console.error)
  }
  if (result.deathMessage) await channel.send(result.deathMessage).catch(console.error)
  if (result.sessionEnded) await channel.send(">>> # ดำเนินการระบบเสร็จสิ้น").catch(console.error)

  if (result.counterAttack && result.counterMessage) {
    const targetEntity = combatManager.getActorEntity(session, result.counterAttack.target)
    const mention = targetEntity && "userId" in targetEntity ? `<@${(targetEntity as import("../types/session").Player).userId}>` : ""
    await channel.send({
      content: `${result.counterMessage}\n${mention} - choose your response:`,
      components: [buildAttackResponseRow(result.counterAttack.id)],
    }).catch(console.error)
  }

  await updateCombatMessage(session, client).catch(console.error)
}

async function handleEndSessionCommand(interaction: ChatInputCommandInteraction, client: Client) {
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.reply({ content: "No active session.", ephemeral: true }); return }
  if (session.hostId !== interaction.user.id) { await interaction.reply({ content: "Only DM can end the session.", ephemeral: true }); return }

  session.state = "ended"
  await interaction.reply({ content: ">>> # ดำเนินการระบบเสร็จสิ้น" })
  const channel = interaction.channel as TextChannel
  await updateCombatMessage(session, client).catch(console.error)
}

async function handleLinkAvatarSelect(interaction: StringSelectMenuInteraction, client: Client) {
  const slotIndex = parseInt(interaction.customId.replace("link_avatar_", ""), 10)
  const session = sessionManager.getSession(interaction.channelId!)
  if (!session) { await interaction.update({ content: "Session not found.", components: [] }); return }

  const player = session.players[slotIndex]
  if (!player || player.userId !== interaction.user.id) {
    await interaction.reply({ content: "นี่ไม่ใช่ slot ของคุณ", ephemeral: true }); return
  }

  const threadId = interaction.values[0]
  try {
    const guild = await client.guilds.fetch(session.guildId)
    const [imageUrl, stats] = await Promise.all([
      getImageFromThreadId(guild, threadId),
      parseStatsFromThread(guild, threadId),
    ])
    if (imageUrl) player.avatarUrl = imageUrl
    if (stats) player.stats = stats

    const statLine = stats
      ? `CORE:${stats.core} MNF:${stats.mnf} RFX:${stats.rfx} SCR:${stats.scr} DEF:${stats.def}`
      : "ไม่พบ stat"
    const imgLine = imageUrl ? "พบรูป" : "ไม่พบรูป"
    await interaction.update({ content: `เชื่อม thread สำเร็จ (${imgLine} | ${statLine})`, components: [] })
  } catch {
    await interaction.update({ content: "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง", components: [] })
  }
}

// ── main router ───────────────────────────────────────────────────────────────

export async function handleInteraction(interaction: Interaction, client: Client): Promise<void> {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "lobby") return handleLobbyCommand(interaction)
    if (interaction.commandName === "adjust-slots") return handleAdjustSlotsCommand(interaction)
    if (interaction.commandName === "spawn-monster") return handleSpawnMonsterCommand(interaction)
    if (interaction.commandName === "end-session") return handleEndSessionCommand(interaction, client)
    if (interaction.commandName === "monster-roll") return handleMonsterRollCommand(interaction)
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("claim_slot_")) return handleClaimSlotButton(interaction, client)
    if (interaction.customId === "start_session") return handleStartSessionButton(interaction, client)
    if (interaction.customId === "combat_action_attack") return handleCombatAttackButton(interaction)
    if (interaction.customId === "combat_action_heal") return handleCombatHealButton(interaction)
    if (interaction.customId === "combat_action_cc") return handleCombatCcOrBuffButton(interaction, "cc")
    if (interaction.customId === "combat_action_buff") return handleCombatCcOrBuffButton(interaction, "buff")
    if (interaction.customId.startsWith("combat_dodge_")) return handleCombatDodgeButton(interaction, client)
    if (interaction.customId.startsWith("combat_defend_")) return handleCombatDefendButton(interaction, client)
    if (interaction.customId.startsWith("combat_take_")) return handleCombatTakeButton(interaction, client)
    if (interaction.customId.startsWith("combat_cancel_")) return handleCombatCancelButton(interaction, client)
    if (interaction.customId === "spawn_confirm") return handleSpawnConfirmButton(interaction, client)
    if (interaction.customId === "spawn_edit") return handleSpawnEditButton(interaction)
    if (interaction.customId === "spawn_manual") return handleSpawnManualButton(interaction)
    if (interaction.customId.startsWith("roll_intent_")) return handleRollIntentButton(interaction, client)
    if (interaction.customId === "combat_action_monster") return handleCombatMonsterButton(interaction, client)
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "select_forum_channel") return handleForumSelectMenu(interaction, client)
    if (interaction.customId === "select_monster_forum_channel") return handleMonsterForumSelectMenu(interaction, client)
    if (interaction.customId === "cc_status_select") return handleCcStatusSelect(interaction, client)
    if (interaction.customId.startsWith("combat_source_")) return handleCombatSourceSelect(interaction)
    if (interaction.customId.startsWith("combat_target_")) return handleCombatTargetSelect(interaction, client)
    if (interaction.customId.startsWith("roll_intent_target_")) return handleRollIntentTargetSelect(interaction, client)
    if (interaction.customId === "combat_monster_source") return handleCombatMonsterSourceSelect(interaction, client)
    if (interaction.customId.startsWith("combat_monster_target_")) return handleCombatMonsterTargetSelect(interaction, client)
    if (interaction.customId.startsWith("link_avatar_")) return handleLinkAvatarSelect(interaction, client)
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "setup_session_modal") return handleSetupSessionModal(interaction, client)
    if (interaction.customId === "adjust_slots_modal") return handleAdjustSlotsModal(interaction, client)
    if (interaction.customId.startsWith("register_player_modal_")) return handleRegisterPlayerModal(interaction, client)
    if (interaction.customId === "spawn_monster_modal") return handleSpawnMonsterModal(interaction, client)
    if (interaction.customId === "spawn_monster_stat_modal") return handleSpawnMonsterStatModal(interaction, client)
  }
}
