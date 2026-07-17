---
name: openwhispr-local-build
description: Use this skill to build, ship, update, or troubleshoot Marco's personal OpenWhispr build pipeline that flows from the WSL dev clone (~/dev/openwhispr) to the native-Windows packaged app (C:\dev\openwhispr\dist\win-unpacked) launched from the Start Menu. Trigger whenever the user wants to "rebuild the app", "ship my changes", "update the Windows app", "push and rebuild", pull an upstream OpenWhispr update, bump WhisperX/Python or npm/Electron dependencies, refresh native binaries, or diagnose a failed pipeline run (GitHub 403/rate-limit, PowerShell parse errors, dirty Windows tree, WhisperX runtime/CUDA issues). Also use when asked how the WSL→Windows build loop works.
---

# OpenWhispr Local Build Pipeline (WSL dev → native-Windows app)

A two-clone workflow: **code lives in the WSL clone**, the **app you run is the
native-Windows packaged build**. Editing happens only in WSL; the Windows clone
is build-only and must stay clean.

| Thing | Location |
|---|---|
| WSL dev clone (edit here) | `~/dev/openwhispr` (a.k.a. `/home/marco/dev/openwhispr`) |
| Windows build clone (never edit) | `C:\dev\openwhispr` |
| Packaged app | `C:\dev\openwhispr\dist\win-unpacked\OpenWhispr.exe` |
| Start Menu shortcut (targets the exe) | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\OpenWhispr.lnk` |
| Ship script (WSL) | `scripts/ship-local.sh` → `npm run ship:local` |
| Update script (Windows PowerShell) | `scripts/update-local-app.ps1` |

**Golden rule (dual-clone):** run WSL npm/git in WSL, Windows npm/git in
Windows. Never share `node_modules`. Never run Linux `npm ci` in the Windows
clone or vice-versa. The Windows script refuses to build over a dirty tree.

## The everyday loop

1. **WSL — validate + push** (tests, lint, typecheck, i18n, then push the
   current branch to origin). From `~/dev/openwhispr`:
   ```bash
   npm run ship:local
   # emergency push without checks: bash scripts/ship-local.sh --skip-checks
   ```
2. **Native Windows PowerShell — pull + rebuild** (never from WSL):
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\dev\openwhispr\scripts\update-local-app.ps1
   ```
   It closes a running OpenWhispr, fast-forward pulls, refreshes deps/runtime
   only when their lockfiles changed, provisions native binaries only when
   missing/changed, runs an **offline** packaged build, verifies the Start Menu
   shortcut, and prints a doctor summary. Then launch **OpenWhispr** from the
   Start Menu.

### Driving the Windows side from this WSL session
When operating the pipeline from an agent in WSL, use interop and strip CRLF:
```bash
# ship from WSL first
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm exec 24 npm run ship:local
# then drive Windows (git pull is via cmd.exe because the .ps1 arrives via that pull)
cmd.exe /c "git -C C:\dev\openwhispr pull --ff-only origin <branch>" 2>&1 | tr -d '\r'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\dev\openwhispr\scripts\update-local-app.ps1" -Branch <branch> 2>&1 | tr -d '\r'
```
Windows build runs are long — run them backgrounded and read the task output file.

## update-local-app.ps1 flags

- `-Branch <name>` — branch to build (default: current branch in the clone).
- `-SkipBuild` — pull + deps/runtime/provision only, no packaged rebuild.
- `-ForceProvision` — force a native-binary re-download (needs network/token).
- `-RepoDir` / `-Remote` — override clone path / remote (defaults `C:\dev\openwhispr`, `origin`).

Fresh machine: the script clones the fork if `C:\dev\openwhispr` is absent.

## What is (and isn't) rebuilt — the marker system

