# Codex Master Task — Implement WhisperX Accurate Recordings and Reliable Notes

## Mission

Fully implement a production-quality, local-first **WhisperX Accurate Recording** pipeline in the current OpenWhispr fork.

The completed feature must let a user select or drag an existing audio recording into OpenWhispr, transcribe it locally with WhisperX, optionally align words and diarize speakers, preserve structured evidence artifacts, and generate reliable Markdown notes in which every substantive claim is traceable to transcript segment IDs and timestamps.

This is an implementation task, not a planning-only task.

## Required Reading Order

Before changing code:

1. Read the repository's existing `AGENTS.md`, `CLAUDE.md`, README, package scripts, and any nested agent instructions.
2. Read this entire package in numeric order:
   - `00_MASTER_IMPLEMENTATION_SPEC.md`
   - `01_PRODUCT_REQUIREMENTS.md`
   - `02_ARCHITECTURE_AND_DATA_FLOW.md`
   - `03_DATA_CONTRACTS_AND_PROTOCOLS.md`
   - `04_RELIABLE_NOTES_COMPILER.md`
   - `05_IMPLEMENTATION_PHASES.md`
   - `06_TDD_AND_VALIDATION_PLAN.md`
   - `07_SECURITY_PRIVACY_THREAT_MODEL.md`
   - `08_HARDWARE_AND_PERFORMANCE_PROFILE.md`
   - `09_BENCHMARK_AND_QUALITY_EVALUATION.md`
   - `10_OPERATIONS_AND_TROUBLESHOOTING.md`
   - `11_ACCEPTANCE_CRITERIA.md`
   - `13_DECISION_LOG.md`
3. Read the three Markdown files under `references/`.
4. Inspect the actual current implementation around upload transcription, local models, diarization, note formatting, SQLite, IPC, model provisioning, build packaging, and tests.

The repository at the current HEAD is the source of truth. Adapt file targets when upstream/fork changes have moved responsibilities.

## Execution Contract

### Worktree safety

- Start by running `git status --short`, `git branch --show-current`, and `git rev-parse HEAD`.
- Preserve all existing user changes. Never reset, clean, stash, checkout over, or discard work that you did not create.
- Do not force checkout a different branch when doing so could disturb current work.
- If the current branch is `main` and the working tree permits it, create `feat/whisperx-reliable-notes`. Otherwise remain on the current branch and report why.
- Do not commit, push, publish, tag, release, or open a pull request unless the user explicitly asks.
- Do not run Codex Security, Snyk, CodeQL, broad repository security scans, or network-heavy audits without explicit user approval.
- Do not modify unrelated code merely because you discover pre-existing problems.

### Evidence-first reconnaissance

Before implementing:

1. Identify the exact current paths and call chain for:
   - upload and batch transcription UI;
   - local transcription provider selection;
   - renderer-to-main IPC;
   - whisper.cpp and Parakeet execution;
   - local diarization and speaker-text merging;
   - note persistence and database migrations;
   - note formatting/background actions;
   - local llama.cpp lifecycle;
   - native-binary/model download scripts;
   - packaged Windows build staging;
   - test structure and commands.
2. Record findings in `TASK_TRACKER.md`.
3. Run the smallest relevant baseline test/lint/build commands already defined by the repository.
4. Record all pre-existing failures verbatim before making changes.
5. Verify the active Node version policy from the actual `.nvmrc`, `package.json`, lockfile, and CI. The copied local setup says Node 22, while newer upstream material may require Node 24. Do not mix a toolchain migration into this feature unless the repository currently requires it to proceed.

### Implementation behavior

- Work through all phases without waiting for approval between phases.
- Add failing tests or contract fixtures before each behavior change.
- Prefer narrow extensions over broad refactors.
- Reuse existing provider registries, settings resolution, database utilities, note storage, local LLM routing, and UI components where they are suitable.
- Keep live dictation behavior unchanged unless a shared contract must be extended compatibly.
- Implement WhisperX for uploaded/recorded files first; do not route hotkey dictation through WhisperX.
- Use native Windows runtime integration, not WSL, for the shipped sidecar.
- Use a pinned Python 3.12 environment and a pinned, tested WhisperX dependency. Start from `whisperx==3.8.6`; change only when compatibility evidence requires it, and document the exact reason.
- Use JSON Lines over stdin/stdout between Electron main and the Python worker.
- Spawn subprocesses with `shell: false`, explicit arguments, a minimized environment, redacted logs, and real process-tree cancellation.
- Preserve canonical transcript JSON and raw/speaker transcript text separately from enhanced notes.
- Generate notes through structured extraction plus validation and deterministic rendering; do not perform an unconstrained one-pass transcript rewrite.
- Use existing custom dictionary terms as WhisperX hotwords/initial context where supported.
- Store credentials with the repository's Electron `safeStorage` pattern. Never place a Hugging Face token in command arguments, renderer state, tracked `.env`, or logs.
- Add a GPU inference coordinator so WhisperX/pyannote and the local llama.cpp model execute sequentially.
- Implement deterministic OOM fallback, cancellation, retry, crash recovery, artifact retention, and cleanup.
- Add explicit offline behavior after dependencies/models have been provisioned.
- Add or update setup, doctor, packaging, troubleshooting, and benchmark commands.

