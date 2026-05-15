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
  deathMessage?: string
  activeAttack?: ActiveAttack
  sessionEnded?: boolean
  counterAttack?: ActiveAttack  // มอนตีกลับอัตโนมัติ
  counterMessage?: string
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

export function getActors(session: Session, excludeDead = false): CombatActor[] {
  const players = getRegisteredPlayers(session)
    .filter((p) => !excludeDead || p.hp > 0)
    .map((p) => ({ type: "player" as const, id: String(p.slotIndex) }))
  const enemies = session.enemies
    .filter((e) => !excludeDead || e.hp > 0)
    .map((e) => ({ type: "enemy" as const, id: e.id }))
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
  return (entity as Enemy).name
}

export function getActorLabelWithId(session: Session, actor: CombatActor): string {
  const entity = getActorEntity(session, actor)
  if (!entity) return actorKey(actor)
  if (actor.type === "player") return (entity as Player).name
  const enemy = entity as Enemy
  const sameNameEnemies = session.enemies.filter((e) => e.name === enemy.name)
  if (sameNameEnemies.length <= 1) return enemy.name
  const index = sameNameEnemies.findIndex((e) => e.id === enemy.id) + 1
  return `${enemy.name} (${index})`
}

export function isActorDead(session: Session, actor: CombatActor): boolean {
  const entity = getActorEntity(session, actor)
  return !!entity && entity.hp === 0
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

interface DamageResult {
  hp: number | null
  died: boolean
}

function damageActor(session: Session, actor: CombatActor, amount: number): DamageResult {
  const entity = getActorEntity(session, actor)
  if (!entity) return { hp: null, died: false }
  const newHp = clamp(entity.hp - Math.max(0, amount), 0, entity.maxHp)
  const died = entity.hp > 0 && newHp === 0
  entity.hp = newHp
  return { hp: newHp, died }
}

function healActor(session: Session, actor: CombatActor, amount: number): number | null {
  const entity = getActorEntity(session, actor)
  if (!entity) return null
  entity.hp = clamp(entity.hp + Math.max(0, amount), 0, entity.maxHp)
  return entity.hp
}

function deathMessage(session: Session, actor: CombatActor): string {
  const entity = getActorEntity(session, actor)
  if (!entity) return ""
  const label = getActorLabelWithId(session, actor)
  return actor.type === "enemy" ? `💀 ${label} ถูกสังหาร!` : `💀 ${label} ล้มลง!`
}

function checkAllEnemiesDead(session: Session): boolean {
  return session.enemies.length > 0 && session.enemies.every((e) => e.hp === 0)
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
    const { hp, died } = damageActor(session, pending.target, numericValue)
    if (hp === null) return { consumed: true, message: "ไม่พบเป้าหมาย" }
    const label = getActorLabelWithId(session, pending.target)
    const message = `⚔️ ${getActorLabel(session, pending.source)} โจมตี ${label} ทำดาเมจ ${numericValue} (${label} เหลือ ${hp} HP)`
    addCombatLog(session, message)
    const death = died ? deathMessage(session, pending.target) : undefined
    const sessionEnded = died && checkAllEnemiesDead(session)
    if (sessionEnded) session.state = "ended"
    return { consumed: true, message, deathMessage: death, sessionEnded }
  }

  if (pending.type === "heal") {
    const hp = healActor(session, pending.target, numericValue)
    if (hp === null) return { consumed: true, message: "ไม่พบเป้าหมาย" }
    const entity = getActorEntity(session, pending.target)
    const label = getActorLabelWithId(session, pending.target)
    const message = `🩹 ${getActorLabel(session, pending.source)} ฮีล ${label} +${numericValue} HP (เหลือ ${hp}/${entity?.maxHp ?? "?"} HP)`
    addCombatLog(session, message)
    return { consumed: true, message }
  }

  if (pending.type === "attack") {
    if (pending.target.type === "enemy") {
      const { hp, died } = damageActor(session, pending.target, numericValue)
      if (hp === null) return { consumed: true, message: "ไม่พบเป้าหมาย" }
      const label = getActorLabelWithId(session, pending.target)
      const message = `⚔️ ${getActorLabel(session, pending.source)} โจมตี ${label} ทำดาเมจ ${numericValue} (${label} เหลือ ${hp} HP)`
      addCombatLog(session, message)
      const death = died ? deathMessage(session, pending.target) : undefined
      const sessionEnded = died && checkAllEnemiesDead(session)
      if (sessionEnded) session.state = "ended"

      // มอนตีกลับถ้ายังมีชีวิตอยู่
      let counterAttack: ActiveAttack | undefined
      let counterMessage: string | undefined
      if (!died && hp > 0 && pending.source.type === "player") {
        const counterRoll = Math.floor(Math.random() * hp) + 1
        counterAttack = {
          id: nextId("atk"),
          attacker: pending.target,
          target: pending.source,
          attackValue: counterRoll,
          attackRollText: `counter 1d${hp} = ${counterRoll}`,
          requestedByUserId: userId,
          status: "awaiting_response",
          createdAt: Date.now(),
        }
        session.activeAttacks = [
          counterAttack,
          ...session.activeAttacks.filter((a) => a.status === "awaiting_response").slice(0, 4),
        ]
        counterMessage = `${label} โต้กลับ ${getActorLabel(session, pending.source)} ด้วย ${counterRoll} - รอการตอบสนอง`
        addCombatLog(session, counterMessage)
      }

      return { consumed: true, message, deathMessage: death, sessionEnded, counterAttack, counterMessage }
    }

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
    const message = `${getActorLabel(session, pending.source)} โจมตี ${getActorLabel(session, pending.target)} ด้วย ${numericValue} - รอการตอบสนอง`
    return { consumed: true, message, activeAttack }
  }

  if (pending.type === "dodge") {
    return resolveDodge(session, pending.activeAttackId ?? "", userId, numericValue)
  }

  if (pending.type === "defend") {
    return resolveDefend(session, pending.activeAttackId ?? "", userId, numericValue)
  }

  if (pending.type === "cc" || pending.type === "buff") {
    const actor = getActorEntity(session, pending.source)
    const stats = actor && "stats" in actor ? (actor as Player).stats : undefined
    const threshold = stats?.scr ?? 0
    const success = resolveStatRoll(numericValue, threshold)
    const sourceName = getActorLabel(session, pending.source)
    const targetName = getActorLabel(session, pending.target)
    const actionWord = pending.type === "cc" ? "CC" : "Buff/Debuff"
    const message = success
      ? `🔮 ${sourceName} ใช้ ${actionWord} ต่อ ${targetName} สำเร็จ! (${numericValue} ≤ ${threshold} SCR) — DM จัดการ effect`
      : `🔮 ${sourceName} ใช้ ${actionWord} ต่อ ${targetName} ล้มเหลว (${numericValue} > ${threshold} SCR)`
    addCombatLog(session, message)
    return { consumed: true, message }
  }

  return { consumed: true }
}

