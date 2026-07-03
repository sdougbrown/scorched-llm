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

In another terminal, start the spectator:

```bash
yarn workspace @scorched-llm/spectator exec vite --host 0.0.0.0
```

Then open:

```text
http://localhost:5173/#url=http://localhost:3030/match.json
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
  --live

yarn match aggregate --out exhibitions/my-batch
```

Use `roster-survival.example.json` with `--preset survival` for four-player
combinations.

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
| `baseURL` | Provider base URL. OpenAI-compatible transports append `/chat/completions`. |
| `apiKeyEnv` | Environment variable containing the key. Never put a literal key in the config. |
| `model` | Model identifier expected by the endpoint. |
| `parameters.maxTokens` | Per-response output limit. `2048` is a practical starting point for local reasoning models. |
| `extraBody` | Provider-specific root request fields, such as llama.cpp chat-template arguments. |
| `perTurnTimeoutMs` | Timeout for each model request, not for the complete match. |
| `maxToolCallsPerTurn` | Protocol/recovery budget; game actions remain limited separately by `actionEconomy`. |
| `spawnStrategy` | Use `symmetric` for four-player survival or omit it for random open-cell spawning. |

Run `yarn match --help` for supported commands and flags.
