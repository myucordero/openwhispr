---
name: openwhispr-whisperx-cli
description: Use this skill whenever the user wants to transcribe an audio or video recording locally from a terminal, script, or agent — accurate word-timestamped transcripts, speaker diarization, SRT/VTT subtitles, or evidence-grounded notes — via the OpenWhispr WhisperX pipeline. The `openwhispr-whisperx` CLI runs fully WSL-native (`--local`, no desktop app needed — spawns the WhisperX sidecar directly on the GPU) or against the running OpenWhispr desktop app over its loopback bridge, so any project can submit recordings and fetch transcript/subtitle/notes artifacts. Trigger on "transcribe this recording/meeting/interview", "generate subtitles", "diarize speakers", "whisperx cli", or any scripted/agentic transcription workflow — even if the user doesn't say "CLI".
---

# OpenWhispr WhisperX CLI

Local, private transcription of recordings (audio + MP4 video) through the OpenWhispr WhisperX pipeline. Two modes:

- **Local mode** (`--local`): spawns the WhisperX sidecar worker directly — no desktop app, no Windows process. Best for WSL/agent use.
- **Bridge mode** (default): talks to a running OpenWhispr desktop app over its loopback bridge. Needed for `jobs`/`transcript`/`notes` commands and note generation.

## WSL-native local mode (no desktop app)

Run transcription directly against the in-repo WhisperX sidecar (`tools/whisperx-sidecar`), from any project/terminal on the same machine — no Windows process required.

```bash
openwhispr-whisperx transcribe meeting.m4a --profile meeting --language es --local --text
```

