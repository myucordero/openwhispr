"""JSONL protocol emission.

Every worker event is exactly one JSON object on its own line written to the
*real* stdout, then flushed. Nothing else may write to stdout: the worker
redirects ``sys.stdout`` to stderr for third-party code and hands the saved real
stdout handle to :func:`bind_stream`, so all protocol output goes here and here
only (spec 02 §6, 03 §3, 07 §11).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any, Optional, TextIO

from . import PROTOCOL_VERSION

# The stream protocol events are written to. Defaults to the interpreter's
# original stdout so imports work before bind_stream() is called; the worker
# rebinds this to the saved real stdout after hijacking sys.stdout.
_OUT: Optional[TextIO] = None


def bind_stream(stream: TextIO) -> None:
    """Point protocol emission at ``stream`` (the saved real stdout)."""
    global _OUT
    _OUT = stream


def _stream() -> TextIO:
    if _OUT is not None:
        return _OUT
    return sys.__stdout__ if sys.__stdout__ is not None else sys.stdout


def now_iso() -> str:
    """UTC timestamp, e.g. ``2026-07-16T14:32:05.123456+00:00``."""
    return datetime.now(timezone.utc).isoformat()


def emit(event: dict[str, Any]) -> None:
    """Write exactly one compact JSON line and flush.

    ``ensure_ascii=False`` keeps non-ASCII display names intact; the line never
    contains an embedded newline because ``json.dumps`` escapes control chars.
    """
    stream = _stream()
    stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    stream.flush()


def emit_ready(worker_version: str, whisperx_version: str, python_version: str) -> None:
    emit(
        {
            "type": "ready",
            "protocolVersion": PROTOCOL_VERSION,
            "workerVersion": worker_version,
            "whisperxVersion": whisperx_version,
            "pythonVersion": python_version,
        }
    )


def emit_stage(stage: str) -> None:
    emit({"type": "stage", "stage": stage, "timestamp": now_iso()})


def emit_heartbeat(stage: str) -> None:
    emit({"type": "heartbeat", "stage": stage, "timestamp": now_iso()})


def emit_progress(
    stage: str,
    completed: float,
    total: Optional[float] = None,
    unit: Optional[str] = None,
) -> None:
    event: dict[str, Any] = {"type": "progress", "stage": stage, "completed": completed}
    if total is not None:
        event["total"] = total
    if unit is not None:
        event["unit"] = unit
    emit(event)


def emit_warning(
    code: str, message: str, details: Optional[dict[str, Any]] = None
) -> None:
    event: dict[str, Any] = {"type": "warning", "code": code, "message": message}
    if details is not None:
        event["details"] = details
    emit(event)


def emit_artifact(
    kind: str,
    relative_path: str,
    sha256: str,
    num_bytes: int,
    schema_version: Optional[int] = None,
) -> None:
    event: dict[str, Any] = {
        "type": "artifact",
        "kind": kind,
        "relativePath": relative_path,
        "sha256": sha256,
        "bytes": num_bytes,
        "createdAt": now_iso(),
    }
    if schema_version is not None:
        event["schemaVersion"] = schema_version
    emit(event)


def emit_complete(result: dict[str, Any]) -> None:
    emit({"type": "complete", "result": result})


def emit_error(
    code: str, message: str, details: Optional[dict[str, Any]] = None
) -> None:
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    emit({"type": "error", "error": error})
