import type { GameState } from '../types/state.js'
import type { MatchConfig } from '../config/schema.js'
import type { MatchResult } from '../types/log.js'

export function computeMatchResult(
  state: GameState,
  config: MatchConfig,
  turnNumber: number,
): MatchResult {
  const aliveTanks = state.tanks.filter((t) => t.alive)
  const deadTanks = state.tanks.filter((t) => !t.alive)

  // One survivor
  if (aliveTanks.length === 1 && deadTanks.length > 0) {
    return {
      terminationReason: 'last-standing',
      placements: [
        {
          tankId: aliveTanks[0].id,
          rank: 1,
          hp: aliveTanks[0].hp,
          damageDealt: aliveTanks[0].damageDealt,
          hitsLanded: aliveTanks[0].hitsLanded,
        },
        ...deadTanks.map((t, i) => ({
          tankId: t.id,
          rank: i + 2,
          hp: t.hp,
          damageDealt: t.damageDealt,
          hitsLanded: t.hitsLanded,
        })),
      ],
    }
  }

  // Zero survivors
  if (aliveTanks.length === 0) {
    return {
      terminationReason: 'mutual-destruction',
      placements: state.tanks.map((t, i) => ({
        tankId: t.id,
        rank: i + 1,
        hp: t.hp,
        damageDealt: t.damageDealt,
        hitsLanded: t.hitsLanded,
        tieGroup: 'draw',
      })),
    }
  }

  // Turn limit or other — rank by criteria
  const sorted = [...state.tanks].sort((a, b) => {
    // Alive status (desc)
    if (a.alive !== b.alive) return a.alive ? 1 : -1
    // HP remaining (desc)
    if (a.hp !== b.hp) return b.hp - a.hp
    // Damage dealt (desc)
    if (a.damageDealt !== b.damageDealt) return b.damageDealt - a.damageDealt
    // Hits landed (desc)
    if (a.hitsLanded !== b.hitsLanded) return b.hitsLanded - a.hitsLanded
    return 0
  })

  const placements: MatchResult['placements'] = []
  let rank = 1
  let i = 0

  while (i < sorted.length) {
    // Find all tanks tied with the current one
    const current = sorted[i]
    const tieGroup: typeof sorted = [current]
    let j = i + 1
    while (j < sorted.length) {
      const candidate = sorted[j]
      if (
        candidate.alive === current.alive &&
        candidate.hp === current.hp &&
        candidate.damageDealt === current.damageDealt &&
        candidate.hitsLanded === current.hitsLanded
      ) {
        tieGroup.push(candidate)
        j++
      } else {
        break
      }
    }

    const groupKey = `group-${rank}`
    for (const t of tieGroup) {
      placements.push({
        tankId: t.id,
        rank,
        hp: t.hp,
        damageDealt: t.damageDealt,
        hitsLanded: t.hitsLanded,
        tieGroup: tieGroup.length > 1 ? groupKey : undefined,
      })
    }

    rank += tieGroup.length
    i = j
  }

  return {
    terminationReason: turnNumber >= config.turnLimit
      ? 'turn-limit'
      : 'last-standing',
    placements,
  }
}
