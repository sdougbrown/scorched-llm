import type { MatchLog, TurnEvent } from '@scorched-llm/engine'

const CSS = `
.stats-overlay {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 13px;
  color: #c9d1d9;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 16px;
  max-width: 640px;
}

.stats-overlay__title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
  color: #f0f6fc;
  border-bottom: 1px solid #30363d;
  padding-bottom: 8px;
}

.stats-overlay__empty {
  color: #8b949e;
  font-style: italic;
  text-align: center;
  padding: 24px 0;
}

.stats-overlay__header {
  margin-bottom: 16px;
  padding: 8px 12px;
  background: #161b22;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #8b949e;
}

.stats-overlay__header span {
  color: #c9d1d9;
}

.stats-card {
  margin-bottom: 16px;
  border: 1px solid #30363d;
  border-radius: 4px;
  overflow: hidden;
}

.stats-card__title {
  margin: 0;
  padding: 8px 12px;
  font-size: 14px;
  font-weight: 600;
  background: #161b22;
  color: #f0f6fc;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.stats-card__status {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
}

.stats-card__status--alive {
  background: rgba(63, 185, 80, 0.15);
  color: #3fb950;
}

.stats-card__status--dead {
  background: rgba(248, 81, 73, 0.15);
  color: #f85149;
}

.stats-card__body {
  padding: 12px;
}

.stats-card__stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.stats-card__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stats-card__stat-label {
  font-size: 11px;
  color: #8b949e;
  text-transform: uppercase;
}

.stats-card__stat-value {
  font-size: 14px;
  color: #f0f6fc;
  font-weight: 500;
}

.stats-card__actions,
.stats-card__traces {
  margin-bottom: 8px;
}

.stats-card__section-title {
  font-size: 11px;
  color: #8b949e;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.stats-card__action-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.stats-card__action-tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  background: #21262d;
  color: #c9d1d9;
  border: 1px solid #30363d;
}

.stats-card__trace-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}

.stats-card__trace-item {
  color: #8b949e;
}

.stats-card__trace-item span {
  color: #c9d1d9;
  font-weight: 500;
}

.stats-card__placement {
  font-size: 12px;
  color: #8b949e;
  margin-top: 4px;
}

.stats-card__placement span {
  color: #f0c850;
  font-weight: 600;
}
`

export function createStatsOverlay(): HTMLElement {
  const styleEl = document.createElement('style')
  styleEl.textContent = CSS
  if (!document.querySelector('style[data-stats-overlay-css]')) {
    styleEl.setAttribute('data-stats-overlay-css', 'true')
    document.head.appendChild(styleEl)
  }

  const panel = document.createElement('div')
  panel.className = 'stats-overlay'
  panel.innerHTML = `
    <h2 class="stats-overlay__title">Match Stats</h2>
    <div class="stats-overlay__content"></div>
    <div class="stats-overlay__empty">No match loaded</div>
  `
  return panel
}

