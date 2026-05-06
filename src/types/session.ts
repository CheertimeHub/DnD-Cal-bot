export type SessionState = "lobby" | "combat" | "ended"

export interface Player {
  userId: string
  name: string
  className: string
  hp: number
  maxHp: number
  slotIndex: number
}

export interface Enemy {
  id: string
  name: string
  hp: number
  maxHp: number
}

export interface Session {
  channelId: string
  guildId: string
  hostId: string
  lobbyMessageId: string
  players: (Player | null)[]
  state: SessionState
  maxSlots: number
  forumChannelId?: string
  enemies: Enemy[]
  combatMessageId?: string
}
