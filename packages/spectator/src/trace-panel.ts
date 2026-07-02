import type { TurnEvent, ActionResult, Tool } from '@scorched-llm/engine'

function formatTool(tool: Tool): string {
  switch (tool.kind) {
    case 'look':
      return 'look()'
    case 'known_map':
      return 'known_map()'
    case 'move':
      return `move(direction=${tool.direction}, distance=${tool.distance})`
    case 'fire_flare':
      return `fire_flare(direction=${tool.direction}, range=${tool.range})`
    case 'fire_shell':
      return `fire_shell(angle=${tool.angle}, power=${tool.power})`
    case 'pass':
      return 'pass()'
  }
}

function formatResult(result: ActionResult): string {
  switch (result.kind) {
    case 'ok':
      return 'ok'
    case 'blocked':
      return `blocked: ${result.reason}`
    case 'miss':
      return 'miss'
    case 'hit':
      return `hit(${result.targetId}, ${result.damage} damage)`
    case 'revealed':
      return `revealed (${result.cells.length} cells)`
    case 'invalid':
      return `invalid: ${result.reason}`
  }
}

function formatCost(cost: number | 'unknown'): string {
  if (cost === 'unknown') return 'unknown'
  return `$${cost.toFixed(3)}`
}

const RESULT_BEM_CLASS: Record<ActionResult['kind'], string> = {
  ok: '--ok',
  blocked: '--error',
  miss: '--miss',
  hit: '--hit',
  revealed: '',
  invalid: '--error',
} as const

function injectStyles(): void {
  if (document.querySelector('style[data-trace-panel]')) return

  const style = document.createElement('style')
  style.dataset.tracePanel = 'true'
  style.textContent = `
    .trace-panel {
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      border: 1px solid #2a2a4a;
      border-radius: 6px;
      overflow: hidden;
    }

    .trace-panel__title {
      margin: 0;
      padding: 10px 14px;
      font-size: 14px;
      font-weight: 600;
      background: #16213e;
      border-bottom: 1px solid #2a2a4a;
      color: #7f5af0;
    }

    .trace-panel__content {
      padding: 12px 14px;
      max-height: 600px;
      overflow-y: auto;
    }

    .trace-panel__empty {
      color: #555;
      font-style: italic;
    }

    .trace-panel__assistant {
      background: #0f0f23;
      border: 1px solid #2a2a4a;
      border-radius: 4px;
      padding: 10px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0 0 10px 0;
      color: #c8caa0;
      max-height: 240px;
      overflow-y: auto;
    }

    .trace-panel__stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
      margin: 10px 0;
      background: #0f0f23;
      border: 1px solid #2a2a4a;
      border-radius: 4px;
      padding: 10px 12px;
    }

    .trace-panel__stat-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #666;
    }

    .trace-panel__stat-value {
      font-size: 13px;
      color: #e0e0e0;
    }

    .trace-panel__calls {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 10px;
    }

    .trace-panel__call {
      background: #16213e;
      border: 1px solid #2a2a4a;
      border-radius: 4px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .trace-panel__call--ok {
      border-left: 3px solid #2ecc71;
    }

    .trace-panel__call--error {
      border-left: 3px solid #e74c3c;
    }

    .trace-panel__call--hit {
      border-left: 3px solid #f39c12;
    }

    .trace-panel__call--miss {
      border-left: 3px solid #f1c40f;
    }

    .trace-panel__call-name {
      font-weight: 600;
      color: #7f5af0;
      font-size: 12px;
      white-space: nowrap;
    }

    .trace-panel__call-params {
      color: #aaa;
      font-size: 11px;
      white-space: nowrap;
    }

    .trace-panel__call-result {
      margin-left: auto;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .trace-panel__call-result--ok {
      color: #2ecc71;
    }

    .trace-panel__call-result--error {
      color: #e74c3c;
    }

    .trace-panel__call-result--hit {
      color: #f39c12;
    }

    .trace-panel__call-result--miss {
      color: #f1c40f;
    }

    .trace-panel__call-result--revealed {
      color: #3498db;
    }

    .trace-panel__call-result--invalid {
      color: #e74c3c;
    }
  `
  document.head.appendChild(style)
}