export function updateStatsOverlay(panel: HTMLElement, log: MatchLog): void {
  const content = panel.querySelector('.stats-overlay__content')
  const empty = panel.querySelector('.stats-overlay__empty')

  if (!content || !empty) return

  empty.remove()

  // Termination reason display
  const terminationLabels: Record<string, string> = {
    'last-standing': 'Last Standing',
    'turn-limit': 'Turn Limit',
    'mutual-destruction': 'Mutual Destruction',
  }

  // Build turns by player map
  const turnsByPlayer = new Map<string, TurnEvent[]>()
  for (const turn of log.turns) {
    if (!turnsByPlayer.has(turn.player)) turnsByPlayer.set(turn.player, [])
    turnsByPlayer.get(turn.player)!.push(turn)
  }

  // Collect all tank IDs from all states (initial + snapshots)
  const tankIds = new Set<string>()
  for (const tank of log.initialState.tanks) {
    tankIds.add(tank.id)
  }


  // Build placement lookup
  const placementMap = new Map<string, { rank: number; tieGroup?: string }>()
  for (const p of log.result.placements) {
    placementMap.set(p.tankId, { rank: p.rank, tieGroup: p.tieGroup })
  }

  let headerHtml = ''
  const termLabel = terminationLabels[log.result.terminationReason] ?? log.result.terminationReason
  headerHtml += `<div class="stats-overlay__header">`
  headerHtml += `Termination: <span>${termLabel}</span> &middot; Total turns: <span>${log.turns.length}</span> &middot; Match ID: <span>${log.metadata.matchId}</span>`
  headerHtml += `</div>`

  let cardsHtml = ''

  for (const tank of log.initialState.tanks) {
    const tankTurns = turnsByPlayer.get(tank.id) ?? []

    // Count actions by kind
    const actionCounts: Record<string, number> = {}
    let invalidCount = 0

    for (const turn of tankTurns) {
      for (const action of turn.actions) {
        actionCounts[action.kind] = (actionCounts[action.kind] ?? 0) + 1
        if (action.result.kind === 'invalid') invalidCount++
      }
    }

    // Tokens/cost/latency from modelTrace
    let totalTokensIn = 0
    let totalTokensOut = 0
    let totalCost = 0
    let unknownCostCount = 0
    let totalLatency = 0
    let traceCount = 0

    for (const turn of tankTurns) {
      if (turn.modelTrace) {
        totalTokensIn += turn.modelTrace.tokensIn
        totalTokensOut += turn.modelTrace.tokensOut
        if (turn.modelTrace.costUsd !== 'unknown') totalCost += turn.modelTrace.costUsd
        else unknownCostCount++
        totalLatency += turn.modelTrace.latencyMs
        traceCount++
      }
    }

    // Determine final state
    const hp = tank.hp
    const maxHp = tank.maxHp
    const alive = tank.alive
    const hitsLanded = tank.hitsLanded
    const damageDealt = tank.damageDealt


    const placement = placementMap.get(tank.id)
    const statusClass = alive ? 'stats-card__status--alive' : 'stats-card__status--dead'
    const statusText = alive ? 'Alive' : 'Destroyed'

    let avgLatency = 0
    if (traceCount > 0) {
      avgLatency = totalLatency / traceCount
    }

    // Action tags
    const actionKindLabels: Record<string, string> = {
      move: 'Move',
      flare: 'Flare',
      shell: 'Shell',
      pass: 'Pass',
      invalid: 'Invalid',
      observation: 'Obs',
    }

    let actionTagsHtml = ''
    for (const [kind, count] of Object.entries(actionCounts)) {
      const label = actionKindLabels[kind] ?? kind
      actionTagsHtml += `<span class="stats-card__action-tag">${label}: ${count}</span>`
    }
    if (Object.keys(actionCounts).length === 0) {
      actionTagsHtml = '<span class="stats-card__action-tag" style="opacity:0.5;">No actions</span>'
    }

    // Placement display
    let placementHtml = ''
    if (placement) {
      const rankSuffix = placement.rank === 1 ? 'st' : placement.rank === 2 ? 'nd' : placement.rank === 3 ? 'rd' : 'th'
      placementHtml = `<div class="stats-card__placement">Placed <span>${placement.rank}${rankSuffix}</span>`
      if (placement.tieGroup) placementHtml += ` (${placement.tieGroup})`
      placementHtml += `</div>`
    }

    cardsHtml += `<div class="stats-card">`
    cardsHtml += `  <div class="stats-card__title">`
    cardsHtml += `    <span>Tank ${tank.id}</span>`
    cardsHtml += `    <span class="stats-card__status ${statusClass}">${statusText}</span>`
    cardsHtml += `  </div>`
    cardsHtml += `  <div class="stats-card__body">`

    // Main stats
    cardsHtml += `    <div class="stats-card__stats">`
    cardsHtml += `      <div class="stats-card__stat"><span class="stats-card__stat-label">HP</span><span class="stats-card__stat-value">${hp}/${maxHp}</span></div>`
    cardsHtml += `      <div class="stats-card__stat"><span class="stats-card__stat-label">Damage Dealt</span><span class="stats-card__stat-value">${damageDealt}</span></div>`
    cardsHtml += `      <div class="stats-card__stat"><span class="stats-card__stat-label">Hits Landed</span><span class="stats-card__stat-value">${hitsLanded}</span></div>`
    cardsHtml += `      <div class="stats-card__stat"><span class="stats-card__stat-label">Invalid Calls</span><span class="stats-card__stat-value">${invalidCount}</span></div>`
    cardsHtml += `    </div>`

    // Actions section
    cardsHtml += `    <div class="stats-card__actions">`
    cardsHtml += `      <div class="stats-card__section-title">Actions</div>`
    cardsHtml += `      <div class="stats-card__action-tags">${actionTagsHtml}</div>`
    cardsHtml += `    </div>`

    // Traces section
    cardsHtml += `    <div class="stats-card__traces">`
    cardsHtml += `      <div class="stats-card__section-title">Model Traces (${traceCount} turns)</div>`
    cardsHtml += `      <div class="stats-card__trace-row">`
    cardsHtml += `        <span class="stats-card__trace-item">Tokens in: <span>${totalTokensIn}</span></span>`
    cardsHtml += `        <span class="stats-card__trace-item">Tokens out: <span>${totalTokensOut}</span></span>`
    cardsHtml += `        <span class="stats-card__trace-item">Avg latency: <span>${avgLatency.toFixed(0)}ms</span></span>`
    cardsHtml += `      </div>`
    cardsHtml += `      <div class="stats-card__trace-row">`
    if (unknownCostCount > 0) {
      cardsHtml += `        <span class="stats-card__trace-item">Cost: <span>$${totalCost.toFixed(4)}</span> (${unknownCostCount} unknown)</span>`
    } else {
      cardsHtml += `        <span class="stats-card__trace-item">Cost: <span>$${totalCost.toFixed(4)}</span></span>`
    }
    cardsHtml += `      </div>`
    cardsHtml += `    </div>`

    // Placement
    if (placementHtml) {
      cardsHtml += placementHtml
    }

    cardsHtml += `  </div>`
    cardsHtml += `</div>`
  }

  content.innerHTML = headerHtml + cardsHtml
}