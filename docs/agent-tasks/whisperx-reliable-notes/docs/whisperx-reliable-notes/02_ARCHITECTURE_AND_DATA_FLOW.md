# 02 — Architecture and Data Flow

## 1. Existing Integration Points to Verify

The current upstream/fork likely contains paths similar to:

```text
src/components/notes/UploadAudioView.tsx
src/stores/batchQueueStore.ts
src/services/fileTranscription.ts
src/stores/settingsStore.ts
src/stores/actionProcessingStore.ts
src/components/notes/PersonalNotesView.tsx
src/types/electron.ts
src/helpers/ipcHandlers.js
src/helpers/database.js
src/helpers/whisper.js
src/helpers/parakeet.js
src/helpers/modelManagerBridge.js
preload.js
scripts/
resources/bin/
```

These are reconnaissance targets, not guaranteed final paths. Codex must locate the current equivalent and preserve existing contracts.

## 2. Target Components

```text
Renderer
  ├─ Upload profile/settings UI
  ├─ Batch queue/progress UI
  ├─ Transcript and audio review UI
  ├─ Speaker rename/correction UI
  └─ Notes/evidence UI
       │ narrow IPC
Preload bridge
       │
Electron main
  ├─ RecordingJobManager
  ├─ WhisperXRuntimeManager
  ├─ WhisperXProcessManager
  ├─ GpuInferenceCoordinator
  ├─ ArtifactStore
  ├─ RecordingJobRepository
  ├─ SecureTokenStore
  ├─ NoteCompilationCoordinator
  └─ Diagnostics/doctor
       │ JSONL stdin/stdout
Python 3.12 worker
  ├─ Audio probe/normalization orchestration
  ├─ WhisperX ASR
  ├─ Alignment
  ├─ Pyannote diarization
  ├─ Canonical transcript builder
  ├─ Artifact writers
  └─ Structured progress/error events
       │
Managed local storage
  ├─ runtime and model caches
  ├─ job temp directories
  ├─ finalized artifacts
  └─ SQLite metadata
```

## 3. Proposed Repository Additions

Adapt naming to existing conventions.

```text
src/helpers/whisperxRuntimeManager.js
src/helpers/whisperxProcessManager.js
src/helpers/gpuInferenceCoordinator.js
src/helpers/recordingJobManager.js
src/helpers/recordingArtifactStore.js
src/helpers/secureModelTokenStore.js

src/services/whisperx/
  contracts.ts
  profiles.ts
  transcriptValidation.ts
  noteEvidenceValidation.ts
  noteChunker.ts
  noteMerge.ts
  noteRenderer.ts

src/components/notes/
  WhisperXSettings.tsx
  RecordingJobProgress.tsx
  RecordingTranscriptView.tsx
  RecordingAudioPlayer.tsx
  RecordingArtifactsView.tsx
  EvidenceCitation.tsx

tools/whisperx-sidecar/
  pyproject.toml
  uv.lock
  README.md
  src/openwhispr_whisperx/
    __init__.py
    worker.py
    protocol.py
    schemas.py
    pipeline.py
    audio.py
    transcript.py
    artifacts.py
    errors.py
  tests/

scripts/
  setup-whisperx.js
  doctor-whisperx.js
  download-uv.js
```

Do not create duplicate abstraction layers when the repository already has a suitable manager or registry.

## 4. Runtime Provisioning

### Preferred design

Use a managed, app-specific runtime rather than relying on the user's global Python environment.

```text
<userData>/runtimes/whisperx/<runtime-version>/
<userData>/models/whisperx/
<userData>/recording-jobs/
```

A robust implementation can use a pinned `uv` binary to provision Python 3.12 and sync from the committed `uv.lock`.

Requirements:

- verify downloaded runtime/tool checksums;
- store version sentinel and lock hash;
- do not mutate system Python;
- support repair and uninstall;
- support developer override through an explicit environment variable;
- ensure packaged Windows builds can locate the provisioning script/assets;
- avoid provisioning during ordinary app startup without explicit user action.

If the repo's current packaging constraints make managed Python impossible in one pass, implement a complete external-Python path plus deterministic setup/doctor and leave managed packaging clearly isolated—not silently omitted.

## 5. Sidecar Lifecycle

### One job per process initially

Prefer isolation and deterministic GPU release:

```text
spawn worker
send exactly one versioned request
read JSONL events
persist artifacts
worker exits
verify exit code and completion event
```

A persistent warm worker may be considered later only after process-per-job behavior is reliable.

### Spawn rules

- `shell: false`;
- executable path from trusted runtime manager;
- no user-controlled command string;
- working directory under trusted runtime/job path;
- restrictive environment allowlist;
- Hugging Face token supplied through environment only to the worker and removed from logs;
- stdout reserved for JSONL protocol;
- stderr captured, redacted, size-capped, and stored only in content-safe diagnostics;
- process handle registered with a Windows process-tree cancellation mechanism;
- timeout/watchdog per stage with heartbeat support.

## 6. JSONL Communication

Main writes one request line:

```json
{"type":"request","protocolVersion":1,"job":{...}}
```

Worker emits:

