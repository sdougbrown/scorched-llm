#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engineRoot = join(repoRoot, 'packages', 'engine')
const engineEntry = join(engineRoot, 'bin', 'engine-cli.js')
const distEntry = join(engineRoot, 'dist', 'cli', 'index.js')

const HELP = `Run Scorched LLM matches

Usage:
  yarn match --config <match.json> --out <result.json> [--live] [--serve <port>]
  yarn match batch --roster <roster.json> --preset <duel|blitz|survival> --out <dir> [--seeds <n>] [--live]
  yarn match exhibition --preset <duel|blitz|survival> --out <dir>
  yarn match aggregate --out <dir>

The engine is built automatically when compiled output is missing or stale.
All arguments after "yarn match" are forwarded to the engine CLI.
`

function latestMtime(path) {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs

  let latest = stat.mtimeMs
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    latest = Math.max(latest, latestMtime(join(path, entry.name)))
  }
  return latest
}

function engineNeedsBuild() {
  if (!existsSync(distEntry)) return true
  const builtAt = statSync(distEntry).mtimeMs
  return [
    join(engineRoot, 'src'),
    join(engineRoot, 'tsconfig.json'),
    join(engineRoot, 'package.json'),
  ].some((path) => latestMtime(path) > builtAt)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.signal) {
    console.error(`${command} terminated by signal ${result.signal}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function buildEngine() {
  console.log('Engine build is missing or stale; building @scorched-llm/engine...')
  const yarnPath = process.env.npm_execpath
  if (yarnPath) {
    run(process.execPath, [yarnPath, 'workspace', '@scorched-llm/engine', 'build'])
  } else {
    run('yarn', ['workspace', '@scorched-llm/engine', 'build'])
  }
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP)
  process.exit(0)
}

if (args.length === 0) {
  console.error(HELP)
  process.exit(1)
}

if (engineNeedsBuild()) buildEngine()
run(process.execPath, [engineEntry, ...args])
