# 00 — Master Implementation Specification

## 1. Objective

Add a local, high-accuracy recording workflow to OpenWhispr that converts existing audio into:

1. a reproducible, structured WhisperX transcript;
2. word/segment timestamps and optional speaker labels;
3. human-reviewable transcript artifacts;
4. evidence-grounded Markdown notes;
5. persistent job metadata sufficient to reproduce, audit, retry, delete, or regenerate outputs.

The feature complements the app's existing low-latency dictation and meeting functionality. It does not replace live dictation.

## 2. Problem Statement

The current local Whisper/Parakeet workflow is useful for dictation but may produce rough text, especially for accents, bilingual speech, domain-specific terms, long recordings, multiple speakers, and overlapping turns. Existing file transcription may flatten speaker information and discard the structured evidence needed to produce trustworthy notes.

A reliable notes pipeline requires more than ASR. It needs:

- canonical transcript structure;
- alignment and speaker information;
- immutable raw evidence;
- explicit model/settings provenance;
- claim-to-segment traceability;
- strict handling of unknown owners, dates, and identities;
- deterministic validation and rendering;
- review and correction tools.

## 3. Target User Outcomes

The user can:

- select one or multiple audio files;
- choose Personal Memo, Meeting, or Critical/Interview profile;
- choose Auto, Spanish, or English;
- enable/disable diarization and provide exact/min/max speaker counts;
- see real stages and progress;
- cancel or retry safely;
- inspect raw, timestamped, and speaker-labeled transcripts;
- rename generic speaker labels manually;
- generate notes locally;
- click a note citation to inspect the supporting transcript/audio;
- regenerate notes with a different template/model without retranscribing;
- export transcript JSON/TXT/Markdown/SRT/VTT and notes Markdown/JSON;
- delete managed artifacts without deleting an external source file;
- run entirely offline after runtime/model provisioning.

## 4. Scope

### In scope

- Existing local audio file ingestion and batch queue.
- Optional in-app recordings already persisted as files.
- Windows-native WhisperX sidecar.
- Python 3.12 managed/reproducible environment.
- faster-whisper ASR through WhisperX.
- alignment when supported.
- pyannote Community-1 diarization when provisioned.
- existing OpenWhispr local diarization as a documented fallback where feasible.
- versioned JSONL worker protocol.
- artifact persistence and database job metadata.
- evidence-bound note extraction and deterministic rendering.
- local LLM via existing note-formatting scope.
- model/hotword/language/profile controls.
- cancellation, retry, OOM fallback, crash recovery, retention, diagnostics.
- tests, benchmark harness, setup/docs, and Windows packaging support.

### Out of scope

- Replacing current hotkey/live dictation engines with WhisperX.
- Cloud-first transcription or notes.
- Automatic participant identity or voice biometric recognition.
- Hidden upload of recordings or transcript content.
- Legal certification of transcript accuracy.
- A broad rewrite of OpenWhispr's notes, settings, database, or IPC architecture.
- Production distribution signing or public release unless separately requested.
- Mobile support.
- Real-time WhisperX streaming.
- Automatic translation as part of the canonical transcript.
- Destructive cleanup of external user files.

## 5. Locked Defaults

| Area | Default |
|---|---|
| Platform | Native Windows |
| Python | 3.12, pinned |
| WhisperX | Begin with `3.8.6`, lock after compatibility test |
| Default ASR | `large-v3-turbo` |
| Critical ASR | `large-v3` |
| Compute | CUDA `float16` |
| Default batch | 4 |
| Critical batch | 2 |
| Alignment | On |
| Diarization | Off for memo; on for meeting/interview |
| Diarization | `pyannote/speaker-diarization-community-1` when available |
| Note model | Existing local llama.cpp route; target Qwen3.5 9B Q4_K_M |
| Note context | Start at 16K runtime context; chunk long transcripts |
| Note temperature | 0.0–0.1 |
| Note thinking | Disabled |
| GPU concurrency | One heavy stage at a time |
| Storage | Electron `userData` job directory |
| Runtime network | None after provisioning |
| Speaker identity | Generic labels until manually renamed |

Codex may alter a default only after verifying an actual repository/runtime incompatibility and recording the evidence in the decision log.

## 6. Required Pipeline

```text
Audio file
  ↓
safe file probe + source hash + disk-space check
  ↓
temporary normalized audio, when required
  ↓
WhisperX ASR
  ↓
word/segment alignment
  ↓
optional diarization
  ↓
canonical transcript validation
  ↓
atomic artifact persistence
  ↓
segment-aware note extraction
  ↓
evidence validation + deterministic merge
  ↓
deterministic Markdown rendering
  ↓
OpenWhispr note, transcript viewer, exports
```

## 7. Canonical Evidence Rule

The canonical transcript is the only factual source for generated notes. Manual user notes may be included as a separately labeled source, but they must never be silently blended with ASR evidence.

Every substantive note item must carry:

- one or more stable transcript segment IDs;
- at least one timestamp;
- optional speaker ID;
- optional quality/review flags.

A freeform LLM response without valid evidence is not a completed note.

## 8. Data Separation

Maintain separate artifacts and persistence fields for:

```text
raw ASR output
canonical normalized transcript
speaker-name mapping
manual corrections
structured note extraction
rendered notes
optional enhanced/cleaned transcript
```

Never mutate the original canonical artifact when a speaker is renamed or text is manually corrected. Store corrections as a new revision or patch layer with provenance.

## 9. Required Failure Behavior

- Missing runtime: actionable setup state, no generic crash.
- Missing CUDA: offer CPU fallback only when explicitly supported and warn about speed; do not silently claim GPU use.
- Missing HF token/model acceptance: transcription can proceed without pyannote; diarization is blocked with a precise message.
- OOM: deterministic fallback sequence, model unload, retry, and clear warning.
- Worker crash: job remains failed/retryable with logs and partial artifacts quarantined.
- Cancellation: terminate process tree, mark cancelled, clean temp files, keep any previously finalized artifacts.
- Disk full: fail before destructive writes where possible.
- Unsupported/corrupt file: show probe/decoder error without passing unsafe input onward.
- Alignment unsupported for language: preserve ASR segments, mark alignment unavailable, continue according to profile policy.
- Note-schema failure: retry once with validation feedback; otherwise preserve transcript and expose note-generation error.
- Invalid evidence: reject claim or entire note run according to strictness; never silently remove citations while keeping unsupported text.

## 10. Definition of Complete

The feature is complete only when:

- all applicable acceptance criteria pass;
- tests cover success and failure paths;
- a fake-sidecar end-to-end flow is deterministic;
- a real GPU smoke test is run when the environment permits;
- local package/build flow includes or provisions required runtime components;
- raw transcript and notes remain distinct;
- evidence citations work end to end;
- no secret appears in logs or command lines;
- setup, diagnostics, retention, upgrade, and troubleshooting are documented;
- pre-existing failures and skipped checks are reported honestly.