```json
{"type":"ready","protocolVersion":1,"workerVersion":"..."}
{"type":"stage","stage":"loading-asr","timestamp":"..."}
{"type":"progress","stage":"transcribing","completed":42,"total":100,"unit":"segments"}
{"type":"warning","code":"ALIGNMENT_PARTIAL","message":"...","details":{}}
{"type":"artifact","kind":"canonical-transcript","relativePath":"transcript.raw.json","sha256":"..."}
{"type":"complete","result":{...}}
```

Malformed lines are a protocol error. Do not attempt to parse arbitrary console text as JSON.

## 7. GPU Inference Coordinator

Implement a main-process coordinator shared by:

- WhisperX ASR/alignment/diarization;
- local llama.cpp note formatting;
- any existing GPU-backed local provider that can conflict.

Required behavior:

```text
queued → lease granted → model run → model unload → lease release
```

- one exclusive heavy GPU lease at a time;
- FIFO or documented priority;
- cancellation removes queued work;
- current holder has a deadline/heartbeat;
- local LLM is stopped or unloaded before WhisperX when necessary;
- note generation starts only after WhisperX worker exit and GPU release;
- lease state survives renderer navigation but not app restart;
- stale leases are cleared on process exit/startup recovery.

Do not rely only on UI disabling; enforce coordination in main process.

## 8. OOM Fallback

Default sequence:

```text
large-v3-turbo, float16, batch 4
→ same model, float16, batch 2
→ same model, int8, batch 4
→ same model, int8, batch 2
```

Critical profile:

```text
large-v3, float16, batch 2
→ large-v3, float16, batch 1
→ large-v3, int8, batch 2
→ large-v3-turbo, float16, batch 2 only with explicit warning/profile policy
```

Rules:

- unload model and clear CUDA cache before retry;
- retry only recognized CUDA OOM conditions;
- cap retries;
- persist the actual successful configuration;
- surface fallback use to the user;
- do not turn arbitrary exceptions into OOM retries.

## 9. Job State Machine

```text
created
→ queued
→ validating
→ preparing
→ transcribing
→ aligning
→ diarizing
→ canonicalizing
→ persisting
→ transcript_complete
→ note_extracting
→ note_validating
→ note_rendering
→ complete
```

Terminal alternatives:

```text
cancelled
failed
transcript_complete_note_failed
```

Persist state transitions transactionally. A renderer reload must recover current state from main/database.

## 10. Storage Layout

Use `app.getPath("userData")`, not a hard-coded `%LOCALAPPDATA%` string.

```text
<userData>/recording-jobs/<job-id>/
  .incomplete/
  job.json
  source-reference.json
  transcript.raw.json
  transcript.raw.txt
  transcript.speakers.md
  transcript.srt
  transcript.vtt
  note-extraction.json
  notes.md
  warnings.json
  manifest.json
```

Implementation detail:

1. write into `.incomplete` or a sibling temp directory;
2. fsync/close files where appropriate;
3. hash and validate required artifacts;
4. atomically rename/finalize;
5. update database state to complete only after finalize succeeds.

### External vs managed source

- External source: store path plus hash and metadata; never delete.
- URL download/in-app managed recording: move/copy into a managed source directory according to retention policy.
- A note citation must still work if an external source moves; transcript evidence remains valid, but audio playback may require relinking.

## 11. Database

Inspect existing migration conventions. Add the smallest compatible durable model.

Suggested entities:

```text
recording_jobs
recording_artifacts
note_generation_runs
speaker_name_mappings
transcript_revisions
```

Minimum job fields:

```text
id
status
source_type
source_display_name
source_path_or_managed_ref
source_sha256
profile
settings_json
protocol_version
transcript_schema_version
artifact_directory
created_at
started_at
completed_at
error_code
warning_json
```

Use normalized child tables only when consistent with the current database. JSON metadata is acceptable for extensible settings but not as a substitute for core queryable state.

## 12. Transcript Review

The viewer should:

- render segment timestamp, speaker label, text, and warning state;
- seek the audio player when a timestamp is clicked;
- allow generic speaker label renaming through a mapping layer;
- permit corrections as a new revision;
- preserve original text and show revision provenance;
- highlight evidence segments cited by the current note;
- avoid loading an enormous transcript into one DOM tree without virtualization where recordings are long.

## 13. Note Compilation Placement

Use the existing note-formatting inference scope/provider resolution. Add a dedicated orchestration layer that:

1. receives canonical segments;
2. chunks them;
3. runs schema-constrained extraction;
4. validates output;
5. deterministically merges;
6. optionally runs strict support verification;
7. renders Markdown in code;
8. saves extraction JSON and rendered content separately.

Do not bury evidence validation inside a UI component.

## 14. Packaging

The local Windows package must either:

- stage a verified runtime/provisioner and sidecar source/lock, then provision models on demand; or
- clearly detect an external managed runtime installed by a documented command.

The packaged app must not assume the repository working directory exists.

Update all relevant build inclusion/unpack patterns so:

- runtime executables are outside ASAR where required;
- sidecar source/lock is accessible;
- FFmpeg path works;
- no secret or model token is packaged;
- model caches remain user-local.
