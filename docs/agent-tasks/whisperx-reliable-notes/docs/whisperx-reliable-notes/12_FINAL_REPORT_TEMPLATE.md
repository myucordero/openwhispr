# 12 — Required Codex Final Report Template

Use this exact structure.

## Result

State whether the implementation is complete, partially complete due to named blockers, or failed. Do not use vague language.

## Repository State

```text
Initial branch:
Final branch:
Initial HEAD:
Final HEAD:
Initial worktree state:
Final worktree state:
Commits created:
Push/release performed:
Broad security scans performed:
```

## Baseline

| Command | Exit | Result | Pre-existing issue |
|---|---:|---|---|
| | | | |

Explain any baseline failure that limited downstream validation.

## Implementation Summary

Summarize the delivered vertical slice:

```text
runtime/provisioning
WhisperX worker
main-process orchestration
GPU coordination
provider/UI
artifacts/persistence
transcript review
reliable notes
benchmark/diagnostics
packaging/docs
```

## Changed Files

| File | Purpose |
|---|---|
| | |

List every changed, created, deleted, or generated tracked file. Group generated lockfiles separately.

## Architecture Decisions

Document any divergence from the package:

| Decision | Package default | Implemented choice | Evidence/reason |
|---|---|---|---|
| | | | |

Include:

```text
Node version
Python version
WhisperX version
runtime provisioning strategy
diarization provider/fallback
database approach
GPU coordination approach
packaging approach
```

## Tests and Validation

### JavaScript/TypeScript

| Command | Exit | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| | | | | |

### Python

| Command | Exit | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| | | | | |

### Build/Lint/Packaging

| Command | Exit | Result |
|---|---:|---|
| | | |

### Hardware/Model Smoke

| Check | Status | Evidence |
|---|---|---|
| CUDA/Torch | | |
| WhisperX ASR | | |
| Alignment | | |
| Diarization | | |
| Local note model | | |
| Offline rerun | | |
| Packaged build | | |

Never put `PASS` when a check was not run.

## Acceptance Criteria

Summarize counts:

```text
PASS:
FAIL:
BLOCKED:
NOT APPLICABLE:
```

List every FAIL/BLOCKED item with reason and next command/action.

## Security and Privacy Verification

Report:

```text
secret storage
CLI/process argument review
log/diagnostic redaction
path confinement
external file deletion protection
offline behavior
prompt-injection regression
temp cleanup
```

State whether any audio, transcript, note, token, or private path left the machine during testing.

## Performance and Benchmark

Report available:

```text
machine/GPU
audio duration
model/settings
ASR/alignment/diarization time
note time
RTF
peak VRAM/RAM
fallback attempts
quality metrics
```

If no private benchmark was run, state that clearly and provide the exact command.

## Known Limitations and Remaining Risks

Separate:

- implementation gaps;
- environment-only blockers;
- upstream/pre-existing issues;
- optional future improvements.

Do not bury a required acceptance failure under “future work.”

## Operator Commands

Provide exact commands for:

```text
setup
doctor
run in development
build local Windows package
run tests
run GPU smoke
run benchmark
repair runtime
remove runtime/models
```

## Final Assurance

State:

- whether raw transcript is preserved separately from notes;
- whether every rendered note claim is evidence-linked;
- whether existing live dictation remained unchanged;
- whether cloud fallback is disabled by default;
- whether there were commits/pushes/releases/security scans;
- exact files the user should inspect first.
