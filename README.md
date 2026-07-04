# scorched-llm

> An LLM tank duel benchmark. Models drive tanks through a fog-of-war arena via tool calls — not language. The benchmark tests **tool use under partial information**: spatial reasoning, memory across turns, strategic risk/reward, and error recovery.

Models win by being better at driving their tank, not by being better at language. A spectator web app replays match logs so humans can watch different models fight and judge which one is actually better at agency.

## How it works

```
┌─────────────┐    tool defs +     ┌──────────────┐    turn events    ┌──────────────┐
│  Engine     │◄───worldview──────►│  Tank Agents │                   │  Spectator   │
│  (TS, pure) │    tool calls back │  (per model) │                   │  (web app)   │
└─────────────┘                    └──────────────┘                   └──────────────┘
       │                                                                  ▲
       └────────────── turn log (JSON) ──────────────────────────────────┘
```

- **Engine** (`@scorched-llm/engine`) — pure TypeScript game state, rules, turn arbitration, tool dispatch. No model code, no rendering.
- **Tank agents** — each tank is a persistent agent with a linear message history across the entire match. Scripted bots (aggressive, conservative) are the benchmark floor. Model-backed agents query LLMs over HTTP.
- **Spectator** (`@scorched-llm/spectator`) — web app that loads a match JSON and replays it with Canvas arena, trace panels, and stats overlay.

On each turn, a tank agent receives the current worldview (its position, HP, local scan, flared cells, remaining actions), queries its model with the full message history, and returns tool calls. The engine executes them, emits structured events, and the spectator animates the result.

## Quick start

### Prerequisites

- Node 22+, Yarn 4 (Berry)
- API keys for any model players (set as environment variables)

### Install

```bash
git clone <repo-url> scorched-llm
cd scorched-llm
yarn install
yarn build
```

Use the root `yarn match` command for match operations. It checks whether the
engine build is missing or stale, builds it when necessary, then forwards all
flags to the engine CLI. Run `yarn match --help` for usage.

### Run a scripted exhibition (no API keys)

```bash
yarn match exhibition \
  --preset duel \
  --out ./exhibitions/duel-scripted
```

This runs Aggressive Bot vs Conservative Bot across 5 seeds with seat swaps. Output goes to `./exhibitions/duel-scripted/`:

- `match-001.json` ... `match-NNN.json` — full replay logs
- `batch-manifest.json` — schedule + per-match metadata
- `summary.json` — aggregated stats per player
- `exhibition-info.json` — complete version/settings record

Open any match log in the spectator to watch it:

```bash
yarn workspace @scorched-llm/spectator dev
```

Then drag-drop a `match-*.json` file onto the browser.

### Watch a match live (live spectate)

For model-backed matches that take minutes, watch the match as it runs without
starting a separate web server. `--serve` builds and hosts the spectator
alongside the live match data on one origin:

```bash
yarn match \
  --config my-match.local.json \
  --out result.json \
  --live \
  --serve 3030
```

Open the URL printed by the CLI:

```
http://localhost:3030/
```

The server binds to `0.0.0.0`, so replace `localhost` with the host's network
name or IP when viewing remotely. The UI and `/match.json` share an origin;
there is no Vite runtime, cross-origin URL, or CORS setup. `/status.json`
provides machine-readable run status.

The spectator polls every 1.5s, auto-advances as turns arrive, and shows a
**LIVE** badge. Batch runs continue across match boundaries and stop polling
only after the full batch completes.

### Browse a replay directory

Point the runner at any directory containing `match-*.json` logs:

```bash
yarn match replay --dir exhibitions/survival-20
```

Open `http://localhost:3030/` to choose a replay. Use `--serve <port>` to
override port `3030`. The runner ignores non-match JSON files such as
`summary.json` and serves each selected log through the bundled spectator.

### Run a model matchup

Complete single-match and batch templates are available in the
[`examples/`](examples/README.md) guide.

1. Copy an example roster and edit with your model configs:

```bash
cp examples/roster-duel.example.json roster-myorg.local.json
```

2. Edit `roster-myorg.local.json` — set `apiKeyEnv` to your env var name, adjust `baseURL` and `model`:

```json
{
  "players": [
    {
      "label": "GPT-5",
      "model": {
        "name": "gpt-5",
        "baseURL": "https://api.openai.com/v1",
        "apiKeyEnv": "OPENAI_API_KEY",
        "model": "gpt-5",
        "pricing": { "inputPerMillionUsd": 5, "outputPerMillionUsd": 15 }
      }
    },
    {
      "label": "Claude Sonnet 4.6",
      "model": {
        "name": "claude-sonnet-4-6",
      "baseURL": "https://api.anthropic.com",
        "apiKeyEnv": "ANTHROPIC_API_KEY",
        "model": "claude-sonnet-4-6"
      }
    }
  ]
}
```

3. Run the batch with `--live`:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

yarn match batch \
  --roster roster-myorg.local.json \
  --preset duel \
  --out ./exhibitions/duel-models \
  --live
