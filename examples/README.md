# Match examples

These files are safe templates: they contain model IDs and environment-variable
names, never literal API keys. Copy a template to a `*.local.json` file before
editing it. Local config files are ignored by Git.

## Run a live duel

```bash
cp examples/match-duel.example.json match-my-duel.local.json
export OPENAI_API_KEY=your-key

yarn match \
  --config match-my-duel.local.json \
  --out exhibitions/my-duel/match-001.json \
  --live \
  --serve 3030
```

Edit both model blocks before running. The second block expects an
OpenAI-compatible local server on `http://localhost:8080/v1`.

Open the single-origin spectator URL printed by the runner:

```text
http://localhost:3030/
```

## Run four-model survival

```bash
cp examples/match-survival.example.json match-my-survival.local.json
export OPENAI_API_KEY=your-key
export ANTHROPIC_API_KEY=your-key

yarn match \
  --config match-my-survival.local.json \
  --out exhibitions/my-survival/match-001.json \
  --live \
  --serve 3030
```

The survival example uses symmetric corner-biased spawning. If an anchor is
blocked by terrain, the engine chooses the nearest open cell.

The local reasoning model demonstrates provider-specific request fields:

```json
{
  "extraBody": {
    "chat_template_kwargs": {
      "enable_thinking": true
    }
  }
}
```

`extraBody` fields are added to the root OpenAI-compatible request. Whether a
field has an effect depends on the model server and its chat template.

## Run a batch evaluation

Roster files describe a pool of competitors. Presets generate individual
matches, seeds, and seat assignments.

```bash
cp examples/roster-duel.example.json roster-my-models.local.json

yarn match batch \
  --roster roster-my-models.local.json \
  --preset duel \
  --seeds 2 \
  --out exhibitions/my-batch \
  --live \
  --serve 3030

yarn match aggregate --out exhibitions/my-batch
```

Use `roster-survival.example.json` with `--preset survival` for four-player
combinations. While the batch runs, open `http://localhost:3030/`; the bundled
spectator follows each match automatically.

Afterward, browse the saved matches without rerunning the evaluation:

```bash
yarn match replay --dir exhibitions/my-batch
```

## Test configuration without calling models

Omit `--live` to validate a complete match config and exercise deterministic
match generation without making API requests:

```bash
yarn match \
  --config match-my-duel.local.json \
  --out exhibitions/dry-run.json
```

Model-backed players use pass-only agents in this mode.

## Important model settings

| Field | Purpose |
|---|---|
| `baseURL` | Provider base URL. The selected transport appends its native endpoint path. |
| `protocol` | Optional explicit transport: `openai-chat`, `openai-responses`, or `anthropic-messages`. |
| `apiKeyEnv` | Environment variable containing the key. Never put a literal key in the config. |
| `model` | Model identifier expected by the endpoint. |
| `parameters.maxTokens` | Per-response output limit. `2048` is a practical starting point for local reasoning models. |
| `extraBody` | Provider-specific root request fields, including reasoning controls. |
| `perTurnTimeoutMs` | Timeout for each model request, not for the complete match. |
| `maxToolCallsPerTurn` | Protocol/recovery budget; game actions remain limited separately by `actionEconomy`. |
| `spawnStrategy` | Use `symmetric` for four-player survival or omit it for random open-cell spawning. |

Run `yarn match --help` for supported commands and flags.
