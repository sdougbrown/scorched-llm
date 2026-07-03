import type { PlayerSpec } from '@scorched-llm/engine'

export interface PlayerIdentity {
  label: string
  details: string
}

export function getPlayerIdentity(tankId: string, player?: PlayerSpec): PlayerIdentity {
  if (!player) {
    return { label: tankId, details: tankId }
  }

  const details = [tankId]
  if (player.model) {
    details.push(player.model.model)
    try {
      details.push(new URL(player.model.baseURL).host)
    } catch {
      details.push(player.model.baseURL)
    }
  } else if (player.scripted) {
    details.push(`scripted:${player.scripted}`)
  }

  return {
    label: player.label,
    details: details.join(' · '),
  }
}
