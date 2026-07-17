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

- [ ] Native Windows Python 3.12 strategy implemented
- [ ] WhisperX dependency pinned and locked
- [ ] Managed cache/runtime directories implemented
- [ ] Setup/install/doctor command implemented
- [ ] CUDA/runtime verification implemented
- [ ] Hugging Face token secure storage implemented
- [ ] Diarization model readiness flow implemented
- [ ] Offline readiness check implemented

## 3. Sidecar and Process Management

- [ ] Python worker implemented
- [ ] JSONL protocol implemented
- [ ] Stages/progress implemented
- [ ] Structured error codes implemented
- [ ] Main-process sidecar manager implemented
- [ ] Real process-tree cancellation implemented
- [ ] Timeout/watchdog behavior implemented
- [ ] Crash recovery implemented
- [ ] GPU inference coordinator implemented
- [ ] OOM fallback implemented
- [ ] Transcript normalization/canonicalization implemented

## 4. OpenWhispr Integration

- [ ] `whisperx` local upload provider registered
- [ ] Existing live dictation remains unchanged
- [ ] Settings and profile presets implemented
- [ ] Upload UI options implemented
- [ ] Batch queue integration implemented
- [ ] Real stage progress UI implemented
- [ ] Cancel/retry implemented
- [ ] Language and speaker-count controls implemented
- [ ] Custom dictionary hotwords integrated
- [ ] Narrow preload/IPC contracts implemented

## 5. Persistence and Artifacts

- [ ] Job database migration implemented
- [ ] Artifact manifest and hashes implemented
- [ ] Atomic finalize/incomplete cleanup implemented
- [ ] Canonical transcript JSON persisted
- [ ] Raw TXT persisted
- [ ] Speaker Markdown persisted
- [ ] SRT/VTT persisted
- [ ] Retention and delete semantics implemented
- [ ] External source file protected from deletion
- [ ] Reopen/resume/retry behavior implemented

## 6. Reliable Notes

- [ ] Segment-aware chunker implemented
- [ ] Structured extraction prompt implemented
- [ ] Schema validation and retry implemented
- [ ] Evidence ID validation implemented
- [ ] Exact-quote validation implemented
- [ ] Deterministic deduplication/merge implemented
- [ ] Deterministic Markdown renderer implemented
- [ ] Optional strict support-verification pass implemented
- [ ] Notes saved separately from raw transcript
- [ ] Notes can be regenerated without ASR
- [ ] Clickable timestamps/audio review implemented
- [ ] Speaker rename mapping implemented without identity inference

## 7. Benchmarks and Diagnostics

- [ ] Benchmark CLI/harness implemented
- [ ] WER/CER and domain-error metrics implemented
- [ ] Note-grounding metrics implemented
- [ ] JSON/CSV/Markdown benchmark output implemented
- [ ] Content-safe diagnostics bundle implemented
- [ ] Performance/VRAM logging implemented
- [ ] No transcript content in default logs verified

## 8. Documentation and Packaging

- [ ] Local setup documentation updated
- [ ] Hardening/doctor documentation updated
- [ ] WhisperX setup and model terms documented
- [ ] Troubleshooting documented
- [ ] Privacy/retention documented
- [ ] Windows local package stages required runtime assets
- [ ] License/attribution inventory updated
- [ ] Upgrade/uninstall instructions documented

## 9. Validation

- [ ] Existing tests pass or pre-existing failures remain unchanged
- [ ] New JS/TS tests pass
- [ ] Python tests pass
- [ ] Lint/typecheck pass
- [ ] Renderer/build pass
- [ ] Local doctor passes
- [ ] Fake-sidecar end-to-end path passes
- [ ] CUDA WhisperX smoke test passes or is explicitly blocked
- [ ] Diarization smoke test passes or is explicitly blocked
- [ ] Offline rerun passes or is explicitly blocked
- [ ] Windows packaged/unpacked build passes or is explicitly blocked
- [ ] Acceptance checklist completed

## Final Notes

```text
Changed files:
Tests:
Manual verification:
Blocked checks:
Remaining risks:
No commit/push/release/security scan status:
```
