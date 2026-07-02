import type { MatchLog } from '@scorched-llm/engine'

type UnknownRecord = Record<string, unknown>


function isString(val: unknown): val is string {
  return typeof val === 'string'
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function isArray(val: unknown): val is unknown[] {
  return Array.isArray(val)
}

function isRecordOfStrings(val: unknown): val is Record<string, string> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false
  const obj = val as Record<string, unknown>
  return Object.values(obj).every((v) => typeof v === 'string')
}

function validateMatchLog(raw: unknown): asserts raw is MatchLog {
  const o = raw as UnknownRecord

  // schemaVersion
  if (!('schemaVersion' in o)) throw new Error('Missing field: schemaVersion')
  if (!isNonEmptyString(o.schemaVersion)) throw new Error('Invalid field: schemaVersion must be a non-empty string')

  // metadata
  if (!('metadata' in o)) throw new Error('Missing field: metadata')
  if (!isObject(o.metadata)) throw new Error('Invalid field: metadata must be an object')
  const meta = o.metadata as UnknownRecord

  if (!('matchId' in meta)) throw new Error('Missing field: metadata.matchId')
  if (!isString(meta.matchId)) throw new Error('Invalid field: metadata.matchId must be a string')

  if (!('createdAt' in meta)) throw new Error('Missing field: metadata.createdAt')
  if (!isString(meta.createdAt)) throw new Error('Invalid field: metadata.createdAt must be a string')

  if (!('promptVersion' in meta)) throw new Error('Missing field: metadata.promptVersion')
  if (!isString(meta.promptVersion)) throw new Error('Invalid field: metadata.promptVersion must be a string')

  if (!('adapterVersions' in meta)) throw new Error('Missing field: metadata.adapterVersions')
  if (!isRecordOfStrings(meta.adapterVersions)) throw new Error('Invalid field: metadata.adapterVersions must be a record of strings')

  // config — must be an object (MatchConfig is validated by engine; we just check it exists)
  if (!('config' in o)) throw new Error('Missing field: config')
  if (!isObject(o.config)) throw new Error('Invalid field: config must be an object')

  // initialState
  if (!('initialState' in o)) throw new Error('Missing field: initialState')
  if (!isObject(o.initialState)) throw new Error('Invalid field: initialState must be an object')
  const init = o.initialState as UnknownRecord

  if (!('turn' in init)) throw new Error('Missing field: initialState.turn')
  if (typeof init.turn !== 'number') throw new Error('Invalid field: initialState.turn must be a number')

  if (!('currentPlayerIndex' in init)) throw new Error('Missing field: initialState.currentPlayerIndex')
  if (typeof init.currentPlayerIndex !== 'number') throw new Error('Invalid field: initialState.currentPlayerIndex must be a number')

  if (!('tanks' in init)) throw new Error('Missing field: initialState.tanks')
  if (!isArray(init.tanks)) throw new Error('Invalid field: initialState.tanks must be an array')

  if (!('flares' in init)) throw new Error('Missing field: initialState.flares')
  if (!isArray(init.flares)) throw new Error('Invalid field: initialState.flares must be an array')

  if (!('terrain' in init)) throw new Error('Missing field: initialState.terrain')
  if (!isArray(init.terrain)) throw new Error('Invalid field: initialState.terrain must be an array')
  for (let i = 0; i < init.terrain.length; i++) {
    if (!isArray(init.terrain[i])) throw new Error(`Invalid field: initialState.terrain[${i}] must be an array`)
  }

  if (!('rulesVersion' in init)) throw new Error('Missing field: initialState.rulesVersion')
  if (!isString(init.rulesVersion)) throw new Error('Invalid field: initialState.rulesVersion must be a string')

  // turns
  if (!('turns' in o)) throw new Error('Missing field: turns')
  if (!isArray(o.turns)) throw new Error('Invalid field: turns must be an array')
  for (let i = 0; i < o.turns.length; i++) {
    const turnObj = o.turns[i]
    if (!isObject(turnObj)) throw new Error(`Invalid field: turns[${i}] must be an object`)
    const t = turnObj as UnknownRecord

    if (!('turn' in t)) throw new Error(`Missing field: turns[${i}].turn`)
    if (typeof t.turn !== 'number') throw new Error(`Invalid field: turns[${i}].turn must be a number`)

    if (!('player' in t)) throw new Error(`Missing field: turns[${i}].player`)
    if (!isString(t.player)) throw new Error(`Invalid field: turns[${i}].player must be a string`)

    if (!('actions' in t)) throw new Error(`Missing field: turns[${i}].actions`)
    if (!isArray(t.actions)) throw new Error(`Invalid field: turns[${i}].actions must be an array`)
  }

  // result
  if (!('result' in o)) throw new Error('Missing field: result')
  if (!isObject(o.result)) throw new Error('Invalid field: result must be an object')
  const res = o.result as UnknownRecord

  if (!('terminationReason' in res)) throw new Error('Missing field: result.terminationReason')
  if (!isString(res.terminationReason)) throw new Error('Invalid field: result.terminationReason must be a string')

  if (!('placements' in res)) throw new Error('Missing field: result.placements')
  if (!isArray(res.placements)) throw new Error('Invalid field: result.placements must be an array')
}

export function loadMatchLog(json: string): MatchLog {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Invalid JSON')
  }

  validateMatchLog(parsed)
  return parsed as MatchLog
}

export async function loadMatchLogFromFile(file: File): Promise<MatchLog> {
  try {
    const text = await file.text()
    return loadMatchLog(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`File read error: ${message}`)
  }
}