Markers live in the gitignored `C:\dev\openwhispr\.local-pipeline\`. A step runs
only when its input hash changed:

- `npm ci` — only when `package-lock.json` changed.
- WhisperX runtime repair (`node scripts/setup-whisperx.js --repair`) — only
  when `tools/whisperx-sidecar/uv.lock` changed.
- Native-binary provisioning (`npm run prebuild:local:win`) — only when a
  required binary is missing OR a `scripts/download-*.js` changed (same signal
  CI uses to key its `resources/bin` cache). Otherwise the marker is seeded
  with **no GitHub calls**.
- Packaged build — always, but **offline**: `npm run build:local:win
  --ignore-scripts` skips the network prebuild because binaries are already in
  `resources\bin` (gitignored, stable across builds).

Result: a routine rebuild makes **zero GitHub API calls**, so it never hits the
60-req/hr rate limit.

## Update flows

- **Upstream OpenWhispr** (a "vX.Y.Z available" notice in the app means the fork
  is behind — the updater checks upstream releases, not your fork):
  1. In WSL, fast-forward main: `git checkout main && git fetch upstream &&
     git merge --ff-only upstream/main && git push origin main` (the fork's main
     is normally a strict ancestor of upstream/main, so this is a clean ff).
  2. Bring it onto the feature branch. For a large gap (dozens of upstream
     commits) **prefer a merge over a rebase** — it resolves the whole conflict
     surface once instead of at every commit: `git checkout <branch> &&
     git merge upstream/main`. **Never `git stash` mid-merge** — it silently
     drops `MERGE_HEAD`; if you must, recover with `git stash pop` then
     `git rev-parse upstream/main > .git/MERGE_HEAD` before committing so it
     stays a real two-parent merge.
  3. Resolve conflicts — the fork diverges from upstream in the same ~17 files
     each sync (i18n shims in `src/lib/simpleI18n.ts`/`reactI18nextShim.tsx`,
     `@homebridge/dbus-native` vs the fork's dbus dep, `auth.ts`
     `getDesktopOAuthCallbackURL` helper, platform-aware `compile:native`, keep
     BOTH `optionalDependencies` + upstream `overrides`, keep BOTH the `whisperx`
     and upstream translation keys). Regenerate the lockfile with
     `nvm exec 24 npm install` — never hand-merge `package-lock.json`. The
     `upstream-sync-conflict-hotspots` memory has the exact per-file decisions.
  4. **Validate before shipping** (catches merge-introduced type/runtime breaks
     like the i18n shim missing `returnObjects`): `nvm exec 24 sh -c 'npm run
     typecheck && npm run lint && npm run i18n:check && npm test && npm run
     build:renderer'` — all green.
  5. `npm run ship:local`, then the Windows update script.
  An upstream release that adds a sidecar binary (e.g. yt-dlp) changes a
  `scripts/download-*.js`, so the Windows script re-provisions on that run
  (network + GitHub API) — set `$env:GITHUB_TOKEN` first if you might exceed the
  60-req/hr limit.
- **WhisperX / Python bump**: in WSL, on a branch:
  `cd tools/whisperx-sidecar && uv lock --upgrade`, then
  `uv run pytest` and `npm test`, then ship. The Windows script sees the
  changed `uv.lock` and repairs the runtime automatically. **Keep the
  `[tool.uv.sources]` cu128 block in the sidecar `pyproject.toml`** — Windows
  torch must come from `download.pytorch.org/whl/cu128` (PyPI win32 torch is
  CPU-only; Linux PyPI already bundles CUDA).
- **Node/Electron/npm bump**: flows through `package-lock.json`; the Windows
  script re-runs `npm ci` automatically. Regenerate the lockfile with Node 24
  (`nvm exec 24 npm install`) to match CI.
- **Native binary bump** (whisper.cpp, llama-server, sherpa-onnx, qdrant,
  Windows helpers): a changed `scripts/download-*.js` re-provisions next run, or
  force with `-ForceProvision`. Set `$env:GITHUB_TOKEN` (classic PAT, no scopes)
  first for reliable downloads.

## Data that survives rebuilds (never wiped by the pipeline)

Under `%APPDATA%\OpenWhispr` and `~/.cache/openwhispr`: Whisper/Parakeet/WhisperX
models, the WhisperX managed runtime, recordings/jobs, and the encrypted secret
store (incl. the Hugging Face diarization token — configured in-app at
Settings → Transcription → Local → WhisperX → Diarization, never in `.env`).

## Troubleshooting

- **`HTTP 403` / "Could not fetch release" during build** — GitHub API rate
  limit from re-downloading binaries. Routine builds shouldn't hit this
  anymore; if it appears, the binaries are missing or a download script
  changed. Set `$env:GITHUB_TOKEN` and re-run, or wait for the hourly reset.
- **PowerShell parse errors / "term X is not recognized" / unexpected token** —
  `update-local-app.ps1` must stay **ASCII-only with a UTF-8 BOM**. PS 5.1 reads
  BOM-less files as ANSI and mis-decodes non-ASCII (em-dashes, smart quotes)
  into string-delimiter bytes. Verify: `head -c 3 <file> | xxd` → `efbbbf`, and
  `grep -nP '[^\x00-\x7F]' <file>` shows only the BOM line.
- **"Windows clone has local changes"** — the clone must be clean (dual-clone
  rule). Discard/inspect the changes; all editing belongs in WSL. The
  gitignored `.local-pipeline/` markers never dirty the tree.
- **First run after adopting the pipeline** — the update script arrives via git,
  so bootstrap once: `git -C C:\dev\openwhispr pull --ff-only origin <branch>`
  before the first script run (or let clone-if-missing create the clone).
- **WhisperX runtime / CUDA problems** — run `node scripts/doctor-whisperx.js`
  (add `--json`) in the Windows clone. Repair with
  `node scripts/setup-whisperx.js --repair`; `--remove` to wipe. Requires `uv`
  on PATH. Diarization needs the HF token (ASR works without it).
- **`usocket` "invalid dependency" collector warning during packaging** —
  pre-existing, benign; electron-builder still packages and the exe runs.

## Verify a successful run

Doctor prints all `[PASS]` (CUDA on the RTX 4060, ffmpeg, runtime) with only the
HF-token `[WARN]` if diarization isn't configured. The exe `LastWriteTime` is
fresh, and the Start Menu shortcut targets the win-unpacked exe. Confirm the
packaged sidecar staged: `C:\dev\openwhispr\dist\win-unpacked\resources\whisperx-sidecar`
(pyproject.toml, uv.lock, src, README — no tests/venv).
