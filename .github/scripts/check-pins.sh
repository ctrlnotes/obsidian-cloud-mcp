#!/usr/bin/env bash
# Fails unless every `uses:` in this repository's workflows and actions is pinned
# immutably: a 40-hex commit SHA, a Docker image by sha256 digest, or a local `./` path.
#
# The enforcing guard is the repository setting "Require actions to be pinned to a
# full-length commit SHA", which GitHub applies when a workflow runs and which a pull
# request cannot edit. This script is the early, readable signal: Dependabot rewrites
# these lines, and a failure here names the line.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

mapfile -t files < <(find .github -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)
[ "${#files[@]}" -gt 0 ] || { echo "::error::no workflow files found under .github"; exit 1; }

# `uses` as a key: after start, `{`, `,` or space; optionally quoted; optional space
# before the colon. Comment lines are dropped so prose mentioning `uses:` is not read.
key="(^|[{,[:space:]])[\"']?uses[\"']?[[:space:]]*:"
lines=$(grep -nHE "$key" "${files[@]}" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
[ -n "$lines" ] || { echo "::error::found no uses: lines; the check would pass vacuously"; exit 1; }

sha='[^@[:space:]]+@[0-9a-fA-F]{40}'
digest='docker://[^@[:space:]]+@sha256:[0-9a-f]{64}'
bad=""
while IFS= read -r line; do
  # Drop a trailing ` # comment` first, so a comment that itself says `uses:` is not
  # read as the value. A `#` with no space before it is part of the value, and fails.
  value=$(printf '%s\n' "$line" \
    | sed -E 's/[[:space:]]+#.*$//' \
    | sed -E "s/.*[\"']?uses[\"']?[[:space:]]*:[[:space:]]*[\"']?([^\"',}[:space:]]+).*/\\1/")
  if ! printf '%s\n' "$value" | grep -qE "^(\./.*|$sha|$digest)$"; then
    bad+="$line"$'\n'
  fi
done <<< "$lines"

if [ -n "$bad" ]; then
  printf '%s' "$bad"
  echo "::error::pin every action by a 40-hex commit sha (or a Docker image by digest)"
  exit 1
fi
echo "$(printf '%s\n' "$lines" | wc -l) uses: lines, all pinned"
