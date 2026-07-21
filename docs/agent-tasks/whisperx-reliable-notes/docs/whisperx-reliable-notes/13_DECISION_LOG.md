# 13 — Decision Log

## Locked Decisions

### D-001 — WhisperX is for accurate recordings

Use WhisperX for uploaded or file-backed recordings. Do not replace hotkey/live dictation with WhisperX.

### D-002 — Native Windows runtime

The shipped integration uses native Windows paths/processes/CUDA, not WSL.

### D-003 — Python 3.12

Use a pinned Python 3.12 runtime. Prefer an app-managed environment through pinned `uv`.

### D-004 — Pinned WhisperX

Begin with `whisperx==3.8.6` and lock dependencies. Change only with demonstrated compatibility evidence.

### D-005 — Default models

- default: `large-v3-turbo`;
- critical/interview: `large-v3`.

### D-006 — Sequential GPU use

WhisperX ASR/alignment/diarization and local llama.cpp note generation run sequentially through a main-process coordinator.

### D-007 — JSONL stdio

Use versioned JSON Lines over stdin/stdout. Do not introduce an unauthenticated localhost server.

### D-008 — Process-per-job initially

Favor isolation, cancellation, and GPU release over warm-worker latency until reliability is proven.

### D-009 — Raw transcript immutability

Raw/canonical transcript is never overwritten by cleanup, speaker renaming, manual correction, or note generation.

### D-010 — Evidence-bound notes

Every substantive rendered claim must cite canonical transcript segment IDs/timestamps.

### D-011 — Deterministic rendering

The LLM extracts structured evidence. Application code validates, merges, and renders Markdown.

### D-012 — No identity inference

Diarization labels speakers; it does not identify people. Names are manual mappings.

### D-013 — No inferred owner/date

Action owner and due date are null unless explicitly supported by evidence.

### D-014 — Local first/offline after provisioning

No automatic cloud fallback. Missing local assets produce a clear setup error.

### D-015 — Secure token storage

HF token uses Electron secure storage, never CLI args or tracked files.

### D-016 — Existing repository patterns first

Reuse existing settings/provider/database/IPC/build abstractions where safe. Avoid parallel architecture.

## Assumptions Codex Must Verify

### A-001 — Current file locations

Paths named in this package reflect known upstream structure but may differ in the fork.

### A-002 — Node version

The supplied local setup says Node 22. Newer upstream may require Node 24. Current repo/CI/lockfile decide.

### A-003 — GPU VRAM

WMI reports 4 GB, but an RTX 4060 Laptop GPU is commonly an 8 GB-class device. `nvidia-smi` and Torch runtime values decide.

### A-004 — Existing local LLM lifecycle

The repository may already have a model manager that can stop/unload llama.cpp. Integrate rather than duplicate.

### A-005 — Existing diarization

OpenWhispr may have a sherpa-onnx local diarization path. Determine whether it can serve as a fallback for structured WhisperX segments.

### A-006 — Packaging constraints

Determine whether the local Windows package can stage a pinned uv/provisioner or must require a separately provisioned runtime.

### A-007 — Database migration framework

Use current migration/SQLite conventions.

## Rejected Alternatives

### R-001 — One-pass “summarize transcript”

Rejected because it lacks evidence traceability and increases hallucination risk.

### R-002 — Replace all local transcription with WhisperX

Rejected because dictation latency and recording accuracy are different workloads.

### R-003 — Run ASR and local note LLM concurrently

Rejected because the target RTX 4060 has limited VRAM.

### R-004 — Put token in `.env` or command arguments

Rejected due to leakage risk.

### R-005 — Store only flattened text

Rejected because word/segment timestamps, quality flags, and evidence references are lost.

### R-006 — Automatically identify speakers by voice

Rejected due to privacy, biometric, and accuracy concerns.

### R-007 — WSL runtime in packaged app

Rejected due to path, lifecycle, deployment, and user-experience complexity.

### R-008 — Silent cloud fallback

Rejected because it violates local-first privacy and honest UX.

## Implementation Decisions to Record

Codex should append dated entries for:

```text
actual Node version resolution
actual WhisperX/torch lock
managed runtime mechanism
diarization fallback behavior
artifact/database schema adaptation
GPU coordinator integration
process-tree cancellation implementation
packaging inclusion/provisioning
benchmark-selected defaults
```

