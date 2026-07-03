#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runnerEntry = join(repoRoot, 'packages', 'runner', 'bin', 'runner-cli.js')

const HELP = `Run Scorched LLM matches

Usage:
  yarn match --config <match.json> --out <result.json> [--live] [--serve <port>]
  yarn match batch --roster <roster.json> --preset <duel|blitz|survival> --out <dir> [--seeds <n>] [--live] [--serve <port>]
  yarn match exhibition --preset <duel|blitz|survival> --out <dir>
  yarn match aggregate --out <dir>
  yarn match replay --dir <match-log-directory> [--serve <port>]

Arguments are forwarded to the runner CLI.
`

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

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP)
  process.exit(0)
}

if (args.length === 0) {
  console.error(HELP)
  process.exit(1)
}

run(process.execPath, [runnerEntry, ...args])
