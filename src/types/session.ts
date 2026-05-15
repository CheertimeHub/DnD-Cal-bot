export type SessionState = "lobby" | "combat" | "ended"
export type MonsterRollMode = "manual" | "auto"

export interface PlayerStats {
  core: number  // ปริมาณเวท / จำนวน target
  mnf: number   // ดาเมจ / ฮีล
  rfx: number   // ความเร็ว / แม่นยำ / หลบ (max 12)
  scr: number   // CC / Buff / Debuff (max 12)
  def: number   // ป้องกัน / โต้กลับ
}

export interface Player {
  userId: string
  name: string
  className: string
  hp: number
  maxHp: number
  slotIndex: number
  tupperName?: string
  avatarUrl?: string
  stats?: PlayerStats
}

export interface Enemy {
  id: string
  name: string
  hp: number
  maxHp: number
}

export type CombatActorType = "player" | "enemy"
export type CombatActionType = "attack" | "dodge" | "damage" | "heal" | "cc" | "buff" | "defend"
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
  monsterForumChannelId?: string
  enemies: Enemy[]
  combatMessageId?: string
  pendingActions: PendingRollAction[]
  activeAttacks: ActiveAttack[]
  combatLog: CombatLogEntry[]
  monsterRollMode: MonsterRollMode
  lastActiveTupper: Record<string, number>  // userId → slotIndex
}
