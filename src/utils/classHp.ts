const CLASS_HP_MAP: Record<string, number> = {
  barbarian: 150,
  fighter: 120,
  paladin: 120,
  ranger: 120,
  cleric: 100,
  druid: 100,
  monk: 100,
  warlock: 100,
  rogue: 90,
  bard: 90,
  wizard: 80,
  sorcerer: 80,
}

export function getDefaultHp(className: string): number {
  return CLASS_HP_MAP[className.toLowerCase().trim()] ?? 100
}
