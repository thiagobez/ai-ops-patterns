#!/usr/bin/env bash
# Fails if anything that looks like a secret, a private address or a real
# identifier shows up in the tree. Runs in CI (`npm run lint`) and is meant to
# be run before every commit. Extend the pattern list, never shorten it.
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN='sk-an[t]-|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key *[:=] *['"'"'"][A-Za-z0-9]|100\.115\.|192\.168\.|10\.0\.0\.|supabase\.co|t\.me/|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}'

if grep -rniE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  --exclude=check-secrets.sh "$PATTERN" . ; then
  echo "check-secrets: suspicious content found (see above)" >&2
  exit 1
fi
echo "check-secrets: clean"
