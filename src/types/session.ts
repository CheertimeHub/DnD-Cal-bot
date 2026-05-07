export type SessionState = "lobby" | "combat" | "ended"
export type MonsterRollMode = "manual" | "auto"

export interface Player {
  userId: string
  name: string
  className: string
  hp: number
  maxHp: number
  slotIndex: number
  tupperName?: string
  avatarUrl?: string
}

export interface Enemy {
  id: string
  name: string
  hp: number
  maxHp: number
}

export type CombatActorType = "player" | "enemy"
export type CombatActionType = "attack" | "dodge" | "damage" | "heal"
export type ActiveAttackStatus = "awaiting_response" | "resolved" | "cancelled"

export interface CombatActor {
  type: CombatActorType
  id: string
}

export interface PendingRollAction {
  userId: string
  type: CombatActionType
  source: CombatActor
  target: CombatActor
  activeAttackId?: string
  createdAt: number
}

export interface ActiveAttack {
  id: string
  attacker: CombatActor
  target: CombatActor
  attackValue: number
  attackRollText: string
  requestedByUserId: string
  status: ActiveAttackStatus
  createdAt: number
}

export interface CombatLogEntry {
  id: string
  message: string
  createdAt: number
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
  pendingActions: PendingRollAction[]
  activeAttacks: ActiveAttack[]
  combatLog: CombatLogEntry[]
  monsterRollMode: MonsterRollMode
  lastActiveTupper: Record<string, number>  // userId → slotIndex
}