Use:

```markdown
### D-1XX — Title

**Date:** YYYY-MM-DD  
**Status:** accepted / superseded  
**Decision:** ...  
**Evidence:** files, tests, commands  
**Consequences:** ...
```

---

## Recorded Implementation Decisions

### D-101 — Node version resolution: Node 24

**Date:** 2026-07-16  
**Status:** accepted  
**Decision:** Node 24 is the authoritative toolchain (A-002 resolved). All repo commands in this work run via `nvm exec 24` (v24.14.1). No toolchain migration is performed.  
**Evidence:** `.nvmrc` = 24; `package.json` engines `>=24`; `release.yml` and all build jobs pin node-version 24. Pre-existing inconsistency left untouched: `build-and-notarize.yml` verify job pins 22.  
**Consequences:** Package reference docs mentioning Node 22 are stale and ignored. `package-lock.json` is only ever touched under Node 24.

### D-102 — No pre-existing batch queue; implement minimal sequential job queue

**Date:** 2026-07-16  
**Status:** accepted  
**Decision:** FR-002's "existing batch-queue workflows" do not exist in this fork (verified: no queue/batch code anywhere; upload is single-file synchronous). A minimal sequential FIFO job queue is implemented inside the new main-process RecordingJobManager rather than adapting a nonexistent store.  
**Evidence:** recon of `src/components/notes/UploadAudioView.tsx`, `ipcHandlers.js` `transcribe-audio-file`; repo-wide grep for queue/batch.  
**Consequences:** Multi-file selection enqueues jobs processed one at a time (satisfies FR-028); no renderer-side queue store is created.

### D-103 — GPU/VRAM confirmed 8 GB class (A-003 resolved)

**Date:** 2026-07-16  
**Status:** accepted  
**Decision:** Treat the RTX 4060 Laptop GPU as 8 GB VRAM. WMI's 4 GB value is wrong.  
**Evidence:** `nvidia-smi` (WSL): 8188 MiB total / 7926 MiB free, driver 595.79.  
**Consequences:** OOM ladder and 16K-context note-model defaults from spec 08 stand unchanged.

### D-104 — Existing sherpa-onnx diarization is the "openwhispr-local" fallback (A-005 resolved)

**Date:** 2026-07-16  
**Status:** accepted  
**Decision:** The existing `src/helpers/diarization.js` (sherpa-onnx-diarize + pyannote segmentation-3-0 + campplus, meeting-only today) is a viable documented fallback diarization provider for WhisperX jobs when pyannote Community-1 is not provisioned. The primary path remains pyannote inside the Python worker (pre-merged speaker segments; upload files have no mic/system dual-stream bleed, so the meeting merge heuristics are unnecessary).  
**Evidence:** recon of `diarization.js` (`diarize()`, `mergeWithTranscript()`, `capSpeakerClusters()`), `scripts/download-diarization-models.js`.  
**Consequences:** Diarization provider enum keeps both `pyannote-community-1` and `openwhispr-local`; the local fallback path adapts `DiarizationManager.diarize()` output onto canonical WhisperX segments.

### D-105 — Note compiler orchestration lives in Electron main; local JSON mode added to llama path

**Date:** 2026-07-16  
**Status:** accepted  
**Decision:** NoteCompilationCoordinator runs in the main process, calling the live local-LLM bridge (`localReasoningBridge` → `modelManagerBridge` → `llamaServer`) directly. The renderer resolves provider/model via the existing `noteFormatting` inference scope (`selectResolvedLLMConfig`) and passes the resolved config through IPC. `llamaServer.inference()` gains an optional `responseFormat`/JSON-schema pass-through (llama-server supports OpenAI-style `response_format`), threaded through the bridge options. The dead legacy stack (`LocalReasoningService.ts`, `ModelManager.ts` TS, `InferenceConfig.ts`) is not used.  
**Evidence:** recon: no `response_format` support anywhere today; renderer-side ReasoningService registry exists but evidence validation must not live in UI (spec 02 §13).  
**Consequences:** Deterministic validation/merge/render happen in main-process code with tests; llama idle auto-stop (5 min) is handled by the GPU coordinator holding/releasing the note-model lease.

