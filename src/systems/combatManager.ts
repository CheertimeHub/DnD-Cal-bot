import {
  ActiveAttack,
  CombatActionType,
  CombatActor,
  CombatLogEntry,
  Enemy,
  PendingRollAction,
  Player,
  Session,
} from "../types/session"

export interface RollConsumeResult {
  consumed: boolean
  message?: string
  activeAttack?: ActiveAttack
}

function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function actorKey(actor: CombatActor): string {
  return `${actor.type}:${actor.id}`
}

export function encodeActor(actor: CombatActor): string {
  return actorKey(actor)
}

export function decodeActor(value: string): CombatActor | null {
  const [type, id] = value.split(":")
  if ((type !== "player" && type !== "enemy") || !id) return null
  return { type: type as "player" | "enemy", id }
}

export function getRegisteredPlayers(session: Session): Player[] {
  return session.players.filter((p): p is Player => p !== null && p.name !== "")
}

export function getActors(session: Session): CombatActor[] {
  const players = getRegisteredPlayers(session).map((p) => ({
    type: "player" as const,
    id: String(p.slotIndex),
  }))
  const enemies = session.enemies.map((e) => ({ type: "enemy" as const, id: e.id }))
  return [...players, ...enemies]
}

export function getActorEntity(session: Session, actor: CombatActor): Player | Enemy | null {
  if (actor.type === "player") {
    const index = parseInt(actor.id, 10)
    const player = session.players[index]
    return player && player.name ? player : null
  }
  return session.enemies.find((e) => e.id === actor.id) ?? null
}

export function getActorLabel(session: Session, actor: CombatActor): string {
  const entity = getActorEntity(session, actor)
  if (!entity) return actorKey(actor)
  if (actor.type === "player") return (entity as Player).name
  return `${(entity as Enemy).id}: ${(entity as Enemy).name}`
}

export function canControlActor(session: Session, userId: string, actor: CombatActor): boolean {
  if (actor.type !== "player") return false
  const entity = getActorEntity(session, actor)
  return !!entity && "userId" in entity && (entity as Player).userId === userId
}

export function canRespondForTarget(session: Session, userId: string, actor: CombatActor): boolean {
  return canControlActor(session, userId, actor)
}

export function addCombatLog(session: Session, message: string): CombatLogEntry {
  const entry: CombatLogEntry = { id: nextId("log"), message, createdAt: Date.now() }
  session.combatLog = [entry, ...session.combatLog].slice(0, 8)
  return entry
}

function setHp(session: Session, actor: CombatActor, hp: number): number | null {
  const entity = getActorEntity(session, actor)
  if (!entity) return null
  entity.hp = clamp(hp, 0, entity.maxHp)
  return entity.hp
}

function damageActor(session: Session, actor: CombatActor, amount: number): number | null {
  const entity = getActorEntity(session, actor)
  if (!entity) return null
  return setHp(session, actor, entity.hp - Math.max(0, amount))
}

function healActor(session: Session, actor: CombatActor, amount: number): number | null {
  const entity = getActorEntity(session, actor)
  if (!entity) return null
  return setHp(session, actor, entity.hp + Math.max(0, amount))
}

export function startPendingAction(
  session: Session,
  action: Omit<PendingRollAction, "createdAt">
): PendingRollAction {
  const pending: PendingRollAction = { ...action, createdAt: Date.now() }
  session.pendingActions = [
    ...session.pendingActions.filter((a) => a.userId !== pending.userId),
    pending,
  ]
  return pending
}

function popPendingAction(session: Session, userId: string): PendingRollAction | null {
  const pending = session.pendingActions.find((a) => a.userId === userId)
  if (!pending) return null
  session.pendingActions = session.pendingActions.filter((a) => a !== pending)
  return pending
}

