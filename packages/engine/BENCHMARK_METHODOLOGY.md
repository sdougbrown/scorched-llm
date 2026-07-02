# Benchmark Methodology

This document describes how to run the Scorched-LLM benchmark and interpret results.

## Scripted Exhibition (No API Keys)

The fastest way to validate the engine and produce benchmark artifacts is a scripted exhibition, which uses deterministic scripted agents and requires no API keys.

```bash
npx engine-cli exhibition --preset duel --out ./exhibition-results
```

This runs the default scripted roster (Aggressive Bot vs Conservative Bot) against the full seed suite (5 seeds: 42, 7, 99, 123, 256). For duel, this produces 4 matches (2 seed-swap pairs × 2 seeds).

### Presets

| Preset | Players | Map | Actions/Turn | Turn Limit | Lethality |
|--------|---------|-----|-------------|------------|-----------|
| duel | 2 | 20×20, 10% obstacles | 2 | 50 | 2 hits to kill |
| blitz | 2 | 15×15, 10% obstacles | 1 | 30 | 1 hit to kill |
| survival | 4 | 25×25, 12% obstacles | 2 | 80 | 2 hits to kill |

**When to use each:**

- **Duel**: Standard comparison. Good for head-to-head model evaluation. Full 20×20 map with generous turn limit allows for tactical play.
- **Blitz**: Fast, lethal engagements. Useful for evaluating model speed (fewer turns = fewer API calls). The 15×15 map with one-hit kills produces shorter matches.
- **Survival**: Multi-player free-for-all. Useful for evaluating strategic behavior with more than 2 players. Produces more matches per run (combinatorial roster).

### Seed Suite

The engine uses a fixed seed suite of 5 seeds: `[42, 7, 99, 123, 256]`. Each seed produces a different terrain layout and tank starting positions.

**Why paired seat swaps matter**: In duel and blitz, every match is run twice — once with player A in seat 0 (first turn) and player B in seat 1, and once with the seats swapped. This controls for first-turn advantage: the player who acts first in a turn gets an action before their opponent, which can be significant on a small map with limited mobility.

### Running with a Subset of Seeds

```bash
npx engine-cli exhibition --preset duel --out ./results --seeds 2
```

This runs only the first 2 seeds (42 and 7), producing 4 matches instead of 10.

### Running with Model-Backed Agents (Live)

The exhibition tool is scripted-only by design. To run with model-backed agents, use the batch runner with a roster file:

```bash
# Create a roster file
echo '{"players": [
  {"label": "GPT", "model": {"name": "gpt-4o", "baseURL": "...", "apiKeyEnv": "ANTHROPIC_API_KEY", "model": "gpt-4o"}},
  {"label": "Claude", "model": {"name": "claude-3", "baseURL": "...", "apiKeyEnv": "ANTHROPIC_API_KEY", "model": "claude-3-opus"}}
]}' > roster.json

# Run with live models
npx engine-cli batch --roster roster.json --preset duel --out ./live-results --live
```

The `--live` flag tells the batch runner to create `ModelBackedTankAgent` instances that call the actual model API. Without `--live`, model-configured players use `alwaysPassAgent` (which always passes).

## Interpreting Results

### summary.json

The aggregation step produces `summary.json` with per-player statistics:

```json
{
  "preset": "duel",
  "seedCount": 2,
  "matchesTotal": 4,
  "perPlayer": {
    "Aggressive Bot": {
      "matchCount": 4,
      "winCount": 3,
      "winRate": 0.75,
      "placementDistribution": { 1: 3, 2: 1 },
      "totalDamageDealt": 42,
      "totalHitsLanded": 15,
      "totalInvalidCalls": 0,
      "totalTokensIn": 12000,
      "totalTokensOut": 3000,
      "totalKnownCostUsd": 0.15,
      "unknownCostMatchCount": 0,
      "avgLatencyMs": 250,
      "medianLatencyMs": 240
    }
  },
  "reconciliation": {
    "matchCountSum": 8,
    "totalMatchesTimesPlayers": 8,
    "matchCountMatches": true,
    "damageSum": 84,
    "placementDamageSum": 84,
    "damageMatches": true,
    "hitsSum": 30,
    "placementHitsSum": 30,
    "hitsMatches": true
  }
}
```

**Key metrics:**

