# 05 — Implementation Phases

Proceed through all phases. Do not wait for user approval between them. Use the phase exit criteria to prevent an incomplete vertical slice from being mistaken for completion.

## Phase 0 — Reconnaissance and Baseline

### Tasks

- Read all repository instructions.
- Record branch, HEAD, status, toolchain versions.
- Map current transcription, diarization, notes, database, IPC, runtime, packaging, and test flows.
- Verify whether Node 22 or Node 24 is authoritative at current HEAD.
- Run baseline relevant tests, lint/typecheck, build, and doctor.
- Record pre-existing failures.
- Update `TASK_TRACKER.md`.

### Exit criteria

- Concrete current file map.
- Baseline evidence recorded.
- No code change beyond tracker notes.

## Phase 1 — Contracts and Failure Tests

### Tasks

- Add shared JSON fixtures.
- Add TypeScript schemas or validators following project conventions.
- Add Python Pydantic schemas.
- Add JSONL parser/state-machine tests.
- Add invalid path, invalid evidence, malformed event, cancellation, and OOM classification tests.
- Add transcript and note renderer golden fixtures.
- Add database migration tests.
- Add fake worker executable/script fixture.

### Exit criteria

- New tests fail for missing implementation, not for broken fixture setup.
- Cross-language valid/invalid fixtures agree.

## Phase 2 — Python Sidecar

### Tasks

- Add `tools/whisperx-sidecar`.
- Pin Python 3.12 and WhisperX.
- Implement one-request worker.
- Implement ready/heartbeat/stage/progress/warning/artifact/complete/error events.
- Implement audio probe and safe normalization.
- Implement ASR, alignment, and optional diarization.
- Build canonical transcript.
- Write artifacts into assigned temp directory.
- Hash artifacts.
- Redact errors.
- Add Python unit tests with mocked model layers.
- Add an opt-in real GPU test.

### Exit criteria

- `uv run pytest` passes.
- Fake/model-mocked worker produces valid artifacts.
- Worker never emits non-JSON to stdout.
- Secret redaction tests pass.

## Phase 3 — Runtime Provisioning and Doctor

### Tasks

- Choose and implement managed runtime strategy compatible with current packaging.
- Add deterministic setup/repair/uninstall command.
- Verify uv/Python/lock/runtime sentinel.
- Configure app-specific cache directories.
- Add CUDA/Torch/GPU/VRAM diagnostics.
- Add model readiness/offline readiness.
- Add secure HF token storage and readiness checks.
- Add content-safe diagnostic output.
- Integrate with existing local doctor.

### Exit criteria

- Clean setup can provision or clearly guide runtime.
- Doctor distinguishes installed, repairable, token-blocked, model-blocked, CUDA-blocked, and offline-ready states.
- No secret appears in output.

## Phase 4 — Main-Process Orchestration

### Tasks

- Add runtime/process/job/artifact managers using existing patterns.
- Implement narrow IPC and preload contracts.
- Implement JSONL validation.
- Implement process-tree cancellation.
- Implement watchdog/heartbeat timeout.
- Implement GPU inference coordinator.
- Integrate local llama.cpp pause/unload/resume.
- Implement OOM retry policy.
- Persist state transitions.
- Add startup recovery and temp cleanup.

### Exit criteria

- Fake-worker integration covers success, malformed protocol, worker crash, timeout, cancel, and OOM fallback.
- Renderer cannot pass arbitrary executable or output paths.
- Existing providers remain functional in tests.

## Phase 5 — Provider and UI Integration

### Tasks

- Register `whisperx` as a local uploaded-recording provider.
- Keep live dictation provider set unchanged.
- Add profile presets and advanced settings.
- Add language, diarization, and speaker-count controls.
- Integrate custom dictionary hotwords.
- Add real progress and warnings.
- Add cancel/retry and batch queue behavior.
- Use i18n patterns for new strings.
- Add accessibility/keyboard behavior.
- Add component/store tests.

### Exit criteria

- User can configure and start fake-worker WhisperX jobs through the existing upload flow.
- Batch remains sequential.
- Navigation does not orphan job state.
- Existing upload providers regressions are covered.

## Phase 6 — Persistence, Artifacts, and Review

### Tasks

- Add database migration and repository methods.
- Add job/artifact manifest.
- Implement atomic finalize.
- Persist transcript/artifact metadata.
- Add transcript/audio viewer.
- Add timestamp seeking.
- Add generic speaker rename mapping.
- Add correction/revision layer.
- Add export and retention/delete behavior.
- Ensure external source files are never deleted.
- Add disk usage and relink handling.

### Exit criteria

- Completed job survives restart.
- All required artifacts validate and reopen.
- Delete semantics are tested.
- Speaker rename does not mutate canonical transcript.
- Corrected revision is traceable.

## Phase 7 — Reliable Notes

### Tasks

- Add segment-aware chunker.
- Add profile-specific extraction prompts.
- Use existing note-formatting provider resolution.
- Add structured extraction and one retry.
- Add evidence/quote/owner/date validators.
- Add deterministic merge.
- Add optional strict support verifier.
- Add deterministic Markdown renderer.
- Save extraction and notes separately.
- Add note regeneration without ASR.
- Add evidence links from notes to transcript/audio.
- Treat transcript prompt injection as untrusted content.
- Add comprehensive fixtures.

### Exit criteria

- No evidence-free claim can render.
- Invalid quotes/owners/dates fail validation.
- Long transcript chunks merge deterministically.
- Notes can regenerate from stored transcript with a different template.
- Existing note formatting remains available.

## Phase 8 — Benchmark and Performance

### Tasks

- Add benchmark CLI.
- Add WER/CER and domain-specific metrics.
- Add note grounding/coverage metrics.
- Add timing, RTF, RAM/VRAM capture where available.
- Compare existing engines and WhisperX profiles.
- Generate JSON, CSV, and Markdown reports.
- Add synthetic/small test fixtures without checking in sensitive recordings.
- Document user recording benchmark workflow.

### Exit criteria

- Harness runs deterministically on a fixture.
- Real recording benchmark is runnable with local private inputs.
- Reports distinguish missing/skipped metrics.

## Phase 9 — Packaging, Documentation, and Final Validation

### Tasks

- Ensure local Windows build can find/provision the sidecar.
- Update package/build inclusion.
- Update setup, hardening, troubleshooting, privacy, retention, and licenses.
- Run full applicable validation.
- Run packaged/unpacked smoke test.
- Run real GPU/diarization/offline smoke tests when available.
- Complete acceptance checklist and final report.
- Update `TASK_TRACKER.md`.

### Exit criteria

- All applicable acceptance criteria pass.
- Every skipped/blocker is explicit.
- No unrelated changes.
- No hidden secrets/content in logs or package.
- Final report follows required template.

## Suggested Logical Change Boundaries

Do not commit unless asked, but organize the diff as though it could be reviewed in these units:

1. contracts and tests;
2. Python sidecar and lock;
3. runtime provisioning/doctor;
4. main-process orchestration/IPC;
5. provider/settings/UI;
6. persistence/artifact viewer;
7. evidence-bound notes;
8. benchmark/docs/packaging.

## Toolchain Migration Rule

A Node major-version correction, Electron upgrade, or unrelated dependency modernization should be a separate logical change. Perform it only if current repository requirements block the feature, and record baseline/build evidence before and after.
