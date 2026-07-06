#!/usr/bin/env node
/**
 * Season-two pod bracket: 24 entrants → 6 survival pods of 4 → 6 winners +
 * 2 best runners-up → 2 semifinal pods → final pod of 4 → champion.
 *
 * Seeding comes from the season-one duel round-robin (win-loss differential,
 * read from exhibitions/season1-final/batch-manifest.json). Pods are filled
 * snake-style so top seeds are spread apart. Each pod runs the survival
 * preset across the 5-seed suite with seat rotation (5 matches per pod).
 *
 * Pod scoring: placement points per match (1st=4, 2nd=3, 3rd=2, 4th=1; ties
 * share their engine-assigned rank's points), damage dealt as tiebreak.
 *
 * Usage:
 *   node scripts/tournament-bracket.mjs --dry   # show seeding + pods only
 *   node scripts/tournament-bracket.mjs         # run (idempotent per stage:
 *                                               # pods with a manifest are skipped)
 *
 * Output: exhibitions/season2-bracket/{pods,semis,final}/... + bracket.json
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const OUT = resolve(ROOT, 'exhibitions/season2-bracket')
const SEASON1 = resolve(ROOT, 'exhibitions/season1-final/batch-manifest.json')
const DRY = process.argv.includes('--dry')

// ---------------------------------------------------------------------------
// Entrants. label → scripted kind. Two slots await season-two newcomers:
// replace `scripted: null` with a registered scripted name before running.
// ---------------------------------------------------------------------------
const ENTRANTS = [
  { label: 'Fable Fresh', scripted: 'fable-fresh' },
  { label: 'Opus 4.6', scripted: 'opus-4.6' },
  { label: 'Gemini', scripted: 'gemini' },
  { label: 'DeepSeek', scripted: 'deepseek' },
  { label: 'Nemotron', scripted: 'nemotron' },
  { label: 'Kimi', scripted: 'kimi' },
  { label: 'Sonnet 5', scripted: 'sonnet' },
  { label: 'GLM', scripted: 'glm' },
  { label: 'Minimax', scripted: 'minimax' },
  { label: 'Fable', scripted: 'fable' },
  { label: 'Qwen-27B', scripted: 'qwen-27b' },
  { label: 'GPT-OSS', scripted: 'gpt-oss' },
  { label: 'Step', scripted: 'step' },
  { label: 'MiMo', scripted: 'mimo' },
  { label: 'Sonnet 4.6', scripted: 'sonnet-4.6' },
  { label: 'Sonnet 5b', scripted: 'sonnet-5b' },
  { label: 'Haiku', scripted: 'haiku' },
  { label: 'DeepSeek Pro', scripted: 'deepseek-pro' },
  { label: 'GPT-5.4', scripted: 'gpt-5.4' },
  { label: 'Gemma', scripted: 'gemma' },
  { label: 'GPT-5.5', scripted: 'gpt-5.5' },
  { label: 'Opus 4.8', scripted: 'opus' },
  { label: 'TBD-1', scripted: null }, // ← season-two entrant, fill me in
  { label: 'TBD-2', scripted: null }, // ← season-two entrant, fill me in
]

// ---------------------------------------------------------------------------
// Seeding from season-one duel standings; unknown labels seed last, in order.
// ---------------------------------------------------------------------------
function seasonOneOrder() {
  if (!existsSync(SEASON1)) return []
  const manifest = JSON.parse(readFileSync(SEASON1, 'utf8'))
  const rec = {}
  for (const entry of manifest) {
    for (const p of entry.result.placements) {
      const s = (rec[p.label] ??= { w: 0, l: 0 })
      if (p.tieGroup) continue
      if (p.rank === 1) s.w++
      else s.l++
    }
  }
  return Object.entries(rec)
    .sort((a, b) => (b[1].w - b[1].l) - (a[1].w - a[1].l))
    .map(([label]) => label)
}

function seedEntrants() {
  const order = seasonOneOrder()
  const known = ENTRANTS.filter((e) => order.includes(e.label))
    .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))
  const newcomers = ENTRANTS.filter((e) => !order.includes(e.label))
  return [...known, ...newcomers]
}

/** Snake-fill `count` pods from a seeded list: 1..N, N..1, 1..N, ... */
function snakePods(seeded, count) {
  const pods = Array.from({ length: count }, () => [])
  seeded.forEach((entrant, i) => {
    const round = Math.floor(i / count)
    const pos = i % count
    const podIndex = round % 2 === 0 ? pos : count - 1 - pos
    pods[podIndex].push(entrant)
  })
  return pods
}

