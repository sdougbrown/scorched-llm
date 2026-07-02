import type { MatchLog } from '@scorched-llm/engine'
import { loadMatchLogFromFile } from './log-loader.js'

const css = `
.match-loader {
  font-family: 'Segoe UI', system-ui, sans-serif;
  color: #e0e0e0;
  background-color: #1a1a2e;
  padding: 24px;
  border-radius: 8px;
}

.match-loader__drop-zone {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  padding: 24px;
  border: 2px dashed #3d3d5c;
  border-radius: 6px;
  background-color: #16213e;
  cursor: pointer;
  transition: border-color 0.2s ease, background-color 0.2s ease;
  user-select: none;
  text-align: center;
}

.match-loader__drop-zone:hover,
.match-loader__drop-zone.drag-over {
  border-color: #4a90d9;
  background-color: #1c2a4a;
}

.match-loader__input {
  display: none;
}

.match-loader__loading {
  margin-top: 12px;
  text-align: center;
  color: #4a90d9;
  font-size: 14px;
}

.match-loader__error {
  margin-top: 12px;
  text-align: center;
  color: #e74c3c;
  font-size: 14px;
}
`

let stylesheetInserted = false

function ensureStylesheet(): void {
  if (stylesheetInserted) return
  const styleEl = document.createElement('style')
  styleEl.textContent = css
  document.head.appendChild(styleEl)
  stylesheetInserted = true
}

export function createMatchLoader(onLoad: (log: MatchLog) => void): HTMLElement {
  ensureStylesheet()

  const container = document.createElement('div')
  container.className = 'match-loader'

  const dropZone = document.createElement('div')
  dropZone.className = 'match-loader__drop-zone'
  dropZone.textContent = 'Drop match log JSON here or click to browse'

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = '.json'
  fileInput.className = 'match-loader__input'
  fileInput.hidden = true

  const loadingEl = document.createElement('div')
  loadingEl.className = 'match-loader__loading'
  loadingEl.setAttribute('hidden', '')
  loadingEl.textContent = 'Loading...'

  const errorEl = document.createElement('div')
  errorEl.className = 'match-loader__error'
  errorEl.setAttribute('hidden', '')

  const errorMessageSpan = document.createElement('span')
  errorMessageSpan.className = 'match-loader__error-message'
  errorEl.textContent = 'Error: '
  errorEl.appendChild(errorMessageSpan)

  container.appendChild(dropZone)
  container.appendChild(fileInput)
  container.appendChild(loadingEl)
  container.appendChild(errorEl)

  let _isDragOver = false

  function clearStates(): void {
    loadingEl.setAttribute('hidden', '')
    errorEl.setAttribute('hidden', '')
  }

  function showError(message: string): void {
    errorMessageSpan.textContent = message
    errorEl.removeAttribute('hidden')
    loadingEl.setAttribute('hidden', '')
  }

  async function handleFile(file: File): Promise<void> {
    if (file.type !== '' && !file.name.toLowerCase().endsWith('.json')) {
      showError('Please select a .json file')
      return
    }

    clearStates()
    loadingEl.removeAttribute('hidden')

    try {
      const log = await loadMatchLogFromFile(file)
      onLoad(log)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showError(message)
    } finally {
      loadingEl.setAttribute('hidden', '')
    }
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    _isDragOver = true
    dropZone.classList.add('drag-over')
  }

  function onDragLeave(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    _isDragOver = false
    dropZone.classList.remove('drag-over')
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    _isDragOver = false
    dropZone.classList.remove('drag-over')

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    handleFile(files[0])
  }

  function onButtonClick(): void {
    fileInput.click()
  }

  function onChange(): void {
    const files = fileInput.files
    if (!files || files.length === 0) return

    handleFile(files[0])
    fileInput.value = ''
  }

  dropZone.addEventListener('dragover', onDragOver)
  dropZone.addEventListener('dragleave', onDragLeave)
  dropZone.addEventListener('drop', onDrop)
  dropZone.addEventListener('click', onButtonClick)
  fileInput.addEventListener('change', onChange)

  return container
}