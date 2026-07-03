import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { MatchLog } from '@scorched-llm/engine'
import { serveStaticFile } from './live-server.js'

interface ReplayEntry {
  file: string
  matchId: string
  turns: number
  winner: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function readReplayEntries(directory: string): ReplayEntry[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      try {
        const log = JSON.parse(readFileSync(resolve(directory, file), 'utf8')) as MatchLog
        if (!log.metadata?.matchId || !Array.isArray(log.turns) || !log.result?.placements) {
          return []
        }
        const first = log.result.placements.find((placement) => placement.rank === 1)
        const tankIndex = first
          ? log.initialState.tanks.findIndex((tank) => tank.id === first.tankId)
          : -1
        const winner = first?.tieGroup
          ? 'Draw'
          : tankIndex >= 0
            ? log.config.players[tankIndex]?.label ?? first?.tankId ?? 'Unknown'
            : first?.tankId ?? 'Incomplete'
        return [{
          file,
          matchId: log.metadata.matchId,
          turns: log.turns.length,
          winner,
        }]
      } catch {
        return []
      }
    })
}

function renderIndex(entries: ReplayEntry[]): string {
  const rows = entries.map((entry) => {
    const encoded = encodeURIComponent(entry.file)
    return `<li><a href="/view/${encoded}">${escapeHtml(entry.file)}</a> — ` +
      `${escapeHtml(entry.winner)}, ${entry.turns} turns, match ${escapeHtml(entry.matchId)}</li>`
  }).join('\n')
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Scorched LLM Replays</title></head><body>' +
    '<h1>Scorched LLM Replays</h1>' +
    (rows ? `<ol>${rows}</ol>` : '<p>No match logs found.</p>') +
    '</body></html>'
}

export function startReplayServer(
  port: number,
  directory: string,
  staticDir: string,
): Server {
  const replayDir = resolve(directory)
  if (!existsSync(replayDir) || !statSync(replayDir).isDirectory()) {
    throw new Error(`Replay directory not found: ${replayDir}`)
  }

  const server = createServer((req, res) => {
    const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname

    if (requestPath === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(renderIndex(readReplayEntries(replayDir)))
      return
    }

    if (requestPath.startsWith('/replays/')) {
      const file = decodeURIComponent(requestPath.slice('/replays/'.length))
      if (file !== basename(file) || !file.endsWith('.json')) {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      const filePath = resolve(replayDir, file)
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(readFileSync(filePath))
      return
    }

    if (requestPath.startsWith('/view/')) {
      const file = decodeURIComponent(requestPath.slice('/view/'.length))
      if (file !== basename(file) || !file.endsWith('.json')) {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      const asset = serveStaticFile(
        '/',
        staticDir,
        `/replays/${encodeURIComponent(file)}`,
      )
      if (asset) {
        res.setHeader('Content-Type', asset.contentType)
        res.end(asset.body)
        return
      }
    }

    const asset = serveStaticFile(requestPath, staticDir)
    if (asset) {
      res.setHeader('Content-Type', asset.contentType)
      res.end(asset.body)
      return
    }

    res.statusCode = 404
    res.end('Not found')
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`Replay library: http://localhost:${port}/`)
  })
  return server
}
