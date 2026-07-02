/** Integer cell center on the 2D grid. Origin NW, x east, y south. */
export interface Coordinate {
  x: number
  y: number
}

/** Eight compass directions. */
export type Direction = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'

/** Terrain classification. Extensible — new kinds added in future rules versions. */
export type TerrainKind = 'open' | 'obstacle'

/** A single cell in the terrain grid. */
export interface Cell {
  coord: Coordinate
  terrain: TerrainKind
  obstacleHeight: number
}
