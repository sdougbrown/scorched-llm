import type { Coordinate } from '../types/coords.js'
import type { ActionResult } from '../types/tool.js'

/** Create an `ok` action result. */
export function ok(): ActionResult { return { kind: 'ok' } }

/** Create a `blocked` action result with a reason. */
export function blocked(reason: string): ActionResult { return { kind: 'blocked', reason } }

/** Create a `miss` action result. */
export function miss(): ActionResult { return { kind: 'miss' } }

/** Create an obstacle impact result for a valid shell shot. */
export function obstacleHit(coordinate: Coordinate): ActionResult {
  return { kind: 'obstacle-hit', coordinate }
}

/** Create a `hit` action result targeting a tank with given damage. */
export function hit(targetId: string, damage: number): ActionResult { return { kind: 'hit', targetId, damage } }

/** Create a `revealed` action result with the revealed cell coordinates. */
export function revealed(cells: Coordinate[]): ActionResult { return { kind: 'revealed', cells } }

/** Create an `invalid` action result with a reason. */
export function invalid(reason: string): ActionResult { return { kind: 'invalid', reason } }
