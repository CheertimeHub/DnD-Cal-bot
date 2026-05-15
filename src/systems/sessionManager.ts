import { Enemy, MonsterRollMode, PlayerStats, Session } from "../types/session"

const sessions = new Map<string, Session>()
const lobbyIndex = new Map<string, string>()

export function createSession(
  channelId: string,
  guildId: string,
  hostId: string,
  maxSlots: number
): Session {
  const session: Session = {
    channelId,
    guildId,
    hostId,
    lobbyMessageId: "",
    players: Array(maxSlots).fill(null),
    state: "lobby",
    maxSlots,
    enemies: [],
    pendingActions: [],
    activeAttacks: [],
    combatLog: [],
    monsterRollMode: "manual",
    lastActiveTupper: {},
  }
  sessions.set(channelId, session)
  return session
}

export function getSession(channelId: string): Session | undefined {
  return sessions.get(channelId)
}

export function getSessionByLobbyMessage(messageId: string): Session | undefined {
  const channelId = lobbyIndex.get(messageId)
  if (!channelId) return undefined
  return sessions.get(channelId)
}

export function setLobbyMessageId(channelId: string, messageId: string): void {
  const session = sessions.get(channelId)
  if (!session) return
  if (session.lobbyMessageId) lobbyIndex.delete(session.lobbyMessageId)
  session.lobbyMessageId = messageId
  lobbyIndex.set(messageId, channelId)
}

export function claimSlot(channelId: string, userId: string, slotIndex: number): boolean {
  const session = sessions.get(channelId)
  if (!session) return false
  if (slotIndex < 0 || slotIndex >= session.maxSlots) return false
  if (session.players[slotIndex] !== null) return false

  session.players[slotIndex] = {
    userId,
    name: "",
    className: "",
    hp: 0,
    maxHp: 0,
    slotIndex,
  }
  return true
}

export function releaseSlot(channelId: string, slotIndex: number, requestingUserId: string): boolean {
  const session = sessions.get(channelId)
  if (!session) return false
  const player = session.players[slotIndex]
  if (!player || player.userId !== requestingUserId) return false
  session.players[slotIndex] = null
  return true
}

export function registerPlayer(
  channelId: string,
  data: { userId: string; slotIndex: number; name: string; className: string; maxHp: number; tupperName?: string }
): boolean {
  const session = sessions.get(channelId)
  if (!session) return false
  const slot = session.players[data.slotIndex]
  if (!slot || slot.userId !== data.userId) return false

  slot.name = data.name
  slot.className = data.className
  slot.maxHp = data.maxHp
  slot.hp = data.maxHp
  slot.tupperName = data.tupperName
  return true
}

export function setSlotCount(channelId: string, newCount: number): string[] {
  const session = sessions.get(channelId)
  if (!session) return []

  const evictedUserIds: string[] = []

  if (newCount < session.maxSlots) {
    for (let i = newCount; i < session.maxSlots; i++) {
      const player = session.players[i]
      if (player) evictedUserIds.push(player.userId)
    }
    session.players = session.players.slice(0, newCount)
  } else {
    while (session.players.length < newCount) {
      session.players.push(null)
    }
  }

  session.maxSlots = newCount
  return evictedUserIds
}

export function setForumChannel(channelId: string, forumChannelId: string): void {
  const session = sessions.get(channelId)
  if (!session) return
  session.forumChannelId = forumChannelId
}

export function setMonsterForumChannel(channelId: string, forumChannelId: string): void {
  const session = sessions.get(channelId)
  if (!session) return
  session.monsterForumChannelId = forumChannelId
}

export function spawnEnemies(
  channelId: string,
  name: string,
  count: number,
  hp: number
): Enemy[] {
  const session = sessions.get(channelId)
  if (!session) return []
  const startIndex = session.enemies.length + 1
  const newEnemies: Enemy[] = []
  for (let i = 0; i < count; i++) {
    newEnemies.push({ id: `E${startIndex + i}`, name, hp, maxHp: hp })
  }
  session.enemies.push(...newEnemies)
  return newEnemies
}

export function getEnemies(channelId: string): Enemy[] {
  return sessions.get(channelId)?.enemies ?? []
}

export function setCombatMessageId(channelId: string, messageId: string): void {
  const session = sessions.get(channelId)
  if (!session) return
  session.combatMessageId = messageId
}

export function setMonsterRollMode(channelId: string, mode: MonsterRollMode): void {
  const session = sessions.get(channelId)
  if (!session) return
  session.monsterRollMode = mode
}

export function updatePlayerStats(channelId: string, slotIndex: number, stats: PlayerStats): boolean {
  const session = sessions.get(channelId)
  if (!session) return false
  const player = session.players[slotIndex]
  if (!player) return false
  player.stats = stats
  return true
}

export function endSession(channelId: string): void {
  const session = sessions.get(channelId)
  if (!session) return
  if (session.lobbyMessageId) lobbyIndex.delete(session.lobbyMessageId)
  sessions.delete(channelId)
}

export function getSlotOwner(channelId: string, slotIndex: number): string | null {
  const session = sessions.get(channelId)
  if (!session) return null
  return session.players[slotIndex]?.userId ?? null
}

export function isSlotTaken(channelId: string, slotIndex: number): boolean {
  const session = sessions.get(channelId)
  if (!session) return false
  return session.players[slotIndex] !== null
}
