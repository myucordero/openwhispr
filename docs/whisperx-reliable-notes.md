# WhisperX Accurate Recordings and Reliable Notes

Local-first pipeline that turns an existing audio recording into a structured,
timestamped transcript and evidence-grounded Markdown notes. Complements —
never replaces — live hotkey dictation (whisper.cpp / Parakeet).

## What it does

- Upload or drag audio files (mp3, wav, m4a, webm, ogg, oga, flac, aac) or MP4 video
  (mp4, m4v — the audio track is extracted automatically via ffmpeg) and pick a
  profile: **Personal Memo**, **Meeting**, or **Critical / Research Interview**.
- Transcribes with WhisperX (faster-whisper `large-v3-turbo` / `large-v3`,
  CUDA float16 by default) with word alignment and optional pyannote speaker
  diarization.
- Preserves immutable evidence per job: canonical transcript JSON, raw TXT,
  SRT/VTT, and an artifact manifest with SHA-256 hashes; speaker Markdown is
  included when diarization is enabled and produces speaker labels.
- Generates notes through a schema-constrained LLM extraction where
  **every substantive claim cites transcript segment IDs**; deterministic
  code validates evidence, merges chunks, and renders the Markdown. Claims
  without valid evidence are dropped, never rendered. The note LLM is
  pluggable: a local GGUF model (llama.cpp) or the Claude/Codex CLI bridge
  (`claude-cli` / `codex-cli`, subscription auth) — both stay on-device to
  invoke; the CLI backends call the vendor cloud. Rendered notes include the
  permanent notice `> Generated from automated transcription. Evidence-linked
  does not mean human-verified.` immediately after any optional title.
- Jobs are cancellable (real process-tree kill), retryable, and survive app
  restarts. Failed or cancelled jobs never appear complete.

## Setup (Windows-native runtime)

