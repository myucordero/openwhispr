# Local Personal Setup (v1.5.5+)

This runbook is the current replacement for the old `v1.5.1` upgrade guide.

It is optimized for your local-first workflow and the dual-clone model:

- WSL clone for coding, analysis, tests, and Git
- Windows clone for Electron runtime and Windows packaging
- Sync only through Git

## Target Outcome

After this setup, you will have:

- Upstream-synced source on `main` with your personal local commits preserved
- Reproducible installs (`npm ci`) across both clones
- Local transcription/reasoning defaults that favor privacy and performance
- Reliable Windows runtime/build validation

## Current Baseline

- App line: `v1.5.5+`
- Node: `22.x` (`.nvmrc`)
- Personal/local build command: `npm run build:local:win`
- Optional GPU bootstrap: `LOCAL_AUTO_ENABLE_GPU=1`

## Phase 1: Protect Current State

From your active clone:

```bash
git status
git checkout main
git branch backup/main-pre-local-setup-$(date +%Y%m%d)
```

If you have uncommitted local work, commit it first.

## Phase 2: Sync Safely With Upstream

Use rebase, not reset:

```bash
git fetch upstream --prune
git rebase upstream/main
```

If conflicts happen:

```bash
# resolve files
git add -A
git rebase --continue
```

Push your rebased `main` to your fork:

```bash
git push --force-with-lease origin main
```

## Phase 3: Configure Local-First Runtime

In your Windows runtime clone (`C:\dev\openwhispr`), create/update `.env`:

```env
VITE_DEV_SERVER_PORT=5191
OPENWHISPR_DEV_SERVER_PORT=5191
UI_LANGUAGE=en
LOCAL_AUTO_ENABLE_GPU=1

# Keep cloud keys commented unless intentionally used
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GEMINI_API_KEY=
# GROQ_API_KEY=
# MISTRAL_API_KEY=

# Optional overrides only if needed after testing:
# LOCAL_LLM_THREADS=12
# PARAKEET_THREADS=8
# LOCAL_LLM_GPU_LAYERS=32
```

Notes:

- Leave thread and layer overrides unset first; built-in balancing is already tuned.
- Use `LOCAL_LLM_GPU_LAYERS=32` only if you observe instability under load.

## Phase 4: Deterministic Install and Artifact Build

### WSL clone (`~/src/openwhispr`)

```bash
npm ci
npm run doctor:local
npm run build:renderer
```

### Windows clone (`C:\dev\openwhispr`)

```powershell
git pull --rebase
npm ci
npm run dev
```

For personal packaged app folder:

```powershell
npm run build:local:win
```

Run:

```powershell
.\dist\win-unpacked\OpenWhispr.exe
```

## Phase 5: Validate Personal Local UX

Validate this exact checklist:

- App launches from `dist/win-unpacked`
- Hotkey start/stop works
- One local transcription works end-to-end
- Auto-paste works in your target apps
- Local provider/model selection persists across restart
- No forced cloud/account blocker in your intended local path

## Maintenance Routine

Weekly sync:

```bash
git checkout main
git fetch upstream --prune
git rebase upstream/main
git push --force-with-lease origin main
```

Monthly maintenance:

```bash
git checkout main
git fetch upstream --prune
git rebase upstream/main
git push --force-with-lease origin main
npm ci
npm audit
npm run lint
npm run build
```

## Optional: Personal Update Policy

If you want to suppress updater prompts in personal builds, gate updater initialization in code behind an env flag (for example `OPENWHISPR_DISABLE_UPDATES=1`) and set it only in your personal runtime environment.

## Dual-Clone Rules (Non-Negotiable)

- Never share `node_modules` between WSL and Windows
- Never run Linux `npm install` or `npm ci` in Windows clone
- Never run Windows `npm.cmd install` or `npm.cmd ci` in WSL clone
- Validate Electron runtime/build on Windows clone only