### D-107 — Source-audio playback via bounded jobId-keyed IPC

**Date:** 2026-07-17  
**Status:** accepted  
**Decision:** FR-036 playback reads the external source through `whisperx-read-source-audio(jobId)`: main resolves the path from the job row (renderer never supplies paths), caps reads at 300 MB, returns a typed buffer rendered as a Blob URL. No new listening port, no custom protocol.  
**Consequences:** Very large sources degrade to "audio preview unavailable" while the transcript stays fully usable.

### D-108 — Reliable notes are local-only in v1

**Date:** 2026-07-17  
**Status:** accepted  
**Decision:** The note compiler accepts only `provider: "local"` (llama.cpp route). The renderer resolves the existing `noteFormatting` scope at submit time and passes `{provider, model, disableThinking}` into the job; regeneration passes a fresh config. Jobs without a local config rest at `transcript_complete` (no failure). Cloud note generation is intentionally not wired (spec 00: cloud only by deliberate choice; deferred).  
**Consequences:** `NOTE_MODEL_UNAVAILABLE` guides the user to pick a local model; `modelManagerBridge.runInference` gained a `maxTokens` pass-through (default 512 would truncate extraction output).

### D-109 — GPU sequencing implementation

**Date:** 2026-07-17  
**Status:** accepted  
**Decision:** The llama.cpp server is stopped before each WhisperX job (in the trusted `resolveRuntime` hook) and note generation holds the exclusive GPU lease with heartbeat touches per LLM call. Known limitation: the app's *other* llama consumers (dictation cleanup, chat) do not acquire the coordinator lease — they predate it; a concurrent manual cleanup during ASR could still contend. Documented as remaining risk, not silently claimed solved.  
**Consequences:** Sequential heavy stages per spec 08 §4 for the recording pipeline itself.

### D-110 — Notes surface as a regular OpenWhispr note row

**Date:** 2026-07-17  
**Status:** accepted  
**Decision:** After rendering, notes.md is additionally saved via `databaseManager.saveNote(title, markdown, "whisperx-recording", sourceName)` and the note run records `note_id` — notes appear in the normal notes list while artifacts remain canonical in the job directory.  
**Consequences:** Note-row failure downgrades to a warning; artifacts are the source of truth.

### D-111 — Packaging: sidecar source + lock staged via extraResources

**Date:** 2026-07-17  
**Status:** accepted  
**Decision:** `tools/whisperx-sidecar` (pyproject, uv.lock, src, README — excluding tests/venv/caches) is staged to `resources/whisperx-sidecar` through the electron-builder `extraResources` allowlist, matching `whisperxMain`'s packaged path. The Python runtime itself is provisioned on the user machine by pinned uv (never bundled). NSIS uninstall removes the managed runtime and model caches but preserves `recording-jobs`.  
**Consequences:** A-006 resolved as "stage provisioner inputs, provision on demand"; packaged verification itself requires the Windows clone.

### D-112 — Windows CUDA torch via explicit cu128 index

**Date:** 2026-07-17  
**Status:** accepted  
**Decision:** torch/torchaudio are declared as direct sidecar dependencies and steered to `download.pytorch.org/whl/cu128` on win32 through `tool.uv.sources`; Linux/macOS keep PyPI. `uv.lock` regenerated (dual-source 2.8.0 / 2.8.0+cu128).  
**Evidence:** native-Windows provisioning resolved `torch 2.8.0+cpu` (doctor WARN "CUDA unavailable — CPU fallback"); PyPI win32 torch wheels are CPU-only while Linux PyPI wheels bundle CUDA. After the fix the native doctor reports CUDA on the RTX 4060.  
**Consequences:** This is the D-004-sanctioned kind of pinned-dependency change, recorded here with the compatibility evidence.

### D-106 — New tests go under tests/**/*.test.cjs

**Date:** 2026-07-16  
**Status:** accepted  
**Decision:** All new JS/TS tests are placed under `tests/` matching the `npm test` glob (`node --test "tests/**/*.test.cjs"`). The orphaned `test/helpers/*.test.js` tree (not matched by the glob, not in CI) is left as-is and reported.  
**Evidence:** `package.json` test script; recon of both test trees.  
**Consequences:** New sidecar/contract/evidence tests actually run in `npm test` and CI.
