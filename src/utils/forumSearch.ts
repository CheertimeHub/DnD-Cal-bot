import { ChannelType, Guild, ThreadChannel } from "discord.js"

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