| Metric | Description |
|--------|-------------|
| `winRate` | Proportion of matches won (rank 1, no tie). Primary comparison metric. |
| `placementDistribution` | Count of each rank achieved. Shows consistency beyond just wins. |
| `totalDamageDealt` | Total damage across all matches. Indicates aggression and accuracy. |
| `totalHitsLanded` | Total hits across all matches. Raw hit count. |
| `totalInvalidCalls` | Model protocol errors. High values indicate the model doesn't understand the tool schema. |
| `totalTokensIn/Out` | Token consumption for LLM models. |
| `totalKnownCostUsd` | Monetary cost (USD) for LLM models. |
| `avgLatencyMs` / `medianLatencyMs` | Average and median API response latency. |
| `reconciliation` | Cross-checks that per-player stats sum correctly against placement data. All booleans must be `true`. |

### Why Raw Metrics, Not a Composite Score

The benchmark preserves raw metrics rather than computing a composite score because:

1. **Different evaluation contexts**: Win rate matters most in duel, but placement distribution is more informative in survival (4-player).
2. **Cost-benefit tradeoffs**: A model with slightly lower win rate but much lower token cost may be preferable.
3. **Error analysis**: Invalid call rates reveal model capability issues (schema misunderstanding) that win rate obscures.
4. **Lateness sensitivity**: For real-time applications, latency matters independently of tactical performance.
5. **No agreed weighting**: Different stakeholders prioritize different metrics.

### Per-Match Logs

Each match produces a `match-NNN.json` file containing the full `MatchLog`:

```json
{
  "schemaVersion": "v1",
  "metadata": {
    "matchId": "1",
    "createdAt": "2024-01-15T10:30:00Z",
    "promptVersion": "v1",
    "adapterVersions": {}
  },
  "config": { ... },
  "initialState": { ... },
  "turns": [ ... ],
  "result": { ... }
}
```

The full match log enables deep post-match analysis: turn-by-turn action review, model trace inspection (tool calls, reasoning text), and replay reconstruction.

### batch-manifest.json

The manifest is a summary of all matches, including failures:

```json
[
  {
    "matchId": 1,
    "preset": "duel",
    "seed": 42,
    "seatAssignment": { "0": "Aggressive Bot", "1": "Conservative Bot" },
    "firstTurnSeat": 0,
    "result": {
      "terminationReason": "last-standing",
      "placements": [ ... ]
    }
  },
  {
    "matchId": 2,
    "preset": "duel",
    "seed": 42,
    "seatAssignment": { "0": "Conservative Bot", "1": "Aggressive Bot" },
    "firstTurnSeat": 0,
    "result": { ... },
    "failure": "Model API timeout"
  }
]
```

Failed matches have a `failure` field and empty placements. They are excluded from aggregation but preserved for debugging.

## Reproducibility

The benchmark is reproducible: the same config + seeds produce the same match schedule and (for scripted agents) the same results.

**Determinism guarantees:**

1. **RNG**: The engine uses a seeded Mulberry32 PRNG. Same seed → same terrain, same tank positions, same shell trajectories.
2. **Scripted agents**: Deterministic behavior based on world state. Same state → same actions.
3. **Turn order**: Players always take turns in roster order (seat 0, seat 1, ...).
4. **Supercover line algorithm**: Deterministic cell traversal for shell trajectories.

**To reproduce:**

1. Use the same preset (determines map size, turn limit, fog, shell parameters).
2. Use the same seeds (determines terrain and starting positions).
3. Use the same roster (determines agent types and turn order).

## Exhibition Artifacts

The exhibition generator produces:

| File | Content |
|------|---------|
| `match-NNN.json` | Full MatchLog for each match |
| `batch-manifest.json` | Summary of all matches with results and failures |
| `summary.json` | Aggregated per-player statistics with reconciliation checks |
| `exhibition-info.json` | Version metadata, roster, seed information |

The `exhibition-info.json` file documents all versions and settings used, enabling traceability:

```json
{
  "type": "scripted",
  "preset": "duel",
  "rulesVersion": "v1",
  "generatorVersion": "v1",
  "promptVersion": "v1",
  "engineVersion": "0.0.0",
  "timestamp": "2024-01-15T10:30:00Z",
  "seedSuite": [42, 7, 99, 123, 256],
  "seedsUsed": [42, 7],
  "roster": [
    { "label": "Aggressive Bot", "scripted": "aggressive" },
    { "label": "Conservative Bot", "scripted": "conservative" }
  ],
  "totalMatches": 4,
  "completedMatches": 4,
  "adapterVersions": {}
}
```

The `type: "scripted"` field indicates no model API calls were made.