export function takeHit(session: Session, attackId: string, userId: string): RollConsumeResult {
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: false, message: "ไม่พบการโจมตี" }
  if (!canRespondForTarget(session, userId, attack.target)) {
    return { consumed: false, message: "คุณไม่สามารถรับผลแทนเป้าหมายนี้ได้" }
  }

  const { hp, died } = damageActor(session, attack.target, attack.attackValue)
  attack.status = "resolved"
  const label = getActorLabelWithId(session, attack.target)
  const message = `⚔️ ${label} รับดาเมจ ${attack.attackValue} จาก ${getActorLabel(session, attack.attacker)} (เหลือ ${hp ?? 0} HP)`
  addCombatLog(session, message)
  const death = died ? deathMessage(session, attack.target) : undefined
  return { consumed: true, message, deathMessage: death, activeAttack: attack }
}

export function requestDodge(session: Session, attackId: string, userId: string): RollConsumeResult {
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: false, message: "ไม่พบการโจมตี" }
  if (!canRespondForTarget(session, userId, attack.target)) {
    return { consumed: false, message: "คุณไม่สามารถหลบแทนเป้าหมายนี้ได้" }
  }
  startPendingAction(session, {
    userId,
    type: "dodge",
    source: attack.target,
    target: attack.attacker,
    activeAttackId: attack.id,
  })
  const message = `${getActorLabel(session, attack.target)} กำลังหลบ - ทอยเต๋าตอนนี้!`
  return { consumed: true, message, activeAttack: attack }
}

export function resolveDodge(
  session: Session,
  attackId: string,
  userId: string,
  dodgeValue: number
): RollConsumeResult {
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: true, message: "ไม่พบการโจมตี" }
  if (!canRespondForTarget(session, userId, attack.target)) {
    return { consumed: true, message: "คุณไม่สามารถหลบแทนเป้าหมายนี้ได้" }
  }

  attack.status = "resolved"
  if (dodgeValue >= attack.attackValue) {
    const message = `🛡️ ${getActorLabel(session, attack.target)} หลบการโจมตีสำเร็จ (${dodgeValue} vs ${attack.attackValue})`
    addCombatLog(session, message)
    return { consumed: true, message, activeAttack: attack }
  }

  const { hp, died } = damageActor(session, attack.target, attack.attackValue)
  const label = getActorLabelWithId(session, attack.target)
  const message = `⚔️ ${label} หลบไม่ทัน (${dodgeValue} vs ${attack.attackValue}) รับดาเมจ ${attack.attackValue} (เหลือ ${hp ?? 0} HP)`
  addCombatLog(session, message)
  const death = died ? deathMessage(session, attack.target) : undefined
  return { consumed: true, message, deathMessage: death, activeAttack: attack }
}

