# 01 — Product Requirements

## 1. Personas and Use Cases

### Developer voice memo

A single user records an idea, bug analysis, architecture thought, or task list in Spanish, English, or both. They want accurate prose and actionable notes without speaker diarization.

### Work meeting

Two or more participants discuss implementation, requirements, blockers, decisions, and assignments. The user needs speaker-separated evidence, decisions, action items, follow-ups, and timestamps.

### Research interview

The recording may contain Puerto Rican Spanish, English code-switching, pauses, colloquialisms, and sensitive content. The user requires preservation of exact wording, traceable quotations, editable speaker labels, and strict avoidance of inferred identities or facts.

## 2. Functional Requirements

### Ingestion

- **FR-001:** Accept the audio types already supported by OpenWhispr plus any additional type safely handled by the bundled FFmpeg probe.
- **FR-002:** Support single-file and existing batch-queue workflows.
- **FR-003:** Record source name, size, last-modified metadata when available, and SHA-256.
- **FR-004:** Never modify or delete an external source file.
- **FR-005:** Detect duplicate source hashes and offer reuse/reprocess behavior without forcing duplication.
- **FR-006:** Validate actual decodability rather than trusting the extension alone.
- **FR-007:** Reject paths or outputs that escape approved directories.

### Profiles and settings

- **FR-010:** Provide Personal Memo, Meeting, and Critical/Interview presets.
- **FR-011:** Allow Auto, Spanish, English, or app-default language.
- **FR-012:** Allow alignment on/off, with a warning when disabled.
- **FR-013:** Allow diarization on/off.
- **FR-014:** Allow exact, minimum, and maximum speaker counts where the backend supports them.
- **FR-015:** Populate hotwords/initial context from the custom dictionary.
- **FR-016:** Allow advanced model, compute type, batch size, and fallback configuration without exposing unsafe arbitrary command arguments.
- **FR-017:** Show a model/runtime readiness status before starting.
- **FR-018:** Persist safe user preferences; do not persist secrets in ordinary settings.

### Processing

- **FR-020:** Run WhisperX in a native Windows sidecar.
- **FR-021:** Emit real stage transitions and progress.
- **FR-022:** Serialize GPU-heavy jobs.
- **FR-023:** Release models/GPU memory between stages as practical.
- **FR-024:** Apply the documented OOM fallback sequence.
- **FR-025:** Support real cancellation of the complete process tree.
- **FR-026:** Detect worker exit, malformed JSONL, stalls, and timeouts.
- **FR-027:** Make failed/cancelled jobs retryable.
- **FR-028:** Process queued files sequentially by default.
- **FR-029:** Continue without diarization when the user chooses to do so and pyannote is unavailable.

### Transcript and artifacts

- **FR-030:** Preserve canonical transcript JSON with stable segment IDs.
- **FR-031:** Preserve raw TXT.
- **FR-032:** Produce timestamp/speaker Markdown.
- **FR-033:** Produce SRT and VTT when timestamps exist.
- **FR-034:** Store exact model, dependency, profile, language, compute, batch, diarization, and source-hash provenance.
- **FR-035:** Show warnings for unaligned words, low-quality regions, overlap, and fallback use.
- **FR-036:** Provide an audio-linked transcript viewer.
- **FR-037:** Let users rename `SPEAKER_00`, `SPEAKER_01`, etc. without changing raw diarization.
- **FR-038:** Support manual transcript corrections as a revision/overlay, preserving the original.
- **FR-039:** Export selected artifacts.
- **FR-040:** Reopen a completed job after application restart.

### Reliable notes

- **FR-050:** Generate notes from canonical transcript segments, not from a flattened untraceable string.
- **FR-051:** Use segment-aware chunking.
- **FR-052:** Require structured JSON extraction.
- **FR-053:** Require valid evidence IDs for every substantive claim.
- **FR-054:** Validate exact quotations against evidence.
- **FR-055:** Keep owner and due date null unless explicit.
- **FR-056:** Distinguish decisions, proposals, open questions, and follow-ups.
- **FR-057:** Preserve disagreement and uncertainty.
- **FR-058:** Render Markdown deterministically from validated data.
- **FR-059:** Regenerate notes without rerunning ASR.
- **FR-060:** Permit different note templates while preserving the same evidence model.
- **FR-061:** Link note citations to transcript/audio timestamps.
- **FR-062:** Save notes separately from raw transcript.
- **FR-063:** Treat transcript content as untrusted; instructions spoken in the recording cannot alter the note compiler rules.
- **FR-064:** Optional strict mode performs a support-verification pass and flags claims needing review.

