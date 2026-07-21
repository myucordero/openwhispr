# 10 — Operations and Troubleshooting

Codex must adapt command names to the implemented scripts and current repository conventions.

## 1. First-Time Setup

Expected high-level flow:

```powershell
npm ci
npm run setup:whisperx
npm run doctor:whisperx
npm run build:renderer
npm run start
```

Setup should:

1. verify/stage the pinned runtime manager;
2. provision Python 3.12 into app-specific storage;
3. sync from `uv.lock`;
4. verify sidecar protocol/version;
5. configure app-specific model caches;
6. verify Torch/CUDA;
7. allow the user to provision ASR/alignment models;
8. securely configure HF token for pyannote;
9. verify offline readiness.

Do not silently download many gigabytes during normal startup.

## 2. Hugging Face / Diarization

The user may need to accept model terms and create a read-only token.

UI/setup requirements:

- explain that ASR can work without this token;
- explain that pyannote diarization is the token-dependent step;
- store token securely;
- show configured/not-configured without revealing it;
- provide remove/rotate action;
- test model access;
- support existing OpenWhispr local diarization fallback where implemented.

Never instruct the user to paste the token into a tracked file.

## 3. Doctor Output

`doctor:whisperx` should check and report:

```text
sidecar source/version
uv/runtime status
Python version
lock hash
Torch version
CUDA available
GPU name
VRAM total/free
FFmpeg path
write access to cache/job directories
free disk
ASR model readiness
alignment model readiness
diarization token status
diarization model readiness
local note model readiness
offline-ready status
packaged/development mode paths
```

Output must be content-safe and secret-free.

Provide machine-readable JSON mode:

```powershell
npm run doctor:whisperx -- --json
```

Use non-zero exit status for blocking failures and documented status categories for optional components.

## 4. Common Failures

### `CUDA_UNAVAILABLE`

Actions:

- confirm NVIDIA driver through `nvidia-smi`;
- run Python Torch CUDA check;
- verify the managed environment, not global Python;
- repair runtime;
- allow explicit CPU mode only with a speed warning.

### `CUDA_OUT_OF_MEMORY`

Actions:

- close other GPU-heavy applications;
- ensure local llama.cpp is unloaded;
- retry through automatic batch/compute fallback;
- inspect actual configuration/fallback attempts;
- use turbo or lower batch size.

### `HF_TOKEN_REQUIRED`

Actions:

- configure token through secure UI/setup;
- verify model terms;
- retry diarization;
- or disable diarization/use local fallback.

ASR transcript remains usable.

### `MODEL_NOT_AVAILABLE_OFFLINE`

Actions:

- reconnect only for explicit provisioning;
- run model setup;
- verify cache path;
- return to offline mode.

Do not download silently during an offline job.

### `WORKER_PROTOCOL_ERROR`

Actions:

- inspect redacted diagnostic;
- verify worker and app protocol versions;
- repair runtime;
- do not parse stderr as protocol.

### `WORKER_TIMEOUT`

Actions:

- inspect last heartbeat/stage;
- terminate process tree;
- retain finalized transcript if already completed;
- retry;
- distinguish long processing from a true stall using stage heartbeat.

### `AUDIO_DECODE_FAILED`

Actions:

- show FFmpeg probe summary;
- confirm file is not corrupt/encrypted;
- convert a copy through a trusted workflow;
- never modify original.

### `DISK_SPACE_INSUFFICIENT`

Actions:

- show required estimate and current free space;
- clean managed jobs/models deliberately;
- choose another managed storage path only through a validated setting.

### `NOTE_EVIDENCE_INVALID`

Actions:

- show invalid item IDs and reasons;
- keep transcript;
- retry note generation once;
- allow user to inspect cited segments;
- never render unsupported claims as final notes.

## 5. Cancellation and Recovery

On cancellation:

- mark job cancelling;
- signal/kill full process tree;
- wait bounded time;
- remove temp normalization and incomplete artifacts;
- release GPU lease;
- mark cancelled;
- preserve finalized prior artifacts;
- leave job retryable.

On app restart:

- inspect jobs in active states;
- confirm no worker remains;
- mark interrupted;
- validate any finalized artifacts;
- clean stale temp directories after a safe age;
- do not mark complete without completion manifest/hash checks.

## 6. Retention and Cleanup

Expose:

```text
job storage usage
runtime/model cache usage
delete job
delete managed source copy
delete normalized audio
delete generated notes only
clear jobs older than N days
repair orphaned metadata/artifacts
```

External source deletion is never part of job cleanup.

## 7. Updates

### App/source update

Follow the repository's safe sync routine, then:

```powershell
npm ci
npm run doctor:local
npm run doctor:whisperx
npm run build:renderer
```

### Python dependency update

- dedicated branch/change;
- update `pyproject.toml`;
- regenerate `uv.lock`;
- run Python and contract tests;
- rerun GPU smoke/benchmark;
- record runtime version change;
- do not auto-upgrade user runtime before compatibility validation.

### Model update

- explicit user action;
- record model/revision;
- preserve old completed-job provenance;
- benchmark before changing defaults.

## 8. Uninstall / Repair

Provide commands/UI actions to:

```text
repair runtime
remove WhisperX runtime
remove WhisperX models
remove diarization models
remove HF token
remove managed recording jobs
```

Never remove existing whisper.cpp/Parakeet models as a side effect.

## 9. Packaging Verification

For the local Windows build:

- start from `dist/win-unpacked` or current equivalent;
- do not rely on repo-relative paths;
- run doctor;
- provision/locate runtime;
- transcribe a small test file;
- restart and reopen job;
- confirm no dev server requirement;
- confirm no token or private cache is bundled.

## 10. Privacy Verification

With network disabled after provisioning:

- app starts;
- WhisperX readiness is true;
- test recording transcribes;
- note generation runs locally;
- citations work;
- no hidden cloud fallback occurs;
- logs contain no content/token;
- failure clearly states missing local asset rather than contacting a cloud service.
