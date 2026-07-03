import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import type { MatchLog } from '@scorched-llm/engine'

export interface LiveServerStatus {
  status: 'running' | 'complete'
  turns: number
  matchId: string
  currentMatch?: number
  totalMatches?: number
}

interface LiveServerOptions {
  port: number
  staticDir: string
  getLog: () => MatchLog | null
  getStatus: () => LiveServerStatus
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export function serveStaticFile(
  requestPath: string,
  staticDir: string,
  matchUrl: string = '/match.json',
): { body: Buffer | string; contentType: string } | null {
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1)
  const filePath = resolve(staticDir, relativePath)
  const root = resolve(staticDir)
  if (filePath !== root && !filePath.startsWith(`${root}/`)) return null
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null

  const extension = extname(filePath)
  let body: Buffer | string = readFileSync(filePath)
  if (extension === '.html') {
    body = body.toString('utf8').replace(
      '</head>',
      `<meta name="scorched-live-url" content="${matchUrl}" /></head>`,
    )
  }
  return {
    body,
    contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
  }
}

export function startLiveServer(options: LiveServerOptions): Server {
  const indexPath = resolve(options.staticDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error(`Bundled spectator UI not found at ${indexPath}`)
  }

  const server = createServer((req, res) => {
    const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname

    if (requestPath === '/match.json') {
      const log = options.getLog()
      if (!log) {
        res.statusCode = 404
        res.setHeader('Content-Type', CONTENT_TYPES['.json'])
        res.end(JSON.stringify({ error: 'waiting for match to start' }))
        return
      }
      res.setHeader('Content-Type', CONTENT_TYPES['.json'])
      res.end(JSON.stringify(log))
      return
    }

    if (requestPath === '/status.json') {
      res.setHeader('Content-Type', CONTENT_TYPES['.json'])
      res.end(JSON.stringify(options.getStatus()))
      return
    }

    const asset = serveStaticFile(requestPath, options.staticDir)
    if (asset) {
      res.setHeader('Content-Type', asset.contentType)
      res.end(asset.body)
      return
    }

    res.statusCode = 404
    res.end('Not found')
  })

  server.listen(options.port, '0.0.0.0', () => {
    console.log(`Live spectator: http://localhost:${options.port}/`)
  })
  return server
}