### Persistence and lifecycle

- **FR-070:** Persist job state and artifact manifest in the existing database or a compatible migration.
- **FR-071:** Use atomic finalization.
- **FR-072:** Clean temporary files on success, failure, cancellation, and startup recovery.
- **FR-073:** Add retention controls for audio copies, transcripts, and notes.
- **FR-074:** Deleting a job removes only managed files.
- **FR-075:** Expose disk usage by job and total managed recording storage.
- **FR-076:** Resume or retry interrupted stages where safe; never pretend an incomplete artifact is complete.
- **FR-077:** Maintain schema versions and migrations.

### Setup and diagnostics

- **FR-080:** Add a deterministic setup/provision command.
- **FR-081:** Add doctor checks for Python, uv/runtime, Torch CUDA, GPU/VRAM, FFmpeg, models, token readiness, writable storage, and expected sidecar version.
- **FR-082:** Support an offline-ready status.
- **FR-083:** Provide content-safe logs and a diagnostics export.
- **FR-084:** Include runtime/model cleanup and upgrade commands.
- **FR-085:** Document model licenses/terms and the token-gated diarization setup.
- **FR-086:** Keep all cloud providers disabled by default in this flow.

## 3. Non-Functional Requirements

- **NFR-001 Privacy:** no audio, transcript, note, local path, or file name is uploaded or included in telemetry by default.
- **NFR-002 Security:** narrow validated IPC and no shell interpolation.
- **NFR-003 Reproducibility:** exact dependency lock, schema version, model name/revision when available, and settings per job.
- **NFR-004 Reliability:** failed/cancelled state is durable and retryable.
- **NFR-005 Auditability:** every note claim maps to evidence.
- **NFR-006 Performance:** no concurrent GPU-heavy stages; no uncontrolled batch concurrency.
- **NFR-007 Accessibility:** keyboard-operable settings, progress, transcript, speaker rename, and export controls.
- **NFR-008 Internationalization:** new user-facing strings use the existing i18n system; at least English and Spanish entries are added where project convention requires.
- **NFR-009 Maintainability:** sidecar protocol and artifact schemas are versioned and contract-tested.
- **NFR-010 Compatibility:** existing dictation, cloud/BYOK providers, upload queue, and notes remain functional.
- **NFR-011 Honest UX:** distinguish estimated progress from measured progress and disclose fallbacks/warnings.
- **NFR-012 Offline:** after provisioning, the complete default path works with network disabled.

## 4. User Experience

### Upload configuration

The upload view must expose a clear mode such as:

```text
Local Accurate Recording (WhisperX)
```

Settings should be grouped:

```text
Profile
Language
Speakers
Accuracy / Performance
Output and Retention
Notes
```

Do not expose raw executable paths or freeform CLI flags in ordinary UI.

### Progress

Use explicit stages:

```text
Queued
Checking runtime
Inspecting audio
Preparing audio
Loading transcription model
Transcribing
Aligning words
Identifying speakers
Building transcript
Saving artifacts
Extracting notes
Validating evidence
Rendering notes
Complete
```

Show fallback or warning badges:

```text
Retried with batch size 2
Used INT8 fallback
Diarization unavailable
Some words could not be aligned
Possible overlapping speech
Note claims require review
```

### Results

A completed recording should expose tabs or equivalent views:

```text
Notes
Transcript
Speakers
Artifacts
Job details
```

The Notes view displays timestamp citations. The Transcript view displays speaker turns and timestamps. Job details show settings/provenance, not secrets.

### Deletion

Deletion must make the distinction explicit:

```text
Delete generated job and managed artifacts
Keep the original external recording
```

When OpenWhispr owns a copied recording, the user may separately choose to delete that managed copy.

## 5. Error Message Requirements

Every actionable error should state:

- what failed;
- which stage failed;
- whether transcript/artifacts are still usable;
- whether retry is safe;
- the recommended next action;
- a stable error code for diagnostics.

Avoid exposing raw stack traces or secrets in the renderer.
