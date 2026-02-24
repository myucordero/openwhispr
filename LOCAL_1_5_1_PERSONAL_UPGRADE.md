# Upgrade to v1.5.1 While Keeping Personal Local-Only Behavior

This runbook upgrades your **source code** to upstream `v1.5.1` and preserves your personal local-first behavior (no forced account/cloud workflow in your own builds).

## Outcome

After this process, you will have:

- Upstream `v1.5.1` features in your fork/codebase
- Your personal local-only defaults preserved
- A reproducible personal build you can run from `dist/`

## Preconditions

- You are in your fork clone (`origin` = your fork, `upstream` = `OpenWhispr/openwhispr`)
- Node.js 22 (`.nvmrc`)
- Working internet (for `git fetch`, release metadata, binaries)
- A clean backup branch containing your current personal changes

## Phase 1: Protect Your Current Personal State

1. Check current branch and local changes:

```bash
git status
git branch --show-current
```

2. Create a dedicated branch for your personal customizations:

```bash
git checkout -b personal/local-only-baseline
```

3. Commit all current personal changes:

```bash
git add -A
git commit -m "chore(personal): local-only defaults and offline build workflow baseline"
```

4. Push backup branch to your fork:

```bash
git push -u origin personal/local-only-baseline
```

## Phase 2: Sync to Upstream v1.5.1

1. Fetch upstream and tags:

```bash
git fetch upstream --tags
```

2. Confirm tag exists:

```bash
git tag -l "v1.5.1"
```

3. Update your local `main` to upstream `v1.5.1`:

```bash
git checkout main
git fetch upstream --tags
git reset --hard upstream/v1.5.1
git push --force-with-lease origin main
```

If you do not want to force-update `main`, use an integration branch instead:

```bash
git checkout -b integration/v1.5.1 upstream/v1.5.1
git push -u origin integration/v1.5.1
```

## Phase 3: Re-Apply Personal Local-Only Behavior

1. Create a personal branch from updated code:

```bash
git checkout -b personal/v1.5.1-local-only
```

2. Cherry-pick your personal baseline commit(s):

```bash
git log --oneline personal/local-only-baseline
git cherry-pick <commit-hash-1> <commit-hash-2>
```

3. Resolve conflicts manually, then continue:

```bash
git add -A
git cherry-pick --continue
```

4. Re-verify these local-only controls in code:

- Local transcription defaults enabled
- Cloud/account onboarding prompts disabled or hidden for your personal build mode
- Updater behavior aligned with your preference (keep enabled, or disable for personal builds)
- `build:local:win` script still present and working

Recommended files to review:

- `src/hooks/useSettings.ts`
- `src/components/OnboardingFlow.tsx`
- `src/components/SettingsPage.tsx`
- `src/updater.js`
- `package.json`
- `LOCAL_PERSONAL_SETUP.md`

## Phase 4: Install and Build Deterministically

1. Clean install:

```bash
npm ci
```

2. Validate local toolchain and models:

```bash
npm run doctor:local
```

3. Build local packaged app (personal/offline-friendly):

```bash
npm run build:local:win
```

4. Run app directly:

```bash
.\dist\win-unpacked\OpenWhispr.exe
```

5. Optional full installer build:

```bash
npm run build
```

Run installer in PowerShell:

```bash
& '.\dist\OpenWhispr Setup 1.5.1.exe'
```

## Phase 5: Verify Personal Local-Only UX

Use this acceptance checklist:

- App launches from your locally built artifact
- No forced account requirement in your intended local-only path
- No forced cloud-only onboarding blockers
- Local Whisper/Parakeet transcription works end-to-end
- Hotkey record/stop works
- Auto-paste works in target apps
- Update behavior matches your decision (enabled or disabled)

## Troubleshooting

### 1) `git fetch upstream --tags` fails (DNS/network)

- Retry after network/DNS recovers
- Verify remote URL:

```bash
git remote -v
```

### 2) PowerShell cannot run installer path with spaces

Use call operator + quoted path:

```bash
& '.\dist\OpenWhispr Setup 1.5.1.exe'
```

### 3) `download:nircmd` fails

- Network issue to NirSoft; retry later:

```bash
npm run download:nircmd
```

- `build:local:win` should still continue (best-effort download behavior).

### 4) Updater prompts unexpected cloud/account UX after code update

- Confirm you are running your local artifact from `dist/`, not installed official app
- Re-check your local-only guard conditions in onboarding/settings components

## Recommended Branch Model

- `main`: tracks upstream stable (e.g., `v1.5.1`)
- `personal/v1.5.1-local-only`: your daily personal branch
- `personal/local-only-baseline`: backup snapshot for rollback/cherry-pick

## Optional: Disable Auto-Updater for Personal Builds

If you want to avoid official release prompts entirely in personal builds, gate updater setup with an env flag in `src/updater.js`, for example:

- `OPENWHISPR_DISABLE_UPDATES=1` -> skip `setFeedURL` and startup check

Then set it in your personal runtime environment only.

## Final Verification Commands

```bash
git status
npm run doctor:local
npm run build:local:win
```

If all pass, your codebase is on `v1.5.1` with personal local-only behavior preserved.
