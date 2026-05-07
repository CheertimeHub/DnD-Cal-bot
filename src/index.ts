import "dotenv/config"
import { Message } from "discord.js"
import client from "./bot"
import { buildAttackResponseRow, handleInteraction, updateCombatMessage } from "./handlers/interactionHandler"
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

async function resolveRollerUserId(message: Message, session: Session): Promise<string | null> {
  // 1. Rollem reply ต่อ message ของ user → ดู reference
  if (message.reference?.messageId) {
    try {
      const ref = await message.fetchReference()
      return ref.author.id
    } catch { /* fall through */ }
  }
  // 2. fallback: ถ้ามี pending action คนเดียวใน session
  if (session.pendingActions.length === 1) {
    return session.pendingActions[0].userId
  }
  return null
}

client.on("messageCreate", async (message) => {
  if (!message.author.bot) return

  // DEBUG: log every bot message to see what arrives
  console.log(`[MSG] bot="${message.author.username}" id="${message.author.id}" content="${message.content.slice(0, 80)}" channel=${message.channelId}`)

  if (!isRollemBot(message)) return

  const session = sessionManager.getSession(message.channelId)
  console.log(`[ROLLEM] session=${!!session} pendingCount=${session?.pendingActions.length ?? 0}`)
  if (!session || session.pendingActions.length === 0) return

  const value = parseRollemTotal(message.content)
  console.log(`[ROLLEM] parsed value=${value} from content="${message.content.slice(0, 80)}"`)
  if (value === null) return

  const userId = await resolveRollerUserId(message, session)
  console.log(`[ROLLEM] resolvedUserId=${userId}`)
  if (!userId) return

  const result = combatManager.consumeRollemRoll(session, userId, value, message.content)
  console.log(`[ROLLEM] consumed=${result.consumed} message="${result.message}"`)
  if (!result.consumed) return

  if (result.message) {
    if (result.activeAttack && result.activeAttack.status === "awaiting_response") {
      // attack landed on a player target — send action buttons directly in channel
      const targetEntity = combatManager.getActorEntity(session, result.activeAttack.target)
      const targetMention = targetEntity && "userId" in targetEntity ? `<@${targetEntity.userId}>` : ""
      await message.channel.send({
        content: `${result.message}\n${targetMention} — choose your response:`,
        components: [buildAttackResponseRow(result.activeAttack.id)],
      }).catch(console.error)
    } else {
      await message.channel.send(result.message).catch(console.error)
    }
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
