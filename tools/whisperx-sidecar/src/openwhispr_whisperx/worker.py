"""WhisperX sidecar worker entry point.

Contract:
  - Read exactly one JSONL request line (bounded to 1 MiB) from stdin.
  - stdout is reserved for the JSONL protocol; ``sys.stdout`` is swapped to
    stderr for third-party code and the saved real stdout is handed to
    ``protocol.bind_stream`` (spec 02 §6, 07 §11).
  - Emit ``ready`` before any heavy import, then run the pipeline with the real
    backends and stream stage/progress/warning/artifact/complete events.
  - Exit codes: 0 complete, 2 protocol/validation error, 3 CUDA OOM (so the
    orchestrator retries the fallback ladder), 130 cancellation, 1 otherwise.
  - Every exception string is passed through redaction before emission.
"""

from __future__ import annotations

import importlib.util
import os
import platform
import signal
import sys
import threading
from typing import Any, Optional

from . import __version__
from .errors import JobCancelled, WorkerError
from .redaction import redact_text

MAX_REQUEST_LINE_BYTES = 1024 * 1024
HEARTBEAT_INTERVAL_SECONDS = 5.0


class StageTrackingEmitter:
    """Wraps the protocol module and remembers the current stage for heartbeats."""

    def __init__(self, protocol_module: Any) -> None:
        self._p = protocol_module
        self.current_stage = "starting"

    def emit_stage(self, stage: str) -> None:
        self.current_stage = stage
        self._p.emit_stage(stage)

    def emit_progress(self, stage, completed, total=None, unit=None) -> None:
        self._p.emit_progress(stage, completed, total, unit)

    def emit_warning(self, code, message, details=None) -> None:
        self._p.emit_warning(code, message, details)

    def emit_artifact(self, kind, relative_path, sha256, num_bytes, schema_version=None) -> None:
        self._p.emit_artifact(kind, relative_path, sha256, num_bytes, schema_version)

    def emit_complete(self, result) -> None:
        self._p.emit_complete(result)


def _read_request_line(max_bytes: int) -> bytes:
    """Read one newline-terminated line from stdin, capped at ``max_bytes``."""
    buf = bytearray()
    fd = 0
    while True:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf.extend(chunk)
        nl = buf.find(b"\n")
        if nl != -1:
            return bytes(buf[:nl])
        if len(buf) > max_bytes:
            raise WorkerError(
                "WORKER_PROTOCOL_ERROR",
                f"Request line exceeded {max_bytes} bytes",
            )
    return bytes(buf)


def _whisperx_version() -> str:
    """Look up the installed whisperx version without importing the module."""
    try:
        from importlib import metadata

        return metadata.version("whisperx")
    except Exception:
        return "unknown"


def _load_backends_module() -> Any:
    """Return the backends module (real, or a test fake selected via env)."""
    if os.environ.get("OPENWHISPR_WORKER_FAKE_BACKENDS") == "1":
        target = os.environ.get("OPENWHISPR_WORKER_BACKENDS_MODULE")
        if not target:
            raise WorkerError(
                "WORKER_PROTOCOL_ERROR",
                "Fake backends requested but OPENWHISPR_WORKER_BACKENDS_MODULE unset",
            )
        if target.endswith(".py") or os.path.sep in target:
            spec = importlib.util.spec_from_file_location("owx_fake_backends", target)
            if spec is None or spec.loader is None:
                raise WorkerError("WORKER_PROTOCOL_ERROR", "Could not load fake backends")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        import importlib as _importlib

        return _importlib.import_module(target)
    from . import real_backends

    return real_backends


def main() -> None:
    from . import protocol

    # --- stdout hygiene: keep the real stdout private for protocol only. ---
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    protocol.bind_stream(real_stdout)

    # --- read + parse the single request line ---
    try:
        raw_line = _read_request_line(MAX_REQUEST_LINE_BYTES)
    except WorkerError as exc:
        protocol.emit_error(exc.code, redact_text(exc.message), exc.details)
        raise SystemExit(2)

    import json

    try:
        request_data = json.loads(raw_line.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        protocol.emit_error(
            "WORKER_PROTOCOL_ERROR",
            "Request line was not valid JSON",
            {"detail": redact_text(str(exc))},
        )
        raise SystemExit(2)

    from pydantic import ValidationError

    from .schemas import parse_job_request

    try:
        request = parse_job_request(request_data)
    except ValidationError as exc:
        protocol.emit_error(
            "WORKER_PROTOCOL_ERROR",
            "Job request failed contract validation",
            {"errors": exc.error_count()},
        )
        raise SystemExit(2)

    # --- offline env must be set BEFORE loading any model backend (spec 07 §8) ---
    if request.runtime.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"

    # --- ready (before heavy imports) ---
    protocol.emit_ready(
        worker_version=__version__,
        whisperx_version=_whisperx_version(),
        python_version=platform.python_version(),
    )

    emitter = StageTrackingEmitter(protocol)

    # --- cancellation via SIGTERM/SIGINT ---
    cancel_event = threading.Event()

    def _handle_signal(_signum: int, _frame: Any) -> None:
        cancel_event.set()

    try:
        signal.signal(signal.SIGTERM, _handle_signal)
        signal.signal(signal.SIGINT, _handle_signal)
    except (ValueError, OSError):
        pass  # not on the main thread (e.g. some test harnesses)

    # --- heartbeat thread ---
    stop_heartbeat = threading.Event()

    def _heartbeat_loop() -> None:
        while not stop_heartbeat.wait(HEARTBEAT_INTERVAL_SECONDS):
            try:
                protocol.emit_heartbeat(emitter.current_stage)
            except Exception:  # noqa: BLE001
                return

    heartbeat_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
    heartbeat_thread.start()

    hf_token = os.environ.get("HF_TOKEN") or None
    ffmpeg_path = os.environ.get("OPENWHISPR_FFMPEG_PATH") or None

    exit_code = 0
    try:
        backends_module = _load_backends_module()
        backends = backends_module.make_backends(request, hf_token)

        # A fake backends module may also supply fake audio ops so subprocess
        # tests need no ffmpeg; the real module has no such hook (uses ffprobe).
        audio_ops = None
        make_audio_ops = getattr(backends_module, "make_audio_ops", None)
        if make_audio_ops is not None:
            audio_ops = make_audio_ops(request)

        from .pipeline import run_pipeline

        run_pipeline(
            request,
            backends,
            emitter,
            should_cancel=cancel_event.is_set,
            audio_ops=audio_ops,
            ffmpeg_path=ffmpeg_path,
        )
        exit_code = 0
    except JobCancelled:
        _cleanup_temp(request)
        protocol.emit_error("JOB_CANCELLED", "Job cancelled by request")
        exit_code = 130
    except WorkerError as exc:
        protocol.emit_error(exc.code, redact_text(exc.message), exc.details or None)
        exit_code = 3 if exc.code == "CUDA_OUT_OF_MEMORY" else 1
    except Exception as exc:  # noqa: BLE001
        protocol.emit_error(
            "UNKNOWN_INTERNAL_ERROR",
            redact_text(str(exc)) or "Unexpected worker error",
        )
        exit_code = 1
    finally:
        stop_heartbeat.set()

    raise SystemExit(exit_code)


def _cleanup_temp(request: Any) -> None:
    """Best-effort removal of the temp normalized audio produced this run."""
    try:
        temp_dir = request.runtime.temporary_directory
        candidate = os.path.join(temp_dir, "normalized-16k-mono.wav")
        if os.path.isfile(candidate):
            os.remove(candidate)
    except Exception:  # noqa: BLE001
        pass


if __name__ == "__main__":
    main()
