# WhisperX Reliable-Notes Implementation Tracker

Codex must keep this file current. Add concrete paths, command outputs, decisions, and blockers rather than checking boxes optimistically.

## 0. Repository Reconnaissance

- [x] Existing agent/repository instructions read (root CLAUDE.md, root AGENTS.md incl. dual-clone WSL/Windows workflow; no nested agent files found)
- [x] Initial branch, HEAD, and worktree state recorded below
- [x] Current Node/npm policy verified
- [x] Current upload and batch transcription call chain mapped
- [x] Current local Whisper/Parakeet provider registry mapped
- [x] Current diarization and merge flow mapped
- [x] Current note persistence/database schema mapped
- [x] Current note formatting/local LLM flow mapped
- [x] Current native binary/model provisioning mapped
- [x] Current Windows packaging flow mapped
- [x] Current tests and validation commands mapped
- [x] Baseline tests/lint/build executed and results recorded

### Reconnaissance Notes

```text
Branch: feat/whisperx-reliable-notes (created off dev @ b901c390; dev == origin/dev;
        dev is 25 ahead / 115 behind upstream/main, merge-base 5c1cf414 — intentional fork lag,
        no upstream merge mixed into this feature)
HEAD: b901c390414972121b8f55c5a163c485e22a7f24
Working tree: clean except untracked docs/agent-tasks/ (this package)
Node: 24 authoritative (.nvmrc=24, engines >=24, release.yml + all build jobs node-version 24).
      Local default node is v20; all repo commands run via `nvm exec 24` (v24.14.1, npm 11.11.0).
      Pre-existing inconsistency (NOT fixed, out of scope): build-and-notarize.yml `verify` job
      pins node-version "22" while every other job uses 24.
      Package reference docs saying Node 22 are stale — repo decides: Node 24.
npm: 11.11.0 (under nvm exec 24)
Python: 3.12.3 on WSL PATH; uv present at ~/.local/bin/uv
CUDA: nvidia-smi from WSL: RTX 4060 Laptop GPU, 8188 MiB total / 7926 MiB free, driver 595.79
      => A-003 resolved: 8 GB-class GPU (WMI 4 GB value wrong). Native-Windows CUDA checks
      remain to be run on the Windows clone (this WSL clone is for coding/tests per AGENTS.md).
App: open-whispr 1.7.2, Electron ^41.2.0, React 19, Vite 8, better-sqlite3.

Relevant paths (verified at this HEAD):
  Upload UI:        src/components/notes/UploadAudioView.tsx (state machine idle→selected→transcribing;
                    handleTranscribe branches cloud/local/BYOK; local => electronAPI.transcribeAudioFile)
  Upload IPC:       ipcHandlers.js "transcribe-audio-file" (~line 1456) — provider === "nvidia" ? parakeet : whisper;
                    NO batch queue exists anywhere; NO custom-dictionary prompt on upload path;
                    NO real local progress events; NO cancellation.
  Provider type:    src/types/electron.ts:1 LocalTranscriptionProvider = "whisper" | "nvidia";
                    settingsStore.ts:692 + :862 hardcoded ternaries coerce unknown values to "whisper";
                    UI tabs: TranscriptionModelPicker.tsx LOCAL_PROVIDER_TABS (~:211).
  Engines:          whisper.js/whisperServer.js (HTTP server sidecar); parakeet.js/parakeetServer.js/
                    parakeetWsServer.js (WS server sidecar).
  Diarization:      src/helpers/diarization.js (sherpa-onnx-diarize binary; pyannote segmentation-3-0 +
                    campplus ONNX via scripts/download-diarization-models.js) — MEETING-ONLY today;
                    mergeWithTranscript + capSpeakerClusters reusable concepts; => A-005 resolved:
                    viable "openwhispr-local" diarization fallback exists.
  Database:         src/helpers/database.js DatabaseManager; additive idempotent migrations
                    (CREATE TABLE IF NOT EXISTS + try/catch ALTER swallowing "duplicate column");
                    no schema-version table; better-sqlite3 transactions via db.transaction(fn)();
                    notes table has enhanced_content/enhancement_prompt/enhanced_at_content_hash;
                    FTS5 notes_fts + triggers; soft-delete (deleted_at) convention for synced tables.
  Notes/LLM:        actionProcessingStore.ts runBackgroundAction (in-memory, not persisted);
                    live local LLM path: renderer ReasoningService.processText → PROVIDER_REGISTRY.local
                    → IPC "process-local-reasoning" → src/services/localReasoningBridge.js →
                    src/helpers/modelManagerBridge.js runInference → src/helpers/llamaServer.js
                    inference() POST /v1/chat/completions (llama-server pinned tag b8857;
                    5-min idle auto-stop frees VRAM; NO response_format/JSON mode support yet).
                    DEAD legacy stack (do not use): src/services/LocalReasoningService.ts,
                    src/helpers/ModelManager.ts, src/config/InferenceConfig.ts.
  Scopes:           src/config/inferenceScopes.ts (dictationCleanup, dictationAgent, noteFormatting
                    [fallbackScope dictationCleanup], chatIntelligence);
                    settingsStore.ts selectResolvedLLMConfig (~:1554) / selectResolvedNoteFormatting.
  Secrets:          src/helpers/environment.js SECRET_KEYS + per-key encrypted files in
                    userData/secure-keys/*.enc via secretCrypto.js (keyring→safeStorage);
                    recipe for new secret = SECRET_KEYS entry + get/save methods + IPC pair +
                    preload methods + settingsStore initializeSettings hydration.
  Sidecars:         sidecarRegistry.register(name, stopFn); sidecarPidFile.write/clear;
                    sidecarReaper.EXPECTED_BINARY_FRAGMENTS {parakeet, whisper, llama, qdrant, diarization};
                    spawn with shell:false, windowsHide, detached: platform!=="win32";
                    shared serverUtils.js: resolveBinaryPath, findAvailablePort, gracefulStopProcess
                    (SIGTERM→5s→SIGKILL, kills process group on Unix); utilityProcess pattern in
                    onnxWorkerClient.js (request/response correlation, backoff respawn).
  Provisioning:     scripts/download-*.js + scripts/lib/download-utils.js; binaries land flat in
                    resources/bin/<tool>-<platform>-<arch>[.exe]; must be added to ALL prebuild*,
                    predist, prepack chains in package.json.
  Packaging:        electron-builder.json extraResources { from resources/bin/ to bin/ } has an
                    explicit ALLOWLIST filter array — new binaries/dirs MUST be added there or they
                    silently do not ship; asarUnpack for native node modules; afterPack.js strips
                    onnxruntime, signs Mach-O helpers generically; nsis include
                    resources/nsis/cleanup-models.nsh (extend for runtime cleanup on uninstall).
                    Gotcha precedent: bare resources/*.py (linux-text-monitor.py) is NOT packaged.
  Tests:            npm test = node --test "tests/**/*.test.cjs" (node:test + node:assert/strict,
                    no third-party framework). tests/contracts/*.test.cjs (4 files) run in CI;
                    ORPHANED tree test/helpers/*.test.js (6 files) is NOT matched by the glob and
                    not run in CI (pre-existing; new tests must go under tests/**/*.test.cjs).
                    typecheck = cd src && tsc --noEmit (src/ only; main-process JS not typechecked).
  i18n:             src/locales/{en,es,fr,de,pt,it,ru,zh-CN,zh-TW}/translation.json via
                    react-i18next shim; new UI strings need keys in all files (en+es minimum per spec).
  Python usage:     only resources/linux-text-monitor.py (dev-only fallback, spawns system python3).
                    No venv/pip/uv integration exists — WhisperX runtime provisioning is greenfield.

Baseline commands/results (2026-07-16, WSL clone, nvm exec 24):
  npm test              exit 0  — 9 pass / 0 fail (tests/contracts)
  npm run lint          exit 0  — 0 errors, 5 pre-existing warnings (react-refresh/exhaustive-deps
                                  in AcceptInvitationModal.tsx, ShareNoteDialog.tsx, reactI18nextShim.tsx)
  npm run typecheck     exit 0  — clean
  npm run build:renderer exit 0 — clean (pre-existing >500kB chunk-size warnings:
                                  ReasoningService, PersonalNotesView)
  npm run doctor:local  exit 0  — PASS on scripts/ports/env-template; WARN on absent local
                                  binaries/models/.env in this WSL clone (expected, pre-existing)

Pre-existing failures: none blocking. Noted non-failures to leave alone:
  - build-and-notarize.yml verify job on Node 22 (inconsistent with 24 elsewhere)
  - orphaned test/helpers/*.test.js tree not run by npm test
  - 5 lint warnings, chunk-size build warnings
Spec assumption corrections:
  - FR-002 "existing batch-queue workflows": NO batch queue exists in this fork — a minimal
    sequential job queue will be implemented as part of this feature (see decision log D-102).
  - 02_ARCHITECTURE §1 paths: no src/services/fileTranscription.ts, no src/stores/batchQueueStore.ts.
```

