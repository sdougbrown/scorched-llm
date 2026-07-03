import { fileURLToPath } from 'node:url'
import type { MatchLog } from '@scorched-llm/engine'
import { runCli, type CliRunProgress } from '@scorched-llm/engine/cli'
import { startLiveServer } from './live-server.js'
import { startReplayServer } from './replay-server.js'

function parseServePort(argv: string[]): number | undefined {
  const index = argv.indexOf('--serve')
  if (index < 0) return undefined
  const value = argv[index + 1]
  const port = Number(value)
  if (!value || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--serve requires a port between 1 and 65535')
  }
  return port
}

function withoutServe(argv: string[]): string[] {
  const index = argv.indexOf('--serve')
  if (index < 0) return argv
  return [...argv.slice(0, index), ...argv.slice(index + 2)]
}

function bundledPublicDir(): string {
  return fileURLToPath(new URL('./public/', import.meta.url))
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

export async function runRunnerCli(argv: string[]): Promise<void> {
  if (argv[0] === 'replay') {
    const directory = readFlag(argv, '--dir')
    if (!directory) throw new Error('replay requires --dir <match-log-directory>')
    const port = parseServePort(argv) ?? 3030
    const server = startReplayServer(port, directory, bundledPublicDir())
    process.on('SIGINT', () => server.close(() => process.exit(0)))
    return
  }

  const servePort = parseServePort(argv)
  if (!servePort) {
    await runCli(argv)
    return
  }

  const logRef: { current: MatchLog | null } = { current: null }
  let progress: CliRunProgress = { currentMatch: 0, totalMatches: 1 }
  let status: 'running' | 'complete' = 'running'

  const server = startLiveServer({
    port: servePort,
    staticDir: bundledPublicDir(),
    getLog: () => logRef.current,
    getStatus: () => ({
      status,
      currentMatch: progress.currentMatch,
      totalMatches: progress.totalMatches,
      turns: logRef.current?.turns.length ?? 0,
      matchId: logRef.current?.metadata.matchId ?? '',
    }),
  })

  process.on('SIGINT', () => {
    server.close(() => process.exit(0))
  })

  await runCli(withoutServe(argv), {
    onLiveLog(log, nextProgress) {
      progress = nextProgress
      logRef.current = structuredClone(log)
      logRef.current.liveBatchState = {
        ...nextProgress,
        status: 'running',
      }
    },
  })

  status = 'complete'
  if (logRef.current?.liveBatchState) {
    logRef.current.liveBatchState.status = 'complete'
  }
}

export { startLiveServer } from './live-server.js'
export { startReplayServer } from './replay-server.js'
