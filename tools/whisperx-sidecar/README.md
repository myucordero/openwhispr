# OpenWhispr WhisperX Sidecar

Python 3.12 worker that performs WhisperX ASR, alignment, and pyannote
diarization for OpenWhispr's reliable-notes pipeline. The Electron main process
spawns it once per job, sends one JSONL request on stdin, and reads a stream of
JSONL protocol events on stdout. The wire contract is defined in
`docs/whisperx-reliable-notes/03_DATA_CONTRACTS_AND_PROTOCOLS.md` and mirrored on
the JavaScript side in `src/helpers/whisperx/`. Both sides share the fixtures in
`tests/fixtures/whisperx-contracts/`.

## Requirements

- Python `>=3.12,<3.13`
- [`uv`](https://docs.astral.sh/uv/) for dependency resolution and running

## Install / provision

Dependencies (whisperx 3.8.6 + pydantic and their transitive pins) resolve from
the committed lock:

```bash
cd tools/whisperx-sidecar
uv sync --frozen
```

If `uv.lock` is missing (see note below), generate it once:

```bash
cd tools/whisperx-sidecar
uv lock
```

On Windows, run the same command from the repository's `tools/whisperx-sidecar`
directory. `uv lock` resolves package metadata over the network (torch/whisperx
are large); `uv sync` then downloads the wheels. Do not run `uv sync` in CI that
has no GPU/network budget — it pulls multi-GB CUDA wheels.

## Run

The app invokes the worker as a module, reading exactly one JSONL request line
from stdin:

```bash
uv run python -m openwhispr_whisperx.worker < request.jsonl
```

Or via the installed console script:

```bash
uv run openwhispr-whisperx-worker < request.jsonl
```

The worker emits `ready`, then `stage`/`progress`/`warning`/`artifact` events,
and finally `complete` or `error`. Exit codes: `0` complete, `2` protocol or
request-validation error, `3` CUDA out-of-memory (the Electron orchestrator then
retries the OOM fallback ladder), `130` cancellation (SIGTERM/SIGINT), `1`
otherwise. stdout is reserved for the protocol; third-party stdout writes are
redirected to stderr, and all diagnostics are redacted (no tokens, keys, or full
home paths).

### Environment

- `HF_TOKEN` — Hugging Face token for token-gated pyannote diarization. Read
  from the environment only; never from the request JSON, never logged.
- `OPENWHISPR_FFMPEG_PATH` — optional trusted ffmpeg path used for probing and
  16 kHz mono normalization (ffprobe is derived from it).
- `HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` — set automatically to `1` when the
  request has `runtime.offline = true`; missing models then fail instead of
  downloading.

## Test

Tests are deterministic and fully offline: they need only `pydantic` and
`pytest` — never torch, whisperx, or ffmpeg (backends and audio ops are injected
as fakes; `real_backends.py` imports whisperx lazily).

Preferred:

```bash
cd tools/whisperx-sidecar
uv run pytest
```

Without syncing the heavy runtime, a minimal test venv is enough:

```bash
cd tools/whisperx-sidecar
uv venv .venv-test --python 3.12
uv pip install --python .venv-test pydantic pytest
.venv-test/bin/python -m pytest tests/ -q
```

The suite covers: shared-fixture agreement with the JS contract, schema unit
rules (path confinement, speaker counts, offline flag, forbidden credential
keys), protocol single-line/stdout purity, the transcript builder, artifact
golden outputs and hashes, the pipeline with fake backends (ASR-only, alignment,
diarization, partial-alignment, diarization fallback, precise OOM
classification, cleanup), redaction, and a subprocess worker run (full event
stream, invalid request exit 2, SIGTERM cancellation exit 130).

## Package layout

```
src/openwhispr_whisperx/
  __init__.py        version + protocol/schema versions
  worker.py          CLI entry point, stdin/stdout/signals/heartbeat
  protocol.py        JSONL emitters (the only writers of the real stdout)
  schemas.py         Pydantic v2 models mirroring the JS contract
  errors.py          stable error codes + classify_oom
  redaction.py       token/key/home-path redaction
  audio.py           ffprobe/ffmpeg probe + normalize + sha256
  transcript.py      canonical transcript builder
  artifacts.py       renderers + confined writers
  pipeline.py        stage orchestration (backends injected)
  real_backends.py   lazy whisperx/pyannote implementation
tests/               offline pytest suite (pydantic + pytest only)
```