The shipped desktop runtime target is native Windows (not WSL). The headless
CLI path is also WSL-native through `uv`; an NVIDIA driver is required only for
CUDA (use `--device cpu` when GPU inference is unavailable). Prerequisites:
[uv](https://docs.astral.sh/uv/) on PATH.

```powershell
npm ci
npm run setup:whisperx     # provisions Python 3.12 venv from the committed uv.lock
npm run doctor:whisperx    # verify runtime, Torch/CUDA, ffmpeg, storage
```

In the app: Settings → Transcription → Local → **WhisperX** tab shows the
same readiness (runtime, CUDA, models, diarization token) and offers one-click
setup. ASR/alignment models download on the first job **only after an explicit
confirmation dialog** — never silently. The renderer readiness IPC response is
top-level `{success, ...readinessFields}` (the CLI bridge wraps readiness in a
`data` property).

### CLI and headless local mode

The zero-dependency Node 20+ `openwhispr-whisperx` CLI can use the running app
through loopback bridge routes or run the sidecar without a desktop app:

- Bridge routes are `/v1/recordings/{readiness,list,create}` plus
  `/{id}{,/cancel,/retry,/transcript,/artifact?path=,/notes}`. Create requires
  an absolute `source_path` whose extension is one of `.mp3`, `.wav`, `.m4a`,
  `.webm`, `.ogg`, `.oga`, `.flac`, `.aac`, `.mp4`, or `.m4v`. Request bodies
  are UTF-8 JSON objects capped at 1 MiB; null, arrays, non-objects, invalid
  JSON, and oversized bodies are rejected. Error mapping is explicit:
  `AUDIO_FILE_NOT_FOUND` → 404, validation/protocol/path errors → 400,
  `NOTE_MODEL_UNAVAILABLE` → 409, `RUNTIME_NOT_INSTALLED` → 503, and
  `ARTIFACT_WRITE_FAILED` → 413; the explicit "Job not found" case is also
  404, while other unmapped failures remain 500.
- `transcribe <file> --local` spawns the worker with `uv run`. Plain
  `transcribe` automatically falls back to local mode when the bridge is
  unreachable and the sidecar directory exists. `--device cuda|cpu` is
  supported; for the default float16 request, local OOM recovery retries
  float16, then int8, then int8 on CPU. The inactivity watchdog defaults to 600
  seconds (`--worker-timeout 0`
  disables it) and resets on worker output/heartbeats.
- `OPENWHISPR_SIDECAR_DIR` overrides the sidecar directory and
  `OPENWHISPR_MODEL_CACHE` overrides the model cache (default
  `~/.cache/openwhispr/whisperx-models`). The Linux/WSL path adds the venv's
  `nvidia/*/lib` directories to `LD_LIBRARY_PATH` so CTranslate2 can discover
  cuDNN by soname. Headless jobs are stored under
  `~/.cache/openwhispr/headless-jobs/<job-id>/`; successful jobs and
  non-cancellation failures write a `manifest.json`, including failure
  manifests such as `WORKER_SPAWN_FAILED`.
- Markdown transcript export is **enabled by default** in local mode. It writes
  next to the source as `<base>.md`, with this ownership marker (the ` |` after
  the basename is the delimiter):
  `<!-- openwhispr-whisperx export | source: <basename> | job: <job-id> -->`.
  Only the first 512 bytes are checked for that marker. A foreign-content collision diverts to
  `<base>.transcript.md`; if both candidates are foreign, export is skipped
  with a warning. Use `--no-export` to disable it. Local JSON reports
  `exportedPath`; the manifest records `export.status`, `export.path`, and
  `export.source`. Export writes use an atomic `.tmp-<pid>` sibling and remove
  that temporary file on handled failures.
- Bridge mode and `--local` mode have been verified under native Windows Node
  when winget-installed `ffmpeg` is on `PATH`. Known latent bug (not fixed
  here): `resolveFfmpegPathForLocal` (`cli/openwhispr-whisperx.mjs:369-373`)
  omits `ffmpeg.exe` from the `ffmpeg-static` fallback path, so the fallback
  does not resolve on Windows when `ffmpeg` is absent from `PATH`.

The `openwhispr-whisperx-cli` agent skill is GLOBAL-ONLY at
`~/.claude/skills/openwhispr-whisperx-cli/SKILL.md`; it is intentionally not a
copy under this repository's `.claude` directory.

### Diarization (optional, token-gated)

Speaker diarization uses `pyannote/speaker-diarization-community-1`:

1. Accept the model terms on Hugging Face and create a **read-only** token.
2. Paste it in Settings → WhisperX → Diarization. It is encrypted with the
   OS keychain/safeStorage, is never written by the in-app save flow to `.env`,
   job files, logs, or command lines, and the UI can only ever read back
   "configured: yes/no". For headless/diagnostic use, an explicitly supplied
   `HUGGINGFACE_TOKEN` or conventional `.env`/process `HF_TOKEN` is accepted
   by the environment helper, doctor, and benchmark; the local CLI forwards
   either form to the sidecar as `HF_TOKEN`.
3. ASR works fully without the token; only diarization is blocked. pyannote
   is the only implemented diarization backend today: when it cannot run, the
   job completes without speaker labels and surfaces a
   `DIARIZATION_UNAVAILABLE` warning. The `openwhispr-local` provider id is
   reserved in the contracts for a future sherpa-onnx handoff but is not
   implemented — selecting it behaves like diarization-unavailable.

## Job storage and retention

```text
<userData>/recording-jobs/<job-id>/   transcripts, subtitles, notes, manifest
<userData>/whisperx-runtime/          managed Python venv (uv)
<userData>/whisperx-models/           pyannote diarization model cache only
                                       (ASR models live in the default Hugging
                                       Face hub cache; alignment checkpoints in
                                       the torch hub cache — readiness scans
                                       all three)
<userData>/whisperx-tmp/              per-job temporary audio
~/.cache/openwhispr/headless-jobs/    headless CLI job directories
```

- The **original recording is never copied, modified, or deleted**. Deleting
  a job removes only the managed artifacts above (the confirm dialog states
  this explicitly).
- Sidecar artifacts are written atomically through sibling `.tmp-<pid>` files;
  the desktop artifact store stages a job, verifies hashes/sizes, writes its
  manifest, and promotes the directory atomically.
- Storage usage per job and in total is visible in the Recordings panel.
- The packaged Windows NSIS hook removes the legacy
  `$PROFILE\.cache\openwhispr\models` cache but leaves the WhisperX
  `userData` runtime/model caches and `recording-jobs` in place; delete those
  managed directories separately if you want a full data purge.

## Privacy

- Default desktop jobs are fully local; after provisioning they run with
  `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1` — a missing model produces
  `MODEL_NOT_AVAILABLE_OFFLINE`, never a silent download or cloud fallback.
- Default logs/diagnostics contain job IDs, stages, durations, model names,
  exit codes, and stable error codes — never audio, transcript text, notes,
  tokens, or full user paths (paths and credential-shaped strings are
  redacted; worker stderr is size-capped and redacted).
- Transcript content is treated as untrusted input to the note model: spoken
  instructions cannot override the extraction rules, owners/dates are null
  unless explicit, and speaker labels stay generic (`SPEAKER_00`) until you
  rename them manually.

## Troubleshooting

Run `npm run doctor:whisperx` (add `--json` for machine output). Common codes:

| Code | Meaning / action |
|---|---|
| `RUNTIME_NOT_INSTALLED` | Run `npm run setup:whisperx` (or Settings → Set up WhisperX). |
| `RUNTIME_VERSION_MISMATCH` | Lock changed; run `node scripts/setup-whisperx.js --repair`. |
| `CUDA_UNAVAILABLE` | Check `nvidia-smi`, then doctor; explicit CPU mode is available with a speed warning. |
| `CUDA_OUT_OF_MEMORY` | Automatic ladder retries lower batch/int8 and records the fallback; close other GPU apps. |
| `HF_TOKEN_REQUIRED` / `DIARIZATION_MODEL_NOT_READY` | Configure the token / accept model terms, or disable diarization — the transcript still completes. |
| `MODEL_NOT_AVAILABLE_OFFLINE` | Re-run a job once with the download confirmation, then return offline. |
| `WORKER_TIMEOUT` / `WORKER_INACTIVITY_TIMEOUT` / `WORKER_CRASHED` | Job stays failed and retryable; see redacted diagnostics; retry from the Recordings panel. |
| `WORKER_SPAWN_FAILED` | The headless worker could not start; inspect `manifest.json` and the `uv`/sidecar path, then retry. |
| `NOTE_MODEL_UNAVAILABLE` | Select a note-formatting backend — a local GGUF model or the Claude/Codex CLI (Settings → AI Models) — and use "Generate notes" on the job. |
| `NOTE_EVIDENCE_INVALID` | The extraction produced no evidence-valid items; the transcript is intact — retry note generation. |

Maintenance commands:

```powershell
node scripts/setup-whisperx.js --repair    # rebuild the venv from uv.lock
node scripts/setup-whisperx.js --remove    # remove the managed runtime
npm run benchmark:whisperx -- --manifest <private-manifest.json> --output <dir>
```

## Dependency and license inventory

| Component | Version / pin | License / terms |
|---|---|---|
| WhisperX | `3.8.6` (uv.lock) | BSD-2-Clause |
| faster-whisper / CTranslate2 | via uv.lock | MIT |
| PyTorch (CUDA) | via uv.lock | BSD-style |
| pyannote.audio + Community-1 pipeline | via uv.lock; weights token-gated | MIT code; model terms require HF acceptance — weights are **not** redistributed with the app |
| Whisper `large-v3` / `large-v3-turbo` weights | HF download at first use | MIT (OpenAI Whisper) |
| pydantic | v2 (uv.lock) | MIT |
| uv | user-installed | Apache-2.0/MIT |

Python dependencies are pinned by `tools/whisperx-sidecar/uv.lock`; runtime
upgrades happen only through an explicit repair, never automatically.

## Testing

```bash
npm test                                   # 403 Node tests, including cliHeadless (34) and cliBridgeRecordings (11)
cd tools/whisperx-sidecar && uv run pytest # Python side, including test_real_backends.py
node scripts/benchmark-whisperx.js …       # real-model runs (runtime/models; --require-cuda for CUDA)
```

The sidecar pytest suite includes offline/mock coverage and
`tests/test_real_backends.py`; real-model verification also goes through the
benchmark harness on the native Windows machine. The `openwhispr-whisperx-cli`
agent skill is maintained globally, not in this repository.
