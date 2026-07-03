#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

roster="${1:-${ROSTER:-}}"
out_dir="${2:-${OUT_DIR:-exhibitions/survival-20}}"
port="${PORT:-3030}"

if [[ -z "$roster" ]]; then
  echo "Usage: $0 <roster.json> [output-directory]" >&2
  echo "Set PORT to override the spectator port (default: 3030)." >&2
  exit 1
fi

if [[ ! -f "$roster" ]]; then
  echo "Roster not found: $roster" >&2
  exit 1
fi

echo "Live spectator: http://localhost:${port}/"
echo "Results directory: ${out_dir}"
echo "Press Ctrl+C after the batch completes, then run:"
echo "  yarn match aggregate --out ${out_dir}"

yarn match batch \
  --roster "$roster" \
  --preset survival \
  --out "$out_dir" \
  --seeds 20 \
  --live \
  --serve "$port"