// ---------------------------------------------------------------------------
// Pod execution + scoring
// ---------------------------------------------------------------------------
function runPod(name, players, stageDir) {
  const dir = resolve(stageDir, name)
  const rosterPath = resolve(dir, 'roster.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(rosterPath, JSON.stringify({ players: players.map((p) => ({ label: p.label, scripted: p.scripted })) }, null, 2))
  if (!existsSync(resolve(dir, 'batch-manifest.json'))) {
    console.log(`  running ${name}: ${players.map((p) => p.label).join(' / ')}`)
    execSync(`yarn match batch --preset survival --roster ${rosterPath} --out ${dir}`, { cwd: ROOT, stdio: 'inherit' })
  } else {
    console.log(`  ${name}: manifest exists, skipping run`)
  }
  return scorePod(dir)
}

function scorePod(dir) {
  const manifest = JSON.parse(readFileSync(resolve(dir, 'batch-manifest.json'), 'utf8'))
  const table = {}
  for (const entry of manifest) {
    for (const p of entry.result.placements) {
      const s = (table[p.label] ??= { points: 0, wins: 0, dmg: 0 })
      s.points += Math.max(0, 5 - p.rank)
      if (p.rank === 1 && !p.tieGroup) s.wins++
      s.dmg += p.damageDealt
    }
  }
  return Object.entries(table)
    .map(([label, s]) => ({ label, ...s }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins || b.dmg - a.dmg)
}

function byLabel(label) {
  const e = ENTRANTS.find((x) => x.label === label)
  if (!e) throw new Error(`Unknown entrant label: ${label}`)
  return e
}

// ---------------------------------------------------------------------------
// Bracket
// ---------------------------------------------------------------------------
const seeded = seedEntrants()
if (seeded.length !== 24) {
  console.error(`Expected 24 entrants, found ${seeded.length}`)
  process.exit(1)
}

const groupPods = snakePods(seeded, 6)
console.log('SEEDING (season-one duel differential; newcomers last):')
seeded.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2)}. ${e.label}${e.scripted ? '' : '  ← PLACEHOLDER'}`))
console.log('\nGROUP PODS (snake-seeded):')
groupPods.forEach((pod, i) => console.log(`  Pod ${String.fromCharCode(65 + i)}: ${pod.map((p) => p.label).join(' / ')}`))

if (DRY) process.exit(0)

const unfilled = ENTRANTS.filter((e) => e.scripted === null)
if (unfilled.length > 0) {
  console.error(`\nCannot run: placeholder entrants not yet filled in: ${unfilled.map((e) => e.label).join(', ')}`)
  console.error('Edit ENTRANTS in scripts/tournament-bracket.mjs (label + registered scripted name).')
  process.exit(1)
}

// --- Group stage ---
console.log('\nGROUP STAGE:')
const podResults = groupPods.map((pod, i) =>
  runPod(`pod-${String.fromCharCode(65 + i)}`, pod, resolve(OUT, 'pods')))

const winners = podResults.map((r) => r[0])
const runnersUp = podResults.map((r) => r[1]).sort((a, b) => b.points - a.points || b.wins - a.wins || b.dmg - a.dmg)
const wildcards = runnersUp.slice(0, 2)
console.log('\nPod winners:', winners.map((w) => w.label).join(', '))
console.log('Wildcards (best runners-up):', wildcards.map((w) => w.label).join(', '))

// --- Semifinals: 8 tanks re-seeded by group-stage points, snake into 2 pods ---
const semiField = [...winners, ...wildcards]
  .sort((a, b) => b.points - a.points || b.wins - a.wins || b.dmg - a.dmg)
  .map((s) => byLabel(s.label))
console.log('\nSEMIFINALS:')
const semiPods = snakePods(semiField, 2)
const semiResults = semiPods.map((pod, i) =>
  runPod(`semi-${i + 1}`, pod, resolve(OUT, 'semis')))

// --- Final: top 2 from each semifinal ---
const finalField = semiResults.flatMap((r) => r.slice(0, 2)).map((s) => byLabel(s.label))
console.log('\nFINAL POD:', finalField.map((p) => p.label).join(' / '))
const finalResult = runPod('final', finalField, resolve(OUT, 'final'))

console.log('\n=== SEASON TWO PODIUM ===')
finalResult.forEach((s, i) =>
  console.log(`  ${i + 1}. ${s.label} — ${s.points} pts, ${s.wins} wins, ${s.dmg} dmg`))

writeFileSync(resolve(OUT, 'bracket.json'), JSON.stringify({
  seeding: seeded.map((e) => e.label),
  groupPods: groupPods.map((pod) => pod.map((p) => p.label)),
  groupResults: podResults,
  semifinals: semiPods.map((pod) => pod.map((p) => p.label)),
  semiResults,
  finalPod: finalField.map((p) => p.label),
  finalResult,
  champion: finalResult[0].label,
}, null, 2))
console.log(`\nBracket written to ${resolve(OUT, 'bracket.json')}`)