```

4. Aggregate results:

```bash
yarn match aggregate \
  --out ./exhibitions/duel-models
```

> **Tip:** `*.local.json` is gitignored. Use the `.local.json` suffix for rosters with real provider URLs or private configs. The `examples/` files are tracked and use public dummy URLs.

## Configuration

### Roster format

A roster is a JSON file with a `players` array. Each player is either model-backed or scripted:

```json
{
  "players": [
    {
      "label": "GPT-5",
      "model": {
        "name": "gpt-5",
        "baseURL": "https://api.openai.com/v1",
        "apiKeyEnv": "OPENAI_API_KEY",
        "model": "gpt-5",
        "parameters": { "temperature": 0.7, "maxTokens": 4096 },
        "pricing": { "inputPerMillionUsd": 5, "outputPerMillionUsd": 15 }
      }
    },
    {
      "label": "Local Llama 4 70B",
      "model": {
        "name": "llama-4-70b-local",
        "baseURL": "http://localhost:11434/v1",
        "model": "llama4:70b"
      }
    },
    {
      "label": "Aggressive Bot",
      "scripted": "aggressive"
    }
  ]
}
```

#### Model spec fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Display label for the model |
| `baseURL` | yes | Provider base URL. The selected protocol appends its native endpoint path. |
| `protocol` | no | Explicit wire protocol: `openai-chat`, `openai-responses`, or `anthropic-messages`. If omitted, legacy URL-based routing remains in effect. |
| `apiKeyEnv` | no | Environment variable name to read the API key from (never a literal key) |
| `model` | yes | Model ID the endpoint expects (e.g. `gpt-5`, `llama4:70b`) |
| `headers` | no | Extra HTTP headers (e.g. for proxies) |
| `extraBody` | no | Provider-specific fields merged into the root request body |
| `parameters` | no | `temperature`, `seed`, `maxTokens` |
| `pricing` | no | `inputPerMillionUsd`, `outputPerMillionUsd` — omit for unknown cost |

#### Supported providers

Any OpenAI-compatible `/chat/completions` endpoint works with no extra config:

- **OpenAI** — `https://api.openai.com/v1`
- **Groq** — `https://api.groq.com/openai/v1`
- **OpenRouter** — `https://openrouter.ai/api/v1`
- **Ollama (local)** — `http://localhost:11434/v1`
- **vLLM / LM Studio / llama.cpp** — any OpenAI-compatible local server

**Anthropic** is auto-detected by URL and routed to a native translator (`/v1/messages` endpoint) instead of the OpenAI-compatible transport.

### Presets

| Preset | Players | Lethality | Actions/turn | Map | Turn limit | Use case |
|--------|---------|-----------|-------------|-----|------------|----------|
| `duel` | 2 | 2-hit kill | 2 (double) | 20×20 | 50 | Standard 1v1 benchmark |
| `blitz` | 2 | 1-hit kill | 1 (single) | 15×15 | 30 | Fast exhibitions, weak-model friendly |
| `survival` | 4 | 2-hit kill | 2 (double) | 25×25 | 80 | FFA chaos, tests multi-target reasoning |

### Custom single match

For full control, write a complete `MatchConfig` JSON and run a single match:

```bash
yarn match \
  --config my-match.local.json \
  --out match.json \
  --live
```

See `packages/engine/src/config/schema.ts` for the full schema.
Copy [`examples/match-duel.example.json`](examples/match-duel.example.json) or
[`examples/match-survival.example.json`](examples/match-survival.example.json)
for a complete starting point.

## Batch runner

The batch runner round-robins a roster over a committed seed suite with paired seat/start/first-turn swaps:

- **1v1 presets (duel, blitz):** every unordered pair × each seed × both seat orderings (swaps counter first-turn and start-position advantage)
- **Survival:** every 4-player combination × each seed (seating rotates across seeds)

```bash
yarn match batch \
  --roster <roster.json> \
  --preset <duel|blitz|survival> \
  --out <output-dir> \
  [--seeds <count>] \
  [--shell-max-range <count>] \
  [--live] \
  [--serve <port>]
```

- `--seeds <count>` — use the first N seeds from the 20-seed committed suite (default 5)
- `--shell-max-range <count>` — override the preset's maximum legal shell power
- `--live` — use real model agents. Without it, model players use always-pass (deterministic dry-run, no API calls)
- `--serve <port>` — continuously serve the active match at `/match.json`.
  The spectator follows match boundaries and stops only when the full batch is
  complete.

To start a 20-match live survival batch for any four-model roster:

```bash
./scripts/run-survival-eval.sh --roster roster-survival.local.json
```

The script writes to `exhibitions/survival-20` and serves the live feed on port
`3030`. Use `--out`, `--shell-max-range`, or `--port` to override those values.

### Match count