## Required User-Facing Profiles

Implement at least these presets, while allowing advanced overrides:

### Personal Voice Memo

```text
Model: large-v3-turbo
Compute: float16
Batch size: 4
Alignment: enabled
Diarization: disabled
Language: auto/en/es selectable
Notes: ideas, tasks, questions, follow-ups
```

### Meeting

```text
Model: large-v3-turbo
Compute: float16
Batch size: 4
Alignment: enabled
Diarization: enabled
Known/min/max speaker count: optional
Notes: summary, discussion points, decisions, action items, follow-ups, open questions
```

### Critical / Research Interview

```text
Model: large-v3
Compute: float16
Batch size: 2
Alignment: enabled
Diarization: enabled
Raw transcript preservation: mandatory
Notes: evidence-bound; no inferred names, roles, owners, or due dates
```

OOM fallback must reduce batch size and then switch compute type according to the performance specification rather than silently failing.

## Mandatory Outputs

The implementation must produce, for each completed recording job:

```text
job manifest
source identity/hash metadata
canonical transcript JSON
plain raw transcript
speaker/timestamp Markdown transcript when diarization is enabled
SRT and VTT when timestamps are available
validated structured note-extraction JSON
rendered Markdown notes
error/warning metadata
```

Use the Electron user-data directory rather than hard-coded usernames or machine paths. Store paths as relative paths within a job directory whenever practical.

## Mandatory Reliability Rules

- A generated note claim without at least one valid evidence segment ID is rejected.
- Evidence segment IDs must exist in the canonical transcript.
- Exact quotations must be found in, or be a punctuation/whitespace-normalized match of, the cited transcript text.
- Owners and due dates remain `null` unless explicit.
- Speaker labels remain generic until the user renames them.
- Diarization uncertainty and overlapping speech must be reviewable.
- The note renderer must not invent content.
- Failed or cancelled jobs never appear complete.
- Partial artifacts are either marked incomplete or removed atomically.
- Re-running note generation must not require retranscription.
- Deleting a managed job must remove managed artifacts without deleting an external source file.

## Verification Bar

Run and report:

1. Existing baseline tests relevant to changed surfaces.
2. New TypeScript/JavaScript unit and contract tests.
3. New Python `pytest` tests.
4. Renderer/main-process integration tests with a fake JSONL sidecar.
5. Database migration tests.
6. Artifact-path and secret-redaction security tests.
7. Build and lint/type-check commands used by the repository.
8. `npm run doctor:local` or the current equivalent.
9. A Windows packaged/unpacked build or the closest available packaging verification.
10. Hardware-gated WhisperX smoke test when CUDA and models are available.
11. Offline rerun after model provisioning when feasible.

Do not claim GPU, diarization, or packaged behavior passed when the corresponding test was skipped. Use the exact reporting template in `12_FINAL_REPORT_TEMPLATE.md`.

## Stop Conditions

Do not stop merely because the task is large. Continue through all code, tests, documentation, and validation that can be completed in the current environment.

Stop only for a genuine hard blocker such as:

- an unavailable repository file or corrupted checkout;
- required user-owned model terms/token not present for a real pyannote run;
- missing GPU/CUDA runtime that cannot be installed safely in the current environment;
- a pre-existing build failure that prevents downstream tests;
- a platform packaging constraint unavailable to the current agent.

Even then, complete all non-blocked implementation and tests, create deterministic mocks/fixtures for the blocked surface, and clearly report the remaining manual step.

## Final Response

Your final response must:

- use `12_FINAL_REPORT_TEMPLATE.md`;
- list every changed file and purpose;
- distinguish baseline failures from regressions;
- provide exact commands and results;
- show which acceptance criteria passed, failed, or were not executable;
- identify any unverified hardware, licensing, model-download, or packaging behavior;
- state that no commits/pushes/releases/security scans occurred unless they actually did;
- leave `TASK_TRACKER.md` accurately updated.