export function requestDefend(session: Session, attackId: string, userId: string): RollConsumeResult {
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: false, message: "ไม่พบการโจมตี" }
  if (!canRespondForTarget(session, userId, attack.target)) {
    return { consumed: false, message: "คุณไม่สามารถป้องกันแทนเป้าหมายนี้ได้" }
  }
  const actor = getActorEntity(session, attack.target)
  const defStat = actor && "stats" in actor ? ((actor as Player).stats?.def ?? 0) : 0
  startPendingAction(session, {
    userId,
    type: "defend",
    source: attack.target,
    target: attack.attacker,
    activeAttackId: attack.id,
  })
  const message = `🔰 ${getActorLabel(session, attack.target)} ป้องกัน — ทอย d20+${defStat} DEF ตอนนี้!`
  return { consumed: true, message, activeAttack: attack }
}

export function resolveDefend(
  session: Session,
  attackId: string,
  userId: string,
  rollValue: number
): RollConsumeResult {
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: true, message: "ไม่พบการโจมตี" }
  if (!canRespondForTarget(session, userId, attack.target)) {
    return { consumed: true, message: "คุณไม่สามารถป้องกันแทนเป้าหมายนี้ได้" }
  }

  const actor = getActorEntity(session, attack.target)
  const defStat = actor && "stats" in actor ? ((actor as Player).stats?.def ?? 0) : 0
  const totalDefend = rollValue + defStat
  attack.status = "resolved"

  if (totalDefend >= attack.attackValue) {
    const message = `🔰 ${getActorLabel(session, attack.target)} ป้องกันสำเร็จ (${rollValue}+${defStat}=${totalDefend} vs ${attack.attackValue})`
    addCombatLog(session, message)
    return { consumed: true, message, activeAttack: attack }
  }

  const remainingDmg = attack.attackValue - totalDefend
  const { hp, died } = damageActor(session, attack.target, remainingDmg)
  const label = getActorLabelWithId(session, attack.target)
  const message = `🔰 ${label} ป้องกันบางส่วน (${rollValue}+${defStat}=${totalDefend} vs ${attack.attackValue}) รับดาเมจ ${remainingDmg} (เหลือ ${hp ?? 0} HP)`
  addCombatLog(session, message)
  const death = died ? deathMessage(session, attack.target) : undefined
  return { consumed: true, message, deathMessage: death, activeAttack: attack }
}

export function cancelAttack(session: Session, attackId: string, userId: string): RollConsumeResult {
  if (session.hostId !== userId) return { consumed: false, message: "เฉพาะ DM เท่านั้นที่ยกเลิกการโจมตีได้" }
  const attack = session.activeAttacks.find((a) => a.id === attackId && a.status === "awaiting_response")
  if (!attack) return { consumed: false, message: "ไม่พบการโจมตี" }
  attack.status = "cancelled"
  const message = `🚫 DM ยกเลิกการโจมตีของ ${getActorLabel(session, attack.attacker)}`
  addCombatLog(session, message)
  return { consumed: true, message, activeAttack: attack }
}

export interface MonsterAttackResult extends RollConsumeResult {
  needsRoll?: boolean
}

export function monsterAttack(
  session: Session,
  attackerActor: CombatActor,
  targetActor: CombatActor,
  dmUserId: string
): MonsterAttackResult {
  if (session.monsterRollMode === "auto") {
    const roll = Math.floor(Math.random() * 20) + 1
    const activeAttack: ActiveAttack = {
      id: nextId("atk"),
      attacker: attackerActor,
      target: targetActor,
      attackValue: roll,
      attackRollText: `auto 1d20 = ${roll}`,
      requestedByUserId: dmUserId,
      status: "awaiting_response",
      createdAt: Date.now(),
    }
    session.activeAttacks = [
      activeAttack,
      ...session.activeAttacks.filter((a) => a.status === "awaiting_response").slice(0, 4),
    ]
    const message = `${getActorLabelWithId(session, attackerActor)} โจมตี ${getActorLabel(session, targetActor)} ด้วย ${roll} - รอการตอบสนอง`
    return { consumed: true, message, activeAttack }
  }

  // manual -DM ทอยกับ Rollem เอง
  startPendingAction(session, {
    userId: dmUserId,
    type: "attack",
    source: attackerActor,
    target: targetActor,
  })
  const message = `${getActorLabelWithId(session, attackerActor)} กำลังโจมตี ${getActorLabel(session, targetActor)} - DM ทอยเต๋าตอนนี้!`
  return { consumed: true, message, needsRoll: true }
}

export function actionLabel(type: CombatActionType): string {
  if (type === "attack") return "Attack"
  if (type === "damage") return "Damage"
  if (type === "heal") return "Heal"
  if (type === "cc") return "CC"
  if (type === "buff") return "Buff/Debuff"
  if (type === "defend") return "Defend"
  return "Dodge"
}

export function resolveStatRoll(rollValue: number, threshold: number): boolean {
  if (threshold <= 0) return false
  return rollValue <= threshold
}