export function createTracePanel(tankId: string): HTMLElement {
  injectStyles()

  const panel = document.createElement('div')
  panel.className = 'trace-panel'

  const title = document.createElement('h3')
  title.className = 'trace-panel__title'
  title.textContent = `Tank: ${tankId}`

  const content = document.createElement('div')
  content.className = 'trace-panel__content'

  const empty = document.createElement('div')
  empty.className = 'trace-panel__empty'
  empty.textContent = 'No data yet'
  content.appendChild(empty)

  panel.appendChild(title)
  panel.appendChild(content)

  panel.dataset.tankId = tankId
  return panel
}

export function updateTracePanel(panel: HTMLElement, turn: TurnEvent, _tankId: string): void {
  const content = panel.querySelector('.trace-panel__content')
  if (!content) return

  content.innerHTML = ''

  const trace = turn.modelTrace
  if (!trace) {
    const empty = document.createElement('div')
    empty.className = 'trace-panel__empty'
    empty.textContent = 'No trace data'
    content.appendChild(empty)
    return
  }

  // Assistant text
  if (trace.assistantText) {
    const pre = document.createElement('pre')
    pre.className = 'trace-panel__assistant'
    pre.textContent = trace.assistantText
    content.appendChild(pre)
  }

  // Build a lookup of actions by tool call id
  const actionByCallId = new Map<string, ActionResult>()
  for (const action of turn.actions ?? []) {
    actionByCallId.set(action.call.id, action.result)
  }

  // Stats summary row
  const statsEl = document.createElement('div')
  statsEl.className = 'trace-panel__stats'

  const stats: Array<{ label: string; value: string }> = [
    { label: 'Tokens In', value: String(trace.tokensIn) },
    { label: 'Tokens Out', value: String(trace.tokensOut) },
    { label: 'Cost', value: formatCost(trace.costUsd) },
    { label: 'Latency', value: `${trace.latencyMs}ms` },
    { label: 'Finish Reason', value: trace.finishReason },
  ]

  for (const stat of stats) {
    const statEl = document.createElement('div')
    statEl.className = 'trace-panel__stat'

    const labelEl = document.createElement('span')
    labelEl.className = 'trace-panel__stat-label'
    labelEl.textContent = stat.label

    const valueEl = document.createElement('span')
    valueEl.className = 'trace-panel__stat-value'
    valueEl.textContent = stat.value

    statEl.appendChild(labelEl)
    statEl.appendChild(valueEl)
    statsEl.appendChild(statEl)
  }

  content.appendChild(statsEl)

  // Tool calls list
  if (trace.toolCalls.length > 0) {
    const callsEl = document.createElement('div')
    callsEl.className = 'trace-panel__calls'

    for (const call of trace.toolCalls) {
      const callEl = document.createElement('div')
      callEl.className = 'trace-panel__call'

      const result = actionByCallId.get(call.id)
      if (result) {
        const bemClass = RESULT_BEM_CLASS[result.kind]
        if (bemClass) callEl.classList.add(`trace-panel__call${bemClass}`)
      }

      const nameSpan = document.createElement('span')
      nameSpan.className = 'trace-panel__call-name'
      nameSpan.textContent = call.tool.kind

      const paramsSpan = document.createElement('span')
      paramsSpan.className = 'trace-panel__call-params'
      paramsSpan.textContent = formatTool(call.tool)

      callEl.appendChild(nameSpan)
      callEl.appendChild(paramsSpan)

      if (result) {
        const resultSpan = document.createElement('span')
        resultSpan.className = 'trace-panel__call-result'

        let resultClass: string | undefined
        switch (result.kind) {
          case 'ok': resultClass = 'trace-panel__call-result--ok'; break
          case 'blocked': resultClass = 'trace-panel__call-result--error'; break
          case 'miss': resultClass = 'trace-panel__call-result--miss'; break
          case 'hit': resultClass = 'trace-panel__call-result--hit'; break
          case 'revealed': resultClass = 'trace-panel__call-result--revealed'; break
          case 'invalid': resultClass = 'trace-panel__call-result--error'; break
        }
        if (resultClass) resultSpan.classList.add(resultClass)

        resultSpan.textContent = formatResult(result)
        callEl.appendChild(resultSpan)
      }

      callsEl.appendChild(callEl)
    }

    content.appendChild(callsEl)
  }
}