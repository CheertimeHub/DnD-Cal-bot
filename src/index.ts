import "dotenv/config"
import { Message } from "discord.js"
import { Player } from "./types/session"
import client from "./bot"
import { buildAttackResponseRow, buildRollIntentMessage, handleInteraction, updateCombatMessage, updateLobbyMessage } from "./handlers/interactionHandler"
import * as combatManager from "./systems/combatManager"
import * as sessionManager from "./systems/sessionManager"
import { Session } from "./types/session"

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`)
})

client.on("interactionCreate", async (interaction) => {
  await handleInteraction(interaction, client).catch(console.error)
})

// ── Rollem dice roll listener ─────────────────────────────────────────────────

function isRollemBot(message: Message): boolean {
  return message.author.username.toLowerCase().includes("rollem")
}

function parseRollemTotal(content: string): number | null {
  // Rollem format: "` 4 ` ⟵ [4] 1d10"  — จับตัวเลขก่อนลูกศร (รองรับทั้ง ← และ ⟵ และ backtick)
  const match = content.match(/`?\s*(\d+)\s*`?\s*[←⟵]/)
  if (match) return parseInt(match[1], 10)
  // fallback: "= **X**" หรือ "**X**" ท้าย string
  const fallback = content.match(/=\s*\*\*(\d+)\*\*|\*\*(\d+)\*\*\s*$/)
  if (fallback) return parseInt(fallback[1] ?? fallback[2], 10)
  return null
}

interface RollerIdentity {
  userId: string
  matchedPlayer?: Player  // Tupper webhook ที่ map กับ player slot โดยตรง
}

async function resolveRollerIdentity(message: Message, session: Session): Promise<RollerIdentity | null> {
  if (message.reference?.messageId) {
    try {
      const ref = await message.fetchReference()
      if (!ref.author.bot) return { userId: ref.author.id }
      // Tupper webhook — หา player ที่ tupperName ตรงกัน
      const refUsername = ref.author.username.toLowerCase()
      const matched = session.players.find(
        (p): p is Player => p !== null && p.name !== "" && !!p.tupperName &&
        p.tupperName.toLowerCase() === refUsername
      )
      if (matched) return { userId: matched.userId, matchedPlayer: matched }
    } catch { /* fall through */ }
  }
  // fallback: lastActiveTupper — ใช้ตัวละครที่โรลเพลย์ล่าสุด
  // หา userId ที่มี lastActiveTupper และ Rollem reply อยู่ใน context ของคนนั้น
  // ไม่สามารถรู้ได้จาก message อย่างเดียว → ใช้ pendingAction แทน
  if (session.pendingActions.length === 1) return { userId: session.pendingActions[0].userId }
  return null
}

client.on("messageCreate", async (message) => {
  if (!message.author.bot) return

  // DEBUG: log every bot message to see what arrives
  console.log(`[MSG] bot="${message.author.username}" id="${message.author.id}" content="${message.content.slice(0, 80)}" channel=${message.channelId}`)

  // track Tupper webhook → อัปเดต lastActiveTupper ทันทีที่เห็น Tupper โพสต์
  const tupperSession = sessionManager.getSession(message.channelId)
  if (tupperSession && !isRollemBot(message)) {
    const username = message.author.username.toLowerCase()
    console.log(`[TUPPER] checking username="${username}" against slots: ${tupperSession.players.filter(Boolean).map((p) => `${p?.tupperName ?? "-"}`).join(", ")}`)
    const matched = tupperSession.players.find(
      (p): p is Player => p !== null && p.name !== "" && !!p.tupperName &&
      p.tupperName.toLowerCase() === username
    )
    if (matched) {
      tupperSession.lastActiveTupper[matched.userId] = matched.slotIndex
      if (!matched.avatarUrl) {
        matched.avatarUrl = message.author.avatarURL({ extension: "png", size: 256 }) ?? message.author.displayAvatarURL({ size: 256 })
      }
      console.log(`[TUPPER] updated lastActiveTupper: ${matched.userId} → slot ${matched.slotIndex} (${matched.name}) avatar=${matched.avatarUrl}`)
      if (tupperSession.state === "lobby") {
        updateLobbyMessage(tupperSession, client).catch(console.error)
      } else if (tupperSession.state === "combat") {
        updateCombatMessage(tupperSession, client).catch(console.error)
      }
    } else {
      console.log(`[TUPPER] no match found for "${username}"`)
    }
  }

  if (!isRollemBot(message)) return

  const session = sessionManager.getSession(message.channelId)
  console.log(`[ROLLEM] session=${!!session} state=${session?.state} pendingCount=${session?.pendingActions.length ?? 0}`)
  if (!session || session.state !== "combat") return

  const value = parseRollemTotal(message.content)
  console.log(`[ROLLEM] parsed value=${value} from content="${message.content.slice(0, 80)}"`)
  if (value === null) return

  const identity = await resolveRollerIdentity(message, session)
  console.log(`[ROLLEM] resolvedUserId=${identity?.userId} matchedPlayer=${identity?.matchedPlayer?.name}`)
  if (!identity) return
  const { userId, matchedPlayer } = identity

  // ถ้าไม่มี pendingAction → ถาม intent ก่อน (roll-first flow)
  const hasPending = session.pendingActions.some((a) => a.userId === userId)
  if (!hasPending) {
    const intentMsg = buildRollIntentMessage(session, userId, value, message.content, matchedPlayer)
    if (intentMsg) {
      const sent = await message.channel.send(intentMsg).catch(console.error)
      if (sent) setTimeout(() => sent.delete().catch(() => {}), 60_000)
    }
    return
  }

  const result = combatManager.consumeRollemRoll(session, userId, value, message.content)
  console.log(`[ROLLEM] consumed=${result.consumed} message="${result.message}"`)
  if (!result.consumed) return

  if (result.message) {
    if (result.activeAttack && result.activeAttack.status === "awaiting_response") {
      const targetEntity = combatManager.getActorEntity(session, result.activeAttack.target)
      const targetMention = targetEntity && "userId" in targetEntity ? `<@${(targetEntity as Player).userId}>` : ""
      await message.channel.send({
        content: `${result.message}\n${targetMention} - choose your response:`,
        components: [buildAttackResponseRow(result.activeAttack.id)],
      }).catch(console.error)
    } else {
      await message.channel.send(result.message).catch(console.error)
    }
  }
  if (result.deathMessage) await message.channel.send(result.deathMessage).catch(console.error)
  if (result.sessionEnded) await message.channel.send(">>> # ดำเนินการระบบเสร็จสิ้น").catch(console.error)

  // มอนตีกลับ
  if (result.counterAttack && result.counterMessage) {
    const targetEntity = combatManager.getActorEntity(session, result.counterAttack.target)
    const targetMention = targetEntity && "userId" in targetEntity ? `<@${(targetEntity as Player).userId}>` : ""
    await message.channel.send({
      content: `${result.counterMessage}\n${targetMention} - choose your response:`,
      components: [buildAttackResponseRow(result.counterAttack.id)],
    }).catch(console.error)
  }

  await updateCombatMessage(session, client).catch(console.error)
})

// ─────────────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN
if (!token) {
  console.error("DISCORD_TOKEN is not set in .env")
  process.exit(1)
}

client.login(token)
