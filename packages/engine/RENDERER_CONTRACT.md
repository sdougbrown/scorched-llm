# Renderer Contract

This document defines the renderer-independent contracts that a future 3D spectator (or any alternative renderer) must consume from the Scorched-LLM engine.

The engine is a pure game simulation library. It exports no rendering code, no Canvas/SVG/DOM types, no animation timing, and no visual style. The spectator owns animation scheduling, rendering, and visual presentation.

## Coordinate System

- **Grid**: Integer 2D grid, origin `(0,0)` at the NW (top-left) corner.
- **Axes**: `x` increases east (right), `y` increases south (down).
- **Cell centers** are at integer coordinates.
- **Type**: `{ x: number; y: number }`

This is a standard matrix-coordinate system. The engine's geometry module provides `manhattan`, `euclidean`, and `chebyshev` distance functions, as well as `cellsInRadius` and `inBounds` utilities.

## Height System (2.5D)

The engine is 2.5D: gameplay occurs on a 2D grid but shells follow a parabolic height profile.

### Height Parameters

| Parameter | Source | Description |
|-----------|--------|-------------|
| `obstacleHeight` | `map.obstacleHeight` | Per-cell height value (0 for open terrain, >0 for obstacles) |
| `tankHeight` | `config.shell.tankHeight` | Height at which a tank is hittable |
| `apexHeight` | `config.shell.apexHeight` | Peak height of a shell trajectory |

### Shell Height Profile

Shell height at sample index `i` of `N` total samples:

```
height(i) = apexHeight * (1 - (2i/N - 1)^2)
```

This is a parabola that peaks at `i = N/2` with height `apexHeight`, and ends at `i = 0` and `i = N` with height 0.

### Collision Resolution

For each sample cell along the trajectory (in traversal order):

1. **Out of bounds** → miss (shell flies off the map)
2. **Obstacle collision**: if `cellHeight <= terrainCell.obstacleHeight` → blocked (shell hits terrain)
3. **Tank collision**: if a living tank (excluding the shooter) occupies that cell → hit

The first match wins. The trajectory is captured in full regardless of early termination.

## Trajectory Contract

### `ShellTrajectory`

```typescript
interface ShellTrajectory {
  sampledCells: Coordinate[]
  impactPoint: Coordinate
}
```

- **`sampledCells`**: Cells in traversal order from firer to target. Computed via the supercover line algorithm.
- **`impactPoint`**: The cell where the shell ultimately impacts (or would impact).

### Supercover Line Algorithm

The engine uses a supercover line traversal: every cell whose interior is intersected by the line segment from start to end is included, in traversal order. This includes cells the line barely touches (supercover semantics, not Bresenham).

**Tie-breaking at grid vertices**: When the line passes exactly through a grid vertex (corner where four cells meet), all four corner cells are included. Cells sharing the same parametric position are ordered by scan order (y-major within the same x) as a deterministic secondary sort.

**Determinism**: Same start/end → same cell list.

The trajectory is immutable in the log — the spectator animates it after the fact.

## Flare Contract

### `FlareState`

```typescript
interface FlareState {
  id: string
  targetCell: Coordinate
  radius: number
  firerId: string
  activatedTurn: number
  expiryTurn: number
}
```

### Behavior

- **Reveals** a circular area: all cells whose center-to-center Euclidean distance from `targetCell` ≤ `radius`.
- **Expiry**: at the start of the firer's next scheduled turn (absolute turn-sequence boundary).
- **Scheduling**: expiry is scheduled even if the firer dies.
- **Sharing**: flare reveals are globally shared — all living players see the same revealed cells.
- **Calculation**: for N players, the firer's next turn is `currentTurn + N`.

### `cellsInRadius`

Uses Euclidean distance: a cell `(cx, cy)` is included if `(cx - targetX)^2 + (cy - targetY)^2 <= radius^2`.

## Replay Contract (MatchLog)

### Schema Version

```typescript
interface MatchLog {
  schemaVersion: 'v1'
  metadata: {
    matchId: string
    createdAt: string
    promptVersion: string
    adapterVersions: Record<string, string>
  }
  config: MatchConfig
  initialState: GameState
  turns: TurnEvent[]
  result: MatchResult
}
```

- **`schemaVersion`**: `'v1'` — versioned. Migrations are handled by the log-loader.
- **`metadata.adapterVersions`**: Maps adapter IDs to their version strings (populated when model-backed agents participate).

### Config

Full `MatchConfig` — the rules and settings used. A renderer should use this to understand map dimensions, shell parameters, fog radius, turn limits, etc.

### Initial State

Complete `GameState` at match start — terrain, tank positions, HP, facing directions, flares.

### Turns

Ordered `TurnEvent[]`. Each turn has:
- `turn`: turn number
- `player`: player label
- `actions`: `ActionEvent[]` — each action has a `call` (ToolCall), `result` (ActionResult), and `snapshot` (GameState post-action)
- `worldview`: the `WorldView` the player saw
- `modelTrace` (optional): `{ toolCalls, tokensIn, tokensOut, costUsd, latencyMs, finishReason }`

### Reducer

The spectator's reducer (`packages/spectator/src/reducer.ts`) reconstructs any state by reducing events from `initialState`. It iterates through turns and actions, applying the last `snapshot` from each `ActionEvent` to compute `GameState` at any point.

Post-action snapshots are optional seek indexes but must match reducer output.

### Result

```typescript
interface MatchResult {
  terminationReason: 'last-standing' | 'turn-limit' | 'mutual-destruction'
  placements: Array<{
    tankId: string
    rank: number
    hp: number
    damageDealt: number
    hitsLanded: number
    tieGroup?: string
  }>
}
```

## What the Engine Does NOT Export

The engine exports **pure data types and the replay contract only**:

- **No rendering code** — no Canvas, SVG, DOM, or WebGL
- **No animation timing** — the spectator owns `requestAnimationFrame` scheduling
- **No visual style** — fog visualization, colors, layout, and tank shapes are renderer choices
- **No spectator dependencies** — the engine package has zero dependency on `@scorched-llm/spectator`

## Versioning

| Version Field | Location | Description |
|--------------|----------|-------------|
| `rulesVersion` | `MatchConfig` | Engine rules version |
| `generatorVersion` | `config.map` | Terrain generator version |
| `schemaVersion` | `MatchLog` | Log format version |
| `promptVersion` | `metadata` | System prompt version |
| `engineVersion` | `exhibition-info.json` | Engine package version |

A renderer must check `schemaVersion` and handle migration if needed.