- **Requirements**: `uv` on PATH and the sidecar provisioned (`tools/whisperx-sidecar/.venv`, via `scripts/setup-whisperx.js`). If the desktop bridge is unreachable and the sidecar dir exists, plain `transcribe` (no `--local`) auto-falls-back to local mode with a one-line stderr notice.
- **First run**: pass `--allow-model-download` once to fetch ASR weights (~2–3 GB) into the model cache; subsequent runs are offline by default.
- **Diarization** (`meeting`/`critical-interview` profiles, or `--diarize`): needs a Hugging Face token — export `HF_TOKEN` (or `HUGGINGFACE_TOKEN`) in the environment. Never pass it as a CLI flag or in a request file.
- **Paths**: `/mnt/c/Users/.../recording.m4a`-style WSL paths work fine as the `<file>` argument.
- **Output**: artifacts land in `~/.cache/openwhispr/headless-jobs/<job-id>/` (transcript, subtitles, `manifest.json`); model cache defaults to `~/.cache/openwhispr/whisperx-models` (override with `OPENWHISPR_MODEL_CACHE`).
- **Extra flags**: `--device cuda|cpu` (default `cuda`); on CUDA out-of-memory the CLI automatically retries at `--compute-type int8`, then `--device cpu` (max 2 retries), logging each attempt to stderr and recording them in the job's `manifest.json`. `--worker-timeout SECONDS` (default 600, `0` disables) kills a worker that goes silent (no stdout events) for that long.
- `--wait`/`--poll`/`--timeout` are bridge-only and ignored in local mode (local mode is synchronous — the command doesn't return until the job finishes).
- Override the sidecar location with `OPENWHISPR_SIDECAR_DIR` if not running from the repo.

## Bridge mode (desktop app required)

Local, private transcription of recordings (audio + MP4 video) through the OpenWhispr desktop app's WhisperX pipeline. The heavy lifting (CUDA WhisperX, alignment, pyannote diarization, evidence-grounded notes) runs inside the desktop app; this CLI submits jobs and retrieves results over the loopback HTTP bridge.

## Requirements

- The **OpenWhispr desktop app must be running** (it writes `~/.openwhispr/cli-bridge.json` on startup; override the location with `OPENWHISPR_BRIDGE_FILE`).
- The WhisperX runtime must be provisioned (Settings → Transcription, or `openwhispr-whisperx readiness` to check).
- Run from the repo: `node cli/openwhispr-whisperx.mjs …`, or install globally: `npm install -g ./cli` from the OpenWhispr repo root.

## Quick reference

```bash
openwhispr-whisperx doctor                      # bridge reachable? runtime ready?
openwhispr-whisperx readiness                   # full readiness JSON (models, CUDA, blockers)

# Submit and wait, print the plain transcript to stdout:
openwhispr-whisperx transcribe meeting.m4a --profile meeting --language es --wait --text

# Submit only (returns the job as JSON when piped):
openwhispr-whisperx transcribe memo.wav --profile memo

openwhispr-whisperx jobs list [--status transcript_complete] [--limit N]
openwhispr-whisperx jobs get <id>               # job + artifact list
openwhispr-whisperx jobs cancel|retry|delete <id>

openwhispr-whisperx transcript <id> --format text|srt|vtt|md|json
openwhispr-whisperx notes generate <id> [--provider claude-cli] [--strict]
openwhispr-whisperx notes get <id>              # rendered notes.md
```

## Profiles and overrides

| Profile              | Model          | Diarization | Intended for                          |
| -------------------- | -------------- | ----------- | ------------------------------------- |
| `memo` (default)     | large-v3-turbo | off         | voice notes, single speaker           |
| `meeting`            | large-v3-turbo | on          | multi-speaker meetings                |
| `critical-interview` | large-v3       | on          | maximum accuracy, strict notes        |

Fine-tune with flags (each maps to an engine override): `--language <code>`, `--diarize` / `--no-diarize`, `--speakers N` (exact), `--min-speakers N --max-speakers N`, `--model <id>`, `--compute-type float16|int8`, `--batch-size N`, `--no-align`, `--dictionary word1,word2` (hotwords/custom vocabulary).

Other flags: `--display-name <s>`, `--allow-model-download` (permit a one-time model fetch on an offline-default setup), `--notes-provider/--notes-model` (queue note generation after transcription, e.g. `--notes-provider claude-cli`), `--local` (headless, no desktop app — see above), `--device cuda|cpu` (local mode only, default `cuda`).

## Waiting and output

- `--wait` polls until the job settles (`--poll SECONDS`, default 5; `--timeout SECONDS`, 0 = none). Status transitions stream to stderr on TTYs.
- `--text` implies waiting and prints only `transcript.raw.txt` to stdout — ideal for piping into another tool.
- All commands: TTY → human-readable, pipe → bare JSON; force with `--format json`. Parse stdout only; errors go to stderr as plain text.

Job statuses: active (`queued`, `transcribing`, `aligning`, `diarizing`, …), success (`transcript_complete`, `complete`), failure (`failed`, `cancelled`, `interrupted`, `transcript_complete_note_failed`).

## Artifacts

Each job directory holds immutable transcript artifacts; fetch them by name:

```bash
openwhispr-whisperx transcript <id> --format srt > meeting.srt
node cli/openwhispr-whisperx.mjs transcript <id> --format json | jq '.segments[0]'
```

`text` → `transcript.raw.txt`, `srt` → `transcript.srt`, `vtt` → `transcript.vtt`, `md` → `transcript.speakers.md` (speaker-labelled, segment IDs), `json` → paged canonical segments (`--offset/--limit`). Notes render to `notes.md` with per-claim evidence citations back to segment IDs.

`transcript <id> --max-bytes N` caps how much of a non-JSON artifact (`text`/`srt`/`vtt`/`md`) the desktop bridge returns in one response — useful for very long transcripts when piping to a tool with its own size limits (bridge mode only).

## Exit codes

| Code | Meaning                                | Recovery                                  |
| ---- | -------------------------------------- | ----------------------------------------- |
| 0    | Success                                | Continue                                  |
| 1    | User error / job failed / bridge 4xx   | Fix arguments or inspect the job error    |
| 2    | Desktop bridge unreachable             | Start the OpenWhispr desktop app          |
| 3    | Auth failure (stale bridge token)      | Restart the desktop app                   |
| 4    | Not found (job/artifact)               | Check the ID                              |

## Programmatic / agentic pattern

```bash
job_id=$(openwhispr-whisperx transcribe "$file" --profile meeting --format json | jq -r '.id')
openwhispr-whisperx jobs get "$job_id" --format json   # poll .job.status yourself, or use --wait
openwhispr-whisperx transcript "$job_id" --format text
```

Supported source extensions: mp3, wav, m4a, webm, ogg, oga, flac, aac, mp4, m4v. Paths are resolved client-side to absolute paths; the file must be readable by the desktop app (same machine). The original recording is never modified or deleted.
