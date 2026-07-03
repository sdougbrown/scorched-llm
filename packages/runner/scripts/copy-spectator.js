import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(packageRoot, '..', 'spectator', 'dist')
const destination = resolve(packageRoot, 'dist', 'public')

if (!existsSync(resolve(source, 'index.html'))) {
  throw new Error(`Spectator build not found at ${source}`)
}

rmSync(destination, { recursive: true, force: true })
mkdirSync(destination, { recursive: true })
cpSync(source, destination, { recursive: true })