| Preset | Roster size | Seeds | Matches |
|--------|------------|-------|---------|
| duel/blitz | 3 | 5 | C(3,2) × 5 × 2 = **30** |
| duel/blitz | 6 | 5 | C(6,2) × 5 × 2 = **150** |
| duel/blitz | 8 | 5 | C(8,2) × 5 × 2 = **280** |
| survival | 4 | 20 | C(4,4) × 20 = **20** |
| survival | 6 | 5 | C(6,4) × 5 = **75** |
| survival | 8 | 5 | C(8,4) × 5 = **350** |

The schedule is deterministic — same roster + preset + seeds always produces the same match order.

## Aggregation

After a batch run, aggregate the results:

```bash
yarn match aggregate --out <output-dir>
```

Produces `summary.json` with per-player stats:

| Metric | Description |
|--------|-------------|
| `meanPlacement` | Mean finishing rank; lower is better |
| `winRate` | Wins / matches (rank 1 in non-draw) |
| `placementDistribution` | Count of each rank |
| `avgDamagePerMatch` / `avgHitsPerMatch` | Combat output normalized by completed matches |
| `shellHitRate` | Shell hits / shell attempts, including invalid or blocked attempts |
| `toolCallSuccessRate` | Calls accepted by the engine (not blocked or invalid) / total calls |
| `invalidCallRate` | Invalid calls / total calls |
| `avgSurvivalTurns` | Mean global turn of destruction, or match-ending turn for survivors |
| `totalTokensIn` / `totalTokensOut` | From model traces (0 for scripted) |
| `damagePer1kOutputTokens` | Damage efficiency; `null` when no output tokens were recorded |
| `totalKnownCostUsd` | Sum of cost where pricing configured |
| `winsPerKnownDollar` | Cost efficiency; `null` when no known non-zero cost was recorded |
| `avgLatencyMs` / `medianLatencyMs` | Model response latency |
| `failureExposureRate` | Failed scheduled matches containing the player; exposure, not fault attribution |

The summary also includes:

- `leaderboard` — competitors sorted by mean placement, win rate, damage per
  match, shell hit rate, then invalid-call rate.
- `overallWinner` — the sole rank-one label, or `null` for an exact competitive
  tie.
- `terminationDistribution` and batch-wide failure counts/rate.
- `reconciliation` — assertions that match, damage, and hit totals agree with
  the raw logs. Aggregation fails loudly if they drift.

The leaderboard is lexically ordered only to keep exact ties stable in JSON;
model names never break a competitive tie. Raw totals remain available in
`perPlayer`, and efficiency metrics do not affect competitive rank.

## Spectator

```bash
yarn workspace @scorched-llm/spectator dev
```

Open the browser, drag-drop any `match-*.json` file. Features:

- **Canvas arena** — terrain, tanks, flares (with owner/expiry), shell trajectories, fog visualization
- **Timeline** — play/pause/step/restart, scrubber, speed control
- **Trace panels** — per-tank: assistant text, tool calls, results, token/cost/latency
- **Stats overlay** — per-tank: actions, flares, shells, hits, misses, invalid calls, tokens, cost, latency
- **Keyboard** — spacebar play/pause, arrows step

The spectator is omniscient — it shows all terrain and tank positions. Fog-of-war regions are visually muted, not hidden. Local-vision and active-flare areas are highlighted.

## Project structure

```
scorched-llm/
├── packages/
│   ├── engine/              # Pure headless engine, batch runner, presets
│   │   ├── src/
│   │   │   ├── config/      # MatchConfig schema, presets, seed suite
│   │   │   ├── cli/         # CLI, batch runner, exhibition, aggregation
│   │   │   ├── match/       # Orchestration, scripted agents, fake agents
│   │   │   ├── model/       # HTTP transport, Anthropic translator, tank agent
│   │   │   ├── resolution/  # Movement, flare, shell, damage
│   │   │   ├── rules/       # Umpire turn-action validation
│   │   │   ├── terrain/     # Seeded terrain generation
│   │   │   └── types/       # Shared contracts (state, events, log, tools)
│   │   ├── RENDERER_CONTRACT.md    # 3D-ready replay contract docs
│   │   └── BENCHMARK_METHODOLOGY.md
│   ├── adapters/            # Thin adapter stub
│   ├── spectator/           # Vite web app, Canvas arena, DOM controls
│   └── runner/              # Public CLI, bundled spectator, live/replay server
├── examples/
│   ├── roster-duel.example.json     # 5-player duel roster (dummy URLs)
│   └── roster-survival.example.json # 7-player survival roster
└── turbo.json               # Monorepo build pipeline
```

## Development

```bash
yarn install              # install deps
yarn build                # build all packages (project references)
yarn test                 # run all tests (vitest via turbo)
yarn lint                 # eslint
yarn typecheck            # tsc --noEmit
```

All four gates run in CI. The engine has 376+ tests; the spectator has 98.

## What this is not

- Not a human-playable game. No keyboard controls for tanks.
- Not a general LLM benchmark. It tests tool use + spatial reasoning + strategic memory in one narrow frame.
- Not a way to rank models overall. It's an observable probe of one slice of capability.

## License

MIT
