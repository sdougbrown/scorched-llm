export const VERSION = '0.0.0'

/** Game state representing a complete duel scenario. */
export interface GameState {
  turn: number
  players: PlayerState[]
  arena: string
}

/** State for a single player in the game. */
export interface PlayerState {
  name: string
  health: number
  ammo: number
}

/** A move that a player can make on their turn. */
export interface Move {
  type: string
  params: Record<string, unknown>
}