# OpenWhispr WSL AI Agent Setup (Two-Clone Workflow)

This guide sets up a safe workflow where:

- WSL is used for coding, analysis, and Git operations by your AI coding agent.
- Windows is used to run Electron (`npm run dev`) and create Windows builds.
- Both sides stay in sync through Git remote only.

This avoids mixed-platform `node_modules` and native module ABI issues.

## 1. Architecture and Rules

Use two separate working copies:

- WSL clone: `~/src/openwhispr`
- Windows clone: `C:\dev\openwhispr`

Hard rules:

- Never share one `node_modules` between WSL and Windows.
- Never run Linux `npm install` in the Windows clone.
- Never run Windows `npm.cmd install` in the WSL clone.
- Sync changes only via `git push` and `git pull`.

## 2. One-Time Windows Setup

Run in PowerShell:

```powershell
# Verify toolchain
node -v
npm -v
git --version

# Clone for runtime/build work
cd C:\
mkdir dev -Force
cd C:\dev
git clone <YOUR_REMOTE_URL> openwhispr
cd C:\dev\openwhispr

# Install dependencies for Windows runtime
npm ci
```

Optional: first dev run smoke test

```powershell
cd C:\dev\openwhispr
npm run dev
```

## 3. One-Time WSL Setup

Run in WSL terminal:

```bash
# Verify toolchain
node -v
npm -v
git --version

# Clone for coding/agent work
mkdir -p ~/src
cd ~/src
git clone <YOUR_REMOTE_URL> openwhispr
cd ~/src/openwhispr
```

If you run local lint/test in WSL, install Linux deps in the WSL clone only:

```bash
cd ~/src/openwhispr
npm ci
```

## 4. Git Line Endings (Important)

Use `.gitattributes` to enforce consistent line endings. Add this file if missing.

```gitattributes
* text=auto
*.sh text eol=lf
*.bash text eol=lf
*.yml text eol=lf
*.yaml text eol=lf
*.ts text eol=lf
*.tsx text eol=lf
*.js text eol=lf
*.jsx text eol=lf
*.json text eol=lf
*.md text eol=lf
*.ps1 text eol=crlf
*.bat text eol=crlf
*.cmd text eol=crlf
```

Recommended user Git settings:

WSL:

```bash
git config --global core.autocrlf input
git config --global core.eol lf
```

Windows:

```powershell
git config --global core.autocrlf true
```

If line endings were inconsistent before, renormalize once per clone:

```bash
git add --renormalize .
```

## 5. Daily Workflow

### A) Code in WSL (AI Agent)

Run in WSL:

```bash
cd ~/src/openwhispr
git pull --rebase
# edit/code/test here
git add -A
git commit -m "your message"
git push
```

### B) Run app on Windows

Run in PowerShell:

```powershell
cd C:\dev\openwhispr
git pull --rebase
npm ci
npm run dev
```

### C) Build on Windows

Run in PowerShell:

```powershell
cd C:\dev\openwhispr
git pull --rebase
npm ci
npm run build
```

## 6. AI Agent Guardrails (WSL)

Provide these constraints to your coding agent:

- Workspace is `~/src/openwhispr` only.
- Never call `npm run dev` for final app validation in WSL.
- Use WSL clone for edits, lint, and tests only.
- After changes, push branch/commits and report:
  - commit SHA
  - files changed
  - required Windows validation commands

Use this prompt template:

```text
You are editing in WSL clone only: ~/src/openwhispr.
Do not run or validate Electron runtime in WSL.
After coding, run lint/tests that are safe in WSL, commit changes, push, and give me:
1) commit SHA
2) changed files
3) exact PowerShell commands I should run in C:\dev\openwhispr to validate runtime/build.
```

## 7. Optional Sync Helpers

### WSL helper alias

Add to `~/.bashrc` or `~/.zshrc`:

```bash
alias ow='cd ~/src/openwhispr'
alias owpush='cd ~/src/openwhispr && git push'
```

### Windows helper function

Add to PowerShell profile:

```powershell
function owdev {
  Set-Location C:\dev\openwhispr
  git pull --rebase
  npm ci
  npm run dev
}
```

## 8. Quick Validation Checklist

- WSL clone path exists: `~/src/openwhispr`
- Windows clone path exists: `C:\dev\openwhispr`
- `git remote -v` matches on both clones
- WSL commits push successfully
- Windows pulls successfully
- `npm run dev` works in Windows clone
- `npm run build` works in Windows clone

## 9. Troubleshooting

- If Windows build fails after dependency changes:
  - In `C:\dev\openwhispr`, run `npm ci` again.
- If native module mismatch errors appear:
  - Ensure install was done in the same OS where app is being run.
- If many files show line-ending diffs:
  - Confirm `.gitattributes` exists and run `git add --renormalize .`.
- If watcher/HMR is unstable:
  - Run dev server from Windows clone (not WSL).

