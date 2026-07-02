import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseMatchConfig } from '../config/schema.js'
import { alwaysPassAgent } from '../match/fake-agents.js'
import { runMatch } from '../match/orchestration.js'

export async function runCli(argv: string[]): Promise<void> {
  let configPath: string | undefined
  let outPath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      configPath = resolve(argv[++i])
    } else if (argv[i] === '--out' && argv[i + 1]) {
      outPath = resolve(argv[++i])
    }
  }

  if (!configPath) {
    console.error('Error: --config is required')
    process.exit(1)
  }
  if (!outPath) {
    console.error('Error: --out is required')
    process.exit(1)
  }

  const raw = readFileSync(configPath, 'utf-8')
  const config = parseMatchConfig(JSON.parse(raw))

  const agents = config.players.map((p) => alwaysPassAgent(p.label))

  const { log, result } = await runMatch(config, agents)

  writeFileSync(outPath, JSON.stringify(log, null, 2))

  console.log(`Match complete: ${result.terminationReason}`)
  console.log(`Turns: ${log.turns.length}`)
  for (const placement of result.placements) {
    console.log(`  ${placement.rank}. ${placement.tankId} (HP: ${placement.hp}, DMG: ${placement.damageDealt})`)
  }
}