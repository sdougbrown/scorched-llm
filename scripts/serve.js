#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'

const port = parseInt(process.argv[2] ?? '8080', 10)
const dir = resolve(process.argv[3] ?? '.')

const MIME = {
  '.json': 'application/json',
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const path = join(dir, decodeURIComponent(req.url ?? '/'))
  try {
    const s = await stat(path)
    if (s.isDirectory()) throw new Error('is directory')
    const data = await readFile(path)
    res.setHeader('Content-Type', MIME[extname(path)] ?? 'application/octet-stream')
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('Not found')
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Serving ${dir} on http://0.0.0.0:${port}`)
})