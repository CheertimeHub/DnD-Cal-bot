import { ChannelType, Guild, Message, ThreadChannel } from "discord.js"
import { PlayerStats } from "../types/session"

async function findThread(
  guild: Guild,
  forumChannelId: string,
  name: string
): Promise<ThreadChannel | null> {
  const channel = await guild.channels.fetch(forumChannelId)
  if (!channel || channel.type !== ChannelType.GuildForum) return null
  const normalized = name.trim().toLowerCase()
  const { threads: active } = await channel.threads.fetchActive()
  const activeMatch = active.find((t) => t.name.trim().toLowerCase() === normalized)
  if (activeMatch) return activeMatch
  const { threads: archived } = await channel.threads.fetchArchived()
  return archived.find((t) => t.name.trim().toLowerCase() === normalized) ?? null
}

async function getImageFromThread(thread: ThreadChannel): Promise<string | null> {
  try {
    const starter = await thread.fetchStarterMessage({ cache: false })
    if (!starter) return null
    const img = starter.attachments.find((a) => a.contentType?.startsWith("image/") ?? false)
    return img?.url ?? null
  } catch {
    return null
  }
}

async function getHpFromThread(thread: ThreadChannel): Promise<number | null> {
  try {
    const starter = await thread.fetchStarterMessage({ cache: false })
    if (!starter) return null
    const match = starter.content.match(/(?:HP\s*:\s*(\d+))|(?:(\d+)\s*HP)/i)
    if (!match) return null
    const raw = match[1] ?? match[2]
    const n = parseInt(raw, 10)
    return isNaN(n) || n <= 0 ? null : n
  } catch {
    return null
  }
}

export async function findThreadIdByName(
  guild: Guild,
  forumChannelId: string,
  name: string
): Promise<string | null> {
  const thread = await findThread(guild, forumChannelId, name)
  return thread?.id ?? null
}

export async function listForumThreads(
  guild: Guild,
  forumChannelId: string
): Promise<{ id: string; name: string }[]> {
  try {
    const channel = await guild.channels.fetch(forumChannelId)
    if (!channel || channel.type !== ChannelType.GuildForum) return []
    const [{ threads: active }, { threads: archived }] = await Promise.all([
      channel.threads.fetchActive(),
      channel.threads.fetchArchived(),
    ])
    const all = [...active.values(), ...archived.values()]
    return all.map((t) => ({ id: t.id, name: t.name })).slice(0, 25)
  } catch {
    return []
  }
}

export async function getImageFromThreadId(
  guild: Guild,
  threadId: string
): Promise<string | null> {
  try {
    const thread = await guild.channels.fetch(threadId)
    console.log(`[FORUM] fetched thread: ${thread?.id} type=${thread?.type}`)
    if (!thread || !("fetchStarterMessage" in thread)) return null
    const starter = await (thread as ThreadChannel).fetchStarterMessage({ cache: false })
    console.log(`[FORUM] starter message: ${starter?.id} attachments=${starter?.attachments.size} embeds=${starter?.embeds.length}`)
    if (!starter) return null
    const img = starter.attachments.find((a) => a.contentType?.startsWith("image/") ?? false)
    console.log(`[FORUM] image attachment: ${img?.url ?? "none"}`)
    // fallback: embed image (ลิงก์รูปที่ Discord auto-embed)
    if (!img) {
      const embedImg = starter.embeds.find((e) => e.image?.url)?.image?.url ?? null
      console.log(`[FORUM] embed image: ${embedImg ?? "none"}`)
      return embedImg
    }
    return img.url
  } catch (e) {
    console.log(`[FORUM] error: ${e}`)
    return null
  }
}

export async function findForumPostImage(
  guild: Guild,
  forumChannelId: string,
  characterName: string
): Promise<string | null> {
  try {
    const thread = await findThread(guild, forumChannelId, characterName)
    if (!thread) return null
    return getImageFromThread(thread)
  } catch {
    return null
  }
}

function extractStatsFromText(text: string): Partial<PlayerStats> {
  const result: Partial<PlayerStats> = {}
  const pattern = /\b(CORE|MNF|RFX|SCR|DEF)\s*:\s*(\d+)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const key = match[1].toLowerCase() as keyof PlayerStats
    result[key] = parseInt(match[2], 10)
  }
  return result
}

export async function parseStatsFromThread(
  guild: Guild,
  threadId: string
): Promise<PlayerStats | null> {
  try {
    const thread = await guild.channels.fetch(threadId)
    if (!thread || !("messages" in thread)) return null
    const tc = thread as ThreadChannel
    // fetch ล่าสุด 50 messages แล้วหาค่าที่ครบที่สุด (message ล่าสุดที่มี >= 1 stat)
    const fetched = await tc.messages.fetch({ limit: 50 })
    const sorted = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    const accumulated: Partial<PlayerStats> = {}
    for (const msg of sorted) {
      const found = extractStatsFromText(msg.content)
      // merge — ค่าจาก message ใหม่กว่าชนะ
      Object.assign(accumulated, found)
      if (Object.keys(accumulated).length >= 5) break
    }
    if (Object.keys(accumulated).length === 0) return null
    return {
      core: accumulated.core ?? 0,
      mnf: accumulated.mnf ?? 0,
      rfx: accumulated.rfx ?? 0,
      scr: accumulated.scr ?? 0,
      def: accumulated.def ?? 0,
    }
  } catch (e) {
    console.log(`[FORUM] parseStatsFromThread error: ${e}`)
    return null
  }
}

export async function findForumMonsterStat(
  guild: Guild,
  forumChannelId: string,
  monsterName: string
): Promise<{ hp: number; imageUrl: string | null } | null> {
  try {
    const thread = await findThread(guild, forumChannelId, monsterName)
    if (!thread) return null
    const [hp, imageUrl] = await Promise.all([
      getHpFromThread(thread),
      getImageFromThread(thread),
    ])
    if (hp === null) return null
    return { hp, imageUrl }
  } catch {
    return null
  }
}