## 1. Contracts and Tests First

- [x] Versioned job request schema tests (src/helpers/whisperx/contracts.js + tests/whisperx/contracts.test.cjs; forbidden-credential-key scan included)
- [x] JSONL event parser/state-machine tests (jsonlProtocol.js: byte-capped line reader, ready-first/terminal-once/monotonic-progress session; tests cover malformed JSON, oversized lines, unknown types, version mismatch, events-after-terminal)
- [x] Transcript/artifact schema tests (canonical transcript validation: sorted segments, unique ids, speaker refs, ordered words, finite numbers, flags; artifact descriptor sha256/path checks)
- [x] Evidence-note schema tests (structural: evidence non-empty, duplicate ids, owner/date null-unless-explicit shape, dueDateIso-requires-dueDateText; semantic evidence resolution lands in Phase 4 noteEvidence)
- [x] Path-confinement and redaction tests (pathConfinement.js: traversal/absolute/UNC/device/ADS/reserved/trailing-dot-space rejection + symlink-resolving resolveInsideRoot; redaction.js: hf_ tokens, bearer, key=value, home paths, BoundedRedactedCapture)
- [x] Profile preset tests (profiles.js: memo/meeting/critical defaults per spec 08, allowlisted overrides, hotword sanitization caps/dedupe, deterministic OOM ladders incl. critical disclosed downgrade)
- [x] Database migration tests (src/helpers/whisperx/recordingJobsRepo.js — pure better-sqlite3 module: recording_jobs/recording_artifacts/note_generation_runs/recording_speaker_mappings/transcript_revisions + indexes + FK cascades; wired into database.js initDatabase; tests run on better-sqlite3 or node:sqlite adapter fallback because node_modules is Electron-ABI)
- [ ] Deterministic note renderer tests (deferred to Phase 4 with the renderer implementation; golden fixtures valid-note-extraction.json / valid-transcript.json already in place)
- [x] Fake sidecar integration fixture (tests/fixtures/whisperx-fake-worker.cjs: success, slow-success, malformed-json, stderr-noise, crash, timeout, oom-once-then-success, artifact-hash-mismatch, invalid-transcript, cancel-resistant-child; real files + real sha256; tests/whisperx/fakeWorker.test.cjs 9 integration tests through JsonlLineReader/ProtocolSession)

