import type { Coordinate, Cell } from './coords.js'

/** A tank's current state. */
export interface TankState {
  id: string
  position: Coordinate
  hp: number
  maxHp: number
  alive: boolean
  facing: number
  /** Bombs left this match; present only when config.bomb is set. */
  bombsRemaining?: number
  damageDealt: number
  hitsLanded: number
}

/** An active flare in the arena. */
export interface FlareState {
  id: string
  targetCell: Coordinate
  radius: number
  firerId: string
  activatedTurn: number
  expiryTurn: number
}

/** Complete game state at a given moment. */
export interface GameState {
  turn: number
  currentPlayerIndex: number
  tanks: TankState[]
  flares: FlareState[]
  terrain: Cell[][]
  rulesVersion: string
}
