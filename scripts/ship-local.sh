#!/usr/bin/env bash
# Personal pipeline, WSL side: validate the working tree and push the current
# branch to origin so the Windows clone can pull + rebuild the packaged app.
#
#   npm run ship:local            # or: bash scripts/ship-local.sh
#   bash scripts/ship-local.sh --skip-checks   # push only (emergency)
#
# Windows side afterwards (native PowerShell, not WSL):
#   powershell -ExecutionPolicy Bypass -File C:\dev\openwhispr\scripts\update-local-app.ps1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [[ "${1:-}" != "--skip-checks" ]]; then
  # Match CI's Node major (see .nvmrc); fall back to system node if nvm absent.
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    NODE_RUN=(nvm exec --silent 24)
  else
    NODE_RUN=()
  fi
  echo "[ship-local] tests..."
  "${NODE_RUN[@]}" npm test
  echo "[ship-local] lint..."
  "${NODE_RUN[@]}" npm run lint
  echo "[ship-local] typecheck..."
  "${NODE_RUN[@]}" npm run typecheck
  echo "[ship-local] i18n:check..."
  "${NODE_RUN[@]}" npm run i18n:check
else
  echo "[ship-local] WARNING: checks skipped (--skip-checks)"
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "[ship-local] detached HEAD — check out a branch first" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[ship-local] working tree not clean — commit or stash first:" >&2
  git status --short >&2
  exit 1
fi

echo "[ship-local] pushing $BRANCH to origin..."
git push origin "$BRANCH"

cat <<EOF

[ship-local] done. Now on native Windows (PowerShell):

  powershell -ExecutionPolicy Bypass -File C:\\dev\\openwhispr\\scripts\\update-local-app.ps1 -Branch $BRANCH

(Close OpenWhispr first, or let the script close it.)
EOF
