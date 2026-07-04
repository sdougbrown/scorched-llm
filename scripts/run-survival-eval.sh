#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

roster="${ROSTER:-}"
out_dir="${OUT_DIR:-exhibitions/survival-20}"
shell_max_range="${SHELL_MAX_RANGE:-12}"
port="${PORT:-3030}"

usage() {
  echo "Usage: $0 --roster <roster.json> [--out <directory>] [--shell-max-range <power>] [--port <port>]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --roster)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      roster="$2"
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      out_dir="$2"
      shift 2
      ;;
    --shell-max-range)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      shell_max_range="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      port="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$roster" ]]; then
  usage
  exit 1
fi

if [[ ! -f "$roster" ]]; then
  echo "Roster not found: $roster" >&2
  exit 1
fi

echo "Live spectator: http://localhost:${port}/"
echo "Results directory: ${out_dir}"
echo "Maximum shell power: ${shell_max_range}"
echo "Press Ctrl+C after the batch completes, then run:"
echo "  yarn match aggregate --out ${out_dir}"

yarn match batch \
  --roster "$roster" \
  --preset survival \
  --out "$out_dir" \
  --seeds 20 \
  --shell-max-range "$shell_max_range" \
  --live \
  --serve "$port"
