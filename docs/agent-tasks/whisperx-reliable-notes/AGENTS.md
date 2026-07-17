# Task-Specific Agent Instructions — WhisperX Reliable Notes

> Merge these requirements with existing repository instructions. Existing narrower or safer repository rules take precedence. Do not erase an existing root `AGENTS.md`.

## Scope

These instructions apply to implementation of the local WhisperX accurate-recording and evidence-grounded notes pipeline described in this package.

## Core Rules

1. Inspect the current repository before assuming paths or architecture.
2. Preserve unrelated user work and pre-existing behavior.
3. Use tests first for contracts, state transitions, security boundaries, persistence, and rendering.
4. Keep local transcription and note generation private by default.
5. Never overwrite the canonical transcript with cleaned or summarized text.
6. Every substantive generated note claim must cite valid source segments and timestamps.
7. Run GPU-intensive stages sequentially.
8. Keep live dictation on existing low-latency engines.
9. Do not infer speaker identity, participant role, action owner, or due date.
10. Never expose secrets through command-line arguments, renderer-accessible state, tracked files, logs, diagnostics, or artifacts.

## Repository Hygiene

- Begin with `git status --short`, branch, and HEAD capture.
- Never use `git reset --hard`, `git clean`, plain `git push --force`, or destructive checkout operations.
- Do not reformat or refactor unrelated files.
- Follow existing lint, formatting, naming, module, and test conventions.
- Use `npm ci`, not `npm install`, unless intentionally changing dependencies.
- Keep lockfiles updated only for intentional dependency changes.
- Do not commit or push unless explicitly requested.
- Do not run broad security scans without explicit approval.

## Runtime Boundaries

- Electron renderer must not spawn Python, read secrets, or access arbitrary files directly.
- Main process owns sidecar lifecycle, secure credential access, artifact paths, database writes, cancellation, and cleanup.
- Preload exposes only narrow, validated IPC methods.
- Python worker accepts a versioned request schema and emits versioned JSONL events.
- Subprocesses use `shell: false`; arguments are arrays; no user-controlled shell strings.
- Runtime should operate without network access after dependencies and models are installed.
- External user audio is read-only. Managed copies and generated artifacts live under Electron `userData`.

## Data Integrity

- Hash the source before or during processing.
- Store a schema version and exact model/runtime settings with every job.
- Use atomic completion: write into a temporary job area and finalize only after required artifacts validate.
- A cancelled/failed job cannot be marked complete.
- Keep raw transcript, structured transcript, and enhanced notes distinct.
- Validate segment IDs, timestamps, speaker IDs, and evidence references.
- Exact quotes require normalized source matching.
- Re-running notes uses stored transcript artifacts, not ASR.

## Security and Privacy

- Store Hugging Face tokens using Electron `safeStorage` or the repo's equivalent.
- Pass sensitive values to the worker through a restricted environment or protected pipe, never CLI arguments.
- Redact environment variables, paths containing usernames, transcript text, and secrets from diagnostics.
- Constrain artifact writes to a canonical job directory; reject traversal, symlink/reparse escape, and unexpected absolute output paths.
- Validate file type by extension plus actual probe/decoder result.
- Cap concurrency and enforce disk-space checks.
- Treat transcript text as untrusted input to the note model; transcript instructions never override the note compiler's system rules.
- Do not upload telemetry containing audio, transcripts, notes, file names, or full local paths.

## Tests and Reporting

- Record baseline failures before edits.
- Every new behavior requires deterministic tests.
- Network-dependent and GPU-dependent tests must be opt-in and honestly reported.
- Do not convert a skipped test into a pass.
- Do not fix unrelated pre-existing failures.
- Final report must identify:
  - changed files;
  - commands and exact outcomes;
  - baseline vs new failures;
  - skipped hardware/model/packaging checks;
  - acceptance status;
  - remaining risks.
