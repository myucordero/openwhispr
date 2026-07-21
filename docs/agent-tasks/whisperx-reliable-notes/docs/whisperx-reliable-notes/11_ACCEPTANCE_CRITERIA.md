# 11 — Acceptance Criteria

Codex must mark each item **PASS**, **FAIL**, **BLOCKED**, or **NOT APPLICABLE**, with evidence.

## A. Repository and Compatibility

- [ ] Existing agent instructions were followed.
- [ ] Unrelated user changes were preserved.
- [ ] Current Node/toolchain policy was verified.
- [ ] Existing dictation providers still work in tests/smoke checks.
- [ ] Existing cloud/BYOK behavior was not silently changed.
- [ ] No broad unrelated refactor was introduced.
- [ ] No commit/push/release/security scan occurred unless explicitly authorized and reported.

## B. Runtime and Setup

- [ ] Python 3.12 runtime is pinned/reproducible.
- [ ] WhisperX dependency is pinned and locked.
- [ ] Setup/repair/uninstall behavior exists.
- [ ] Runtime/model directories are app-specific.
- [ ] Doctor verifies Python, Torch, CUDA, GPU/VRAM, FFmpeg, storage, sidecar, models, and offline state.
- [ ] Packaged mode does not rely on repository-relative paths.
- [ ] Token-gated diarization setup is documented and secure.
- [ ] No token is exposed to renderer, CLI args, logs, or artifacts.

## C. Provider and Processing

- [ ] `whisperx` is available for uploaded/recorded files.
- [ ] Live dictation remains on existing low-latency engines.
- [ ] Memo, Meeting, and Critical/Interview profiles exist.
- [ ] Auto/Spanish/English language selection exists.
- [ ] Alignment control exists.
- [ ] Diarization and speaker-count controls exist.
- [ ] Custom dictionary feeds safe hotwords/context.
- [ ] Real stage progress is shown.
- [ ] Batch jobs run sequentially.
- [ ] GPU-heavy stages are serialized.
- [ ] Real process-tree cancellation works.
- [ ] Worker crash/timeout leaves a retryable non-complete job.
- [ ] OOM fallback is deterministic, capped, recorded, and visible.

## D. Transcript and Artifacts

- [ ] Source SHA-256 is recorded.
- [ ] Canonical transcript JSON schema validates.
- [ ] Stable segment IDs exist.
- [ ] Word/segment timestamps are preserved when available.
- [ ] Generic speaker labels are preserved.
- [ ] Raw TXT exists.
- [ ] Speaker/timestamp Markdown exists when applicable.
- [ ] SRT and VTT exist when timestamps are available.
- [ ] Model/runtime/settings provenance exists.
- [ ] Required artifacts are hashed.
- [ ] Finalization is atomic.
- [ ] Failed/cancelled partial output cannot appear complete.
- [ ] Completed jobs reopen after restart.
- [ ] External source is never deleted.
- [ ] Retention/delete/storage controls exist.
- [ ] Speaker rename does not mutate canonical transcript.
- [ ] Manual correction creates a traceable revision.

## E. Reliable Notes

- [ ] Transcript is chunked by complete segments.
- [ ] Note extraction returns structured JSON.
- [ ] Every substantive item has evidence IDs.
- [ ] Unknown evidence IDs are rejected.
- [ ] Quotes are validated against cited text.
- [ ] Owners are null unless explicit.
- [ ] Due dates are null unless explicit.
- [ ] Decisions are distinct from proposals/questions.
- [ ] Disagreement and uncertainty are preserved.
- [ ] Transcript prompt injection does not override compiler rules.
- [ ] Merge is deterministic.
- [ ] Markdown rendering is deterministic.
- [ ] Every rendered claim has a timestamp/evidence citation.
- [ ] Notes remain separate from raw transcript.
- [ ] Notes regenerate without ASR.
- [ ] Evidence links seek/highlight supporting transcript/audio.
- [ ] Strict support verification exists or a documented, tested equivalent meets the same requirement.

## F. Security and Privacy

- [ ] IPC is narrow and runtime-validated.
- [ ] Subprocesses use `shell:false`.
- [ ] Renderer cannot choose arbitrary executable/output paths.
- [ ] Path traversal/absolute/device/ADS cases are rejected.
- [ ] Symlink/reparse escape is mitigated and tested.
- [ ] Diagnostics are content-safe and size-capped.
- [ ] Network is not required after provisioning.
- [ ] Cloud fallback is never automatic.
- [ ] Source audio/transcript/notes are absent from default telemetry/logs.
- [ ] Model/runtime downloads are pinned/verified as practical.
- [ ] Temp files clean up after success, failure, cancel, and restart.
- [ ] External source delete protection is tested.

## G. Tests

- [ ] Baseline failures were recorded.
- [ ] New JS/TS unit tests pass.
- [ ] New Python tests pass.
- [ ] Cross-language contract tests pass.
- [ ] Fake-worker integration tests pass.
- [ ] Database migration tests pass.
- [ ] Evidence validation/rendering tests pass.
- [ ] Security boundary tests pass.
- [ ] Lint/typecheck pass.
- [ ] Build passes.
- [ ] Local doctor passes.
- [ ] Windows package/unpacked verification passes or is explicitly blocked.
- [ ] Real CUDA smoke passes or is explicitly blocked.
- [ ] Real diarization smoke passes or is explicitly blocked.
- [ ] Offline smoke passes or is explicitly blocked.

## H. Benchmark and Documentation

- [ ] Benchmark harness produces JSON/CSV/Markdown.
- [ ] WER/CER tests exist.
- [ ] Proper noun/number/date metrics exist.
- [ ] Note grounding/coverage metrics exist.
- [ ] Performance metrics include RTF and fallback attempts.
- [ ] Setup documentation is updated.
- [ ] Privacy/retention documentation is updated.
- [ ] Troubleshooting is updated.
- [ ] License/model terms are documented.
- [ ] `TASK_TRACKER.md` is complete.
- [ ] Final report follows the required template.

## Completion Rule

The task is not complete with a UI mock, a CLI-only prototype, or an untested sidecar.

A blocked real GPU/pyannote/package check does not invalidate all implementation, but it must be marked **BLOCKED**, with all deterministic code/tests completed and exact manual commands supplied.
