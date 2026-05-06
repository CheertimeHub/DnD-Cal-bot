import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js"
import { Enemy, Player, Session } from "../types/session"
import { getActorLabel } from "../systems/combatManager"

function buildSlotLine(player: Player | null, index: number): string {
  if (!player) return `Slot ${index + 1}: _(empty)_`
  if (!player.name) return `Slot ${index + 1}: _(registering...)_`
  return `Slot ${index + 1}: **${player.name}** [${player.className}] HP ${player.hp}`
}

export function buildLobbyEmbed(session: Session, channelName: string, hostTag: string): EmbedBuilder {
  const slotLines = session.players.map((p, i) => buildSlotLine(p, i))

  return new EmbedBuilder()
    .setColor(0x7b2d8b)
    .setTitle(`DnD Session: ${channelName}`)
    .setDescription(slotLines.join("\n"))
    .setFooter({ text: `Active Session | DM: ${hostTag}` })
    .setTimestamp()
}

export function buildPlayerEmbed(player: Player, thumbnailUrl?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x7b2d8b)
    .setTitle(`Slot ${player.slotIndex + 1}: ${player.name}`)
    .setDescription(`HP ${player.hp}/${player.maxHp}`)

  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl)
  return embed
}

function buildHpBar(hp: number, maxHp: number, width = 10): string {
  const safeMax = Math.max(1, maxHp)
  const filled = Math.max(0, Math.round((hp / safeMax) * width))
  return "#".repeat(filled) + "-".repeat(width - filled)
}

export function buildEnemyEmbed(enemies: Enemy[]): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle("Monsters").setTimestamp()
  if (enemies.length === 0) {
    embed.setDescription("_(no monsters)_")
    return embed
  }
  for (const e of enemies) {
    embed.addFields({
      name: `${e.id}: ${e.name}`,
      value: `HP \`${buildHpBar(e.hp, e.maxHp)}\` ${e.hp}/${e.maxHp}`,
      inline: false,
    })
  }
  return embed
}

function hpLine(label: string, hp: number, maxHp: number): string {
  return `**${label}** \`${buildHpBar(hp, maxHp)}\` ${hp}/${maxHp} HP`
}

export function buildCombatEmbed(session: Session): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("Combat")
    .setTimestamp()

  const players = session.players.filter((p): p is Player => p !== null && p.name !== "")
  embed.addFields({
    name: "Players",
    value: players.length
      ? players.map((p) => hpLine(`Slot ${p.slotIndex + 1}: ${p.name}`, p.hp, p.maxHp)).join("\n")
      : "_No registered players_",
    inline: false,
  })

  embed.addFields({
    name: "Enemies",
    value: session.enemies.length
      ? session.enemies.map((e) => hpLine(`${e.id}: ${e.name}`, e.hp, e.maxHp)).join("\n")
      : "_No monsters_",
    inline: false,
  })

  const waitingRolls = session.pendingActions.map((a) => {
    return `${a.type.toUpperCase()}: ${getActorLabel(session, a.source)} -> ${getActorLabel(session, a.target)} waiting for <@${a.userId}>`
  })
  const waitingAttacks = session.activeAttacks
    .filter((a) => a.status === "awaiting_response")
    .map((a) => {
      return `ATTACK ${a.attackValue}: ${getActorLabel(session, a.attacker)} -> ${getActorLabel(session, a.target)}`
    })

  const waiting = [...waitingRolls, ...waitingAttacks]
  if (waiting.length > 0) {
    embed.addFields({ name: "Waiting", value: waiting.slice(0, 5).join("\n"), inline: false })
  }

  if (session.combatLog.length > 0) {
    embed.addFields({
      name: "Log",
      value: session.combatLog.slice(0, 5).map((l) => l.message).join("\n"),
      inline: false,
    })
  }

  return embed
}

export function buildSlotButtons(session: Session): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = []

  for (let rowStart = 0; rowStart < session.maxSlots; rowStart += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>()
    for (let i = rowStart; i < Math.min(rowStart + 5, session.maxSlots); i++) {
      const player = session.players[i]
      const isClaimed = player !== null
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`claim_slot_${i}`)
          .setLabel(isClaimed && player?.name ? `Slot ${i + 1}: ${player.name}` : `Slot ${i + 1} empty`)
          .setStyle(isClaimed ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(isClaimed)
      )
    }
    rows.push(row)
  }

  return rows
}
