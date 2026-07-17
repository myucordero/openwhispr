# WhisperX Accurate Recordings and Reliable Notes

Local-first pipeline that turns an existing audio recording into a structured,
timestamped transcript and evidence-grounded Markdown notes. Complements —
never replaces — live hotkey dictation (whisper.cpp / Parakeet).

## What it does

- Upload or drag audio files (mp3, wav, m4a, webm, ogg, flac, aac) and pick a
  profile: **Personal Memo**, **Meeting**, or **Critical / Research Interview**.
- Transcribes with WhisperX (faster-whisper `large-v3-turbo` / `large-v3`,
  CUDA float16 by default) with word alignment and optional pyannote speaker
  diarization.
- Preserves immutable evidence per job: canonical transcript JSON, raw TXT,
  speaker Markdown, SRT/VTT, artifact manifest with SHA-256 hashes.
- Generates notes through a schema-constrained local LLM extraction where
  **every substantive claim cites transcript segment IDs**; deterministic
  code validates evidence, merges chunks, and renders the Markdown. Claims
  without valid evidence are dropped, never rendered.
- Jobs are cancellable (real process-tree kill), retryable, and survive app
  restarts. Failed or cancelled jobs never appear complete.

## Setup (Windows-native runtime)

The shipped runtime target is native Windows (not WSL). Prerequisites:
[uv](https://docs.astral.sh/uv/) on PATH and an NVIDIA driver for CUDA.

```powershell
npm ci
npm run setup:whisperx     # provisions Python 3.12 venv from the committed uv.lock
npm run doctor:whisperx    # verify runtime, Torch/CUDA, ffmpeg, storage
```

In the app: Settings → Transcription → Local → **WhisperX** tab shows the
same readiness (runtime, CUDA, models, diarization token) and offers one-click
setup. ASR/alignment models (~1.6–3 GB) download on the first job **only
after an explicit confirmation dialog** — never silently.

### Diarization (optional, token-gated)

Speaker diarization uses `pyannote/speaker-diarization-community-1`:

1. Accept the model terms on Hugging Face and create a **read-only** token.
2. Paste it in Settings → WhisperX → Diarization. It is encrypted with the
   OS keychain/safeStorage, is never written to `.env`, job files, logs, or
   command lines, and the UI can only ever read back "configured: yes/no".
3. ASR works fully without the token; only diarization is blocked. The
   existing sherpa-onnx local diarization remains the documented fallback
   provider (`openwhispr-local`).

## Job storage and retention

```text
<userData>/recording-jobs/<job-id>/   transcripts, subtitles, notes, manifest
<userData>/whisperx-runtime/          managed Python venv (uv)
<userData>/whisperx-models/           HF model caches
<userData>/whisperx-tmp/              per-job temporary audio
```

- The **original recording is never copied, modified, or deleted**. Deleting
  a job removes only the managed artifacts above (the confirm dialog states
  this explicitly).
- Storage usage per job and in total is visible in the Recordings panel.
- The Windows uninstaller removes the managed runtime and model caches but
  intentionally leaves `recording-jobs` for the user to keep or delete.

## Privacy

- Default pipeline is fully local; after provisioning it runs with
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
| `WORKER_TIMEOUT` / `WORKER_CRASHED` | Job stays failed and retryable; see redacted diagnostics; retry from the Recordings panel. |
| `NOTE_MODEL_UNAVAILABLE` | Select a local note-formatting model (Settings → AI Models) and use "Generate notes" on the job. |
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
npm test                                   # includes tests/whisperx/* (contracts, orchestration, notes)
cd tools/whisperx-sidecar && uv run pytest # Python side (offline, mocked backends)
RUN_WHISPERX_GPU_TESTS=1 uv run pytest     # opt-in real-model smoke (CUDA + models required)
```