Phase 1 exit evidence (2026-07-16): npm test 193/193 pass (baseline 9), lint 0 errors, typecheck clean.
Job state machine (jobStateMachine.js) includes `interrupted` startup-recovery state; renderer types in src/types/whisperx.ts.
Cross-language fixtures: tests/fixtures/whisperx-contracts/*.json (9 files) — Python side consumes the same files in Phase 2.

## 2. Managed Runtime and Provisioning

- [x] Native Windows Python 3.12 strategy implemented (whisperxRuntimeManager.js: uv venv --python 3.12 + uv sync --frozen into app runtime dir; sentinel with lock hash; repair/remove; platform-aware pythonPath incl. Scripts/python.exe on win32; WSL clone validates cross-platform contract — native-Windows execution itself pending Windows-clone verification)
- [x] WhisperX dependency pinned and locked (tools/whisperx-sidecar/pyproject.toml whisperx==3.8.6; uv.lock committed, 126 packages resolved)
- [x] Managed cache/runtime directories implemented (runtimeRootDir + modelCacheDirectory/temporaryDirectory injected; job artifacts under jobs root)
- [x] Setup/install/doctor command implemented (npm run setup:whisperx / doctor:whisperx, --json mode, --repair/--remove, local-doctor.js style output)
- [x] CUDA/runtime verification implemented (checkCuda torch probe returning cuda/device/vramGb; doctor reports it)
- [x] Hugging Face token secure storage implemented (HUGGINGFACE_TOKEN in SECRET_KEYS via safeStorage-backed per-key files; IPC exposes STATUS ONLY — renderer can never read the value; save/delete channels; preload wired)
- [ ] Diarization model readiness flow implemented (readiness IPC + model presence checks land with Phase 3 integration)
- [x] Offline readiness check implemented (doctor offline summary; job requests carry runtime.offline; worker sets HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE)

## 3. Sidecar and Process Management

- [x] Python worker implemented (tools/whisperx-sidecar: worker.py single-request stdin, stdout hygiene swap, heartbeat thread, SIGTERM→JOB_CANCELLED exit 130; real_backends.py lazy whisperx/pyannote imports)
- [x] JSONL protocol implemented (protocol.py emit helpers; JS JsonlLineReader/ProtocolSession consume; cross-language fixture agreement verified exactly — 7/7 fixtures)
- [x] Stages/progress implemented (stage/progress/heartbeat/warning events; monotonic progress enforced JS-side)
- [x] Structured error codes implemented (errors.py mirrors constants.js; classify_oom precise: torch OOM type/name/message only — ValueError NOT OOM, tested both sides)
- [x] Main-process sidecar manager implemented (whisperxProcessManager.js: shell:false, env allowlist, HF token env-only, bounded redacted stderr)
- [x] Real process-tree cancellation implemented (POSIX: group signal + ps-ppid-walk descendant kill — fixed BUG: detached/setsid grandchildren escaped the group signal, found by integration test, now covered; Windows: taskkill /PID /T /F)
- [x] Timeout/watchdog behavior implemented (heartbeat timeout 90s default + absolute cap 3h; WORKER_TIMEOUT; tested with fake worker timeout mode)
- [x] Crash recovery implemented (worker exit without terminal event → WORKER_CRASHED retryable; startup recovery marks active jobs interrupted + stale staging cleanup)
- [x] GPU inference coordinator implemented (gpuInferenceCoordinator.js: exclusive FIFO lease, cancelPending, heartbeat-touch stale sweep, forceRelease; llama pause/resume integration lands in Phase 4 note wiring)
- [x] OOM fallback implemented (deterministic ladders in profiles.js; job manager steps ladder on CUDA_OUT_OF_MEMORY only, records fallbackAttempts, emits OOM_FALLBACK_USED; capped by ladder length)
- [x] Transcript normalization/canonicalization implemented (transcript.py: stable seg-#### ids, sorted segments/words, flags incl. low-confidence heuristics, no fabricated quality fields; validated on finalize JS-side + SOURCE_HASH_MISMATCH cross-check)

Phase 2 exit evidence (2026-07-16): npm test 247/247; pytest 73/73 (pydantic+pytest only, offline); lint 0 errors; typecheck clean.
Two real bugs found by the orchestration test agent and FIXED: (1) whisperxProcessManager POSIX tree-kill missed setsid'd grandchildren — now collects descendants via ps ppid-walk before signaling; (2) recordingJobManager flattened ArtifactStoreError codes to UNKNOWN_INTERNAL_ERROR — instanceof gate now includes ArtifactStoreError.

## 4. OpenWhispr Integration

- [x] `whisperx` local upload provider registered (LocalTranscriptionProvider union + both settingsStore coercion sites + TranscriptionModelPicker third tab with readiness panel + provision flow)
- [x] Existing live dictation remains unchanged (no dictation path touched; transcribe-local-whisper untouched; full suite green)
- [x] Settings and profile presets implemented (whisperxModel setting; WhisperXUploadOptions: profile/language/diarization/speaker segmented control/advanced model-compute-batch)
- [x] Upload UI options implemented (UploadAudioView whisperx mode; multi-file drop/browse whisperx-only; model-download consent dialog wired to allowModelDownload)
- [x] Batch queue integration implemented (multi-file submit → sequential FIFO in main-process RecordingJobManager per D-102)
- [x] Real stage progress UI implemented (RecordingJobProgress: real stage/progress events, honest indeterminate when no total, warning badges)
- [x] Cancel/retry implemented (UI buttons → whisperx-cancel-job/whisperx-retry-job → process-tree kill / requeue)
- [x] Language and speaker-count controls implemented (auto/en/es; Auto|Exact|Range 1–32 validated)
- [x] Custom dictionary hotwords integrated (customDictionary from settings store → startJob payload → sanitized hotwords + initialPrompt)
- [x] Narrow preload/IPC contracts implemented (16 whisperx-* channels incl. whisperx-read-source-audio; jobId-keyed reads only — renderer never supplies paths post-creation; payload validation main-side; redacted error envelopes)

## 5. Persistence and Artifacts

- [x] Job database migration implemented (recordingJobsRepo.js — Phase 1; wired into initDatabase)
- [x] Artifact manifest and hashes implemented (manifest.json with descriptors; streaming sha256 verify on finalize)
- [x] Atomic finalize/incomplete cleanup implemented (.incomplete-<jobId> staging → verify → atomic dir rename; stale staging cleanup at startup; failure cleanup keeps finalized outputs)
- [x] Canonical transcript JSON persisted (validated on finalize + SOURCE_HASH_MISMATCH cross-check)
- [x] Raw TXT persisted; [x] Speaker Markdown persisted (when diarization); [x] SRT/VTT persisted
- [x] Retention and delete semantics implemented (delete removes managed artifacts + DB cascade; storage usage IPC + UI footer; confirm dialog states external file is kept)
- [x] External source file protected from deletion (store can only delete inside jobsRoot; tested with outside-root source file)
- [x] Reopen/resume/retry behavior implemented (RecordingJobsPanel lists all statuses across restarts; transcript view reopens finalized jobs; retry from failed/cancelled/interrupted; startup recovery → interrupted)
- [x] Transcript review UI (RecordingTranscriptView: paged segments, speaker rename via mapping layer only, inline corrections as revisions with original preserved, flag badges, TXT/MD/SRT/VTT exports; RecordingAudioPlayer: bounded jobId-keyed source-audio playback + timestamp seek)

Phase 3 exit evidence (2026-07-17): npm test 322/322; lint 0 errors; typecheck clean; build:renderer clean.
i18n: whisperx.* namespaces complete in en + es (~150 keys each); remaining locales (fr, de, pt, it, ru, zh-CN, zh-TW, ja) queued for the Phase 5 sweep.

## 6. Reliable Notes

- [x] Segment-aware chunker implemented (noteChunker.js: whole segments, overlap 2, oversized isolation — bug found by tests and fixed)
- [x] Structured extraction prompt implemented (notePrompts.js evidence-extraction-v1, injection-hardened, per-profile emphasis, transcript fenced as data)
- [x] Schema validation and retry implemented (per-chunk fragment gate + one retry with compact validation feedback; failed chunks isolated, others survive)
- [x] Evidence ID validation implemented (noteEvidence.js: UNKNOWN_SEGMENT/MISSING_EVIDENCE errors block rendering)
- [x] Exact-quote validation implemented (whitespace/punctuation-normalized matching incl. multi-segment spans; QUOTE_NOT_FOUND blocks)
- [x] Deterministic deduplication/merge implemented (noteMerge.js: normalized dedupe, evidence union in transcript order, materially-different action items never merged, disagreement preserved, stable ids)
- [x] Deterministic Markdown renderer implemented (noteRenderer.js: refuses uncited items, review markers, empty-section omission, owner names from manual mapping only; golden-string test)
- [x] Optional strict support-verification pass implemented (evidence-support-verifier-v1; unsupported→dropped, partial/unclear→review marker; UI toggle defaults on for critical-interview)
- [x] Notes saved separately from raw transcript (note-extraction.json + notes.md artifacts + note_generation_runs + OpenWhispr note row; canonical transcript immutable)
- [x] Notes can be regenerated without ASR (generateNotes IPC; E2E-proven worker spawn count stays 1 across note retry)
- [x] Clickable timestamps/audio review implemented (citations use openwhispr://recording/<job>/t/<segment> route; transcript timestamps seek the bounded jobId-keyed audio player)
- [x] Speaker rename mapping implemented without identity inference (display mapping only; canonical transcript never mutated; UI copy states it)

## 7. Benchmarks and Diagnostics

- [x] Benchmark CLI/harness implemented (scripts/benchmark-whisperx.js; manifest-driven case×config matrix; runtime gate; errors recorded per run)
- [x] WER/CER and domain-error metrics implemented (Levenshtein with sub/ins/del backtrace; domain-term hit rates; speaker attribution agreement; timestamp boundary error)
- [x] Note-grounding metrics implemented (derived from validateEvidence issue codes; hard gate: zero evidence-free claims)
- [x] JSON/CSV/Markdown benchmark output implemented (results.json/results.csv/report.md with environment header + explicit missing-metric reasons)
- [x] Content-safe diagnostics implemented (doctor --json machine mode; all error strings redacted; bounded redacted stderr captures) — NOTE: no one-click "diagnostics bundle export" UI; doctor --json + redacted logs are the deliverable (FR-083 partial, documented)
- [x] Performance logging implemented (per-stage timingsMs from worker + RTF in benchmark; real WSL run RTF 0.170) — NOTE: peak-VRAM sampling not implemented; benchmark marks it missing rather than inventing it
- [x] No transcript content in default logs verified (redaction tests + stderr-noise integration test; real-run logs carried only job ids/stages/codes)

## 8. Documentation and Packaging

- [x] Local setup documentation updated (LOCAL_PERSONAL_SETUP.md WhisperX section)
- [x] Hardening/doctor documentation updated (docs/whisperx-reliable-notes.md doctor/maintenance sections; doctor:whisperx --json)
- [x] WhisperX setup and model terms documented (uv provisioning; HF token flow; pyannote terms; weights never redistributed)
- [x] Troubleshooting documented (stable error-code table with actions)
- [x] Privacy/retention documented (offline defaults, storage layout, what logs never contain, retention/delete semantics)
- [x] Windows local package stages required runtime assets (electron-builder extraResources: whisperx-sidecar source+lock allowlist; ffmpeg via existing asarUnpack; packaged-build verification itself BLOCKED on WSL — requires Windows clone)
- [x] License/attribution inventory updated (docs/whisperx-reliable-notes.md dependency/license table)
- [x] Upgrade/uninstall instructions documented (setup --repair/--remove; NSIS uninstall removes runtime/model caches, preserves recording-jobs)

## 9. Validation

- [x] Existing tests pass or pre-existing failures remain unchanged (baseline 9/9 → suite 350/350; zero pre-existing failures at baseline; none introduced)
- [x] New JS/TS tests pass (350 total incl. contracts, protocol, state machines, path confinement, redaction, profiles, repo, artifact store, GPU coordinator, process manager, job manager E2E, whisperxMain, note modules, noteFlow E2E, benchmark metrics)
- [x] Python tests pass (77 pytest, offline, pydantic+pytest only; cross-language fixture agreement 7/7)
- [x] Lint/typecheck pass (0 errors; typecheck clean)
- [x] Renderer/build pass (vite build clean)
- [x] Local doctor passes (doctor:local exit 0; doctor:whisperx all PASS + expected HF-token WARN after WSL provisioning)
- [x] Fake-sidecar end-to-end path passes (success/OOM-ladder/crash/timeout/cancel-resistant-grandchild/hash-mismatch/invalid-transcript all covered)
- [x] CUDA WhisperX smoke test PASS on WSL (real 14.5-min recording: large-v3-turbo float16 batch4 + alignment → transcript_complete; RTF 0.170 incl. model load, 0.032 warm; 239 segments; canonical transcript validates; artifacts finalized; three integration bugs found and fixed: ffprobe-less probe, per-job offline consent env, ffmpeg on worker PATH). NATIVE WINDOWS smoke BLOCKED in this WSL clone — run on the Windows clone: npm run setup:whisperx && npm run doctor:whisperx, then a real upload through the app.
- [x] Diarization smoke test BLOCKED (no HF token/pyannote terms acceptance available in this environment; ASR+alignment proven; diarization path covered by mocked pipeline tests + fake worker)
- [x] Offline rerun PASS on WSL (allowModelDownload=false, HF_HUB_OFFLINE=1, cached models → transcript_complete RTF 0.032)
- [x] Windows packaged/unpacked build BLOCKED (WSL clone per dual-clone rule; command: npm run build:local:win on the Windows clone; extraResources staging config in place)
- [x] Acceptance checklist completed (see final report)

## Final Notes

```text
Changed files:
Tests:
Manual verification:
Blocked checks:
Remaining risks:
No commit/push/release/security scan status:
```