export function consumeRollemRoll(
  session: Session,
  userId: string,
  numericValue: number,
  rollText: string
): RollConsumeResult {
  const pending = popPendingAction(session, userId)
  if (!pending) return { consumed: false }

  if (pending.type === "damage") {
    const hp = damageActor(session, pending.target, numericValue)
    if (hp === null) return { consumed: true, message: "Target not found." }
    const message = `${getActorLabel(session, pending.source)} dealt ${numericValue} damage to ${getActorLabel(session, pending.target)} (${hp} HP left).`
    addCombatLog(session, message)
    return { consumed: true, message }
  }

  if (pending.type === "heal") {
    const hp = healActor(session, pending.target, numericValue)
    if (hp === null) return { consumed: true, message: "Target not found." }
    const message = `${getActorLabel(session, pending.source)} healed ${getActorLabel(session, pending.target)} for ${numericValue} (${hp} HP).`
    addCombatLog(session, message)
    return { consumed: true, message }
  }

  if (pending.type === "attack") {
    // enemy target → deal damage immediately (monsters don't dodge)
    if (pending.target.type === "enemy") {
      const hp = damageActor(session, pending.target, numericValue)
      if (hp === null) return { consumed: true, message: "Target not found." }
      const message = `${getActorLabel(session, pending.source)} dealt ${numericValue} damage to ${getActorLabel(session, pending.target)} (${hp} HP left).`
      addCombatLog(session, message)
      return { consumed: true, message }
    }

    // player target → create activeAttack and wait for Dodge or Take Hit
    const activeAttack: ActiveAttack = {
      id: nextId("atk"),
      attacker: pending.source,
      target: pending.target,
      attackValue: numericValue,
      attackRollText: rollText,
      requestedByUserId: userId,
      status: "awaiting_response",
      createdAt: Date.now(),
    }
    session.activeAttacks = [
      activeAttack,
      ...session.activeAttacks.filter((a) => a.status === "awaiting_response").slice(0, 4),
    ]
    const message = `${getActorLabel(session, pending.source)} attacks ${getActorLabel(session, pending.target)} with ${numericValue}. Waiting for Dodge or Take Hit.`
    addCombatLog(session, message)
    return { consumed: true, message, activeAttack }
  }

  if (pending.type === "dodge") {
    return resolveDodge(session, pending.activeAttackId ?? "", userId, numericValue)
  }

  return { consumed: true }
}

export function takeHit(session: Session, attackId: string, userId: string): RollConsumeResult {
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: false, message: "Attack not found." }
  if (!canRespondForTarget(session, userId, attack.target)) {
    return { consumed: false, message: "You cannot resolve this target." }
  }

  const hp = damageActor(session, attack.target, attack.attackValue)
  attack.status = "resolved"
  const message = `${getActorLabel(session, attack.target)} took ${attack.attackValue} damage from ${getActorLabel(session, attack.attacker)} (${hp ?? 0} HP left).`
  addCombatLog(session, message)
  return { consumed: true, message, activeAttack: attack }
}

export function requestDodge(session: Session, attackId: string, userId: string): RollConsumeResult {
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: false, message: "Attack not found." }
  if (!canRespondForTarget(session, userId, attack.target)) {
    return { consumed: false, message: "You cannot dodge for this target." }
  }
  startPendingAction(session, {
    userId,
    type: "dodge",
    source: attack.target,
    target: attack.attacker,
    activeAttackId: attack.id,
  })
  const message = `${getActorLabel(session, attack.target)} is dodging. Roll with Rollem now.`
  addCombatLog(session, message)
  return { consumed: true, message, activeAttack: attack }
}

export function resolveDodge(
  session: Session,
  attackId: string,
  userId: string,
  dodgeValue: number
): RollConsumeResult {
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: true, message: "Attack not found." }
  if (!canRespondForTarget(session, userId, attack.target)) {
    return { consumed: true, message: "You cannot dodge for this target." }
  }

  attack.status = "resolved"
  if (dodgeValue > attack.attackValue) {
    const message = `${getActorLabel(session, attack.target)} dodged! (${dodgeValue} vs ${attack.attackValue}) No damage.`
    addCombatLog(session, message)
    return { consumed: true, message, activeAttack: attack }
  }

  const hp = damageActor(session, attack.target, attack.attackValue)
  const message = `${getActorLabel(session, attack.target)} failed to dodge (${dodgeValue} vs ${attack.attackValue}) and took ${attack.attackValue} damage (${hp ?? 0} HP left).`
  addCombatLog(session, message)
  return { consumed: true, message, activeAttack: attack }
}

export function cancelAttack(session: Session, attackId: string, userId: string): RollConsumeResult {
  if (session.hostId !== userId) return { consumed: false, message: "Only DM can cancel attacks." }
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: false, message: "Attack not found." }
  attack.status = "cancelled"
  const message = `DM cancelled ${getActorLabel(session, attack.attacker)}'s attack on ${getActorLabel(session, attack.target)}.`
  addCombatLog(session, message)
  return { consumed: true, message, activeAttack: attack }
}

export function actionLabel(type: CombatActionType): string {
  if (type === "attack") return "Attack"
  if (type === "damage") return "Damage"
  if (type === "heal") return "Heal"
  return "Dodge"
}
