"""Stable error codes and OOM classification.

Mirrors ``ERROR_CODES`` in ``src/helpers/whisperx/constants.js`` (spec 03 §10).
``WorkerError`` is the single exception type the pipeline raises for a
recognised, coded failure; the worker maps its ``code`` to a process exit code.
"""

from __future__ import annotations

import re
from typing import Any, Optional

# Keep in lockstep with ERROR_CODES in constants.js.
ERROR_CODES: tuple[str, ...] = (
    "RUNTIME_NOT_INSTALLED",
    "RUNTIME_VERSION_MISMATCH",
    "PYTHON_START_FAILED",
    "CUDA_UNAVAILABLE",
    "CUDA_OUT_OF_MEMORY",
    "MODEL_NOT_AVAILABLE_OFFLINE",
    "HF_TOKEN_REQUIRED",
    "DIARIZATION_MODEL_NOT_READY",
    "AUDIO_FILE_NOT_FOUND",
    "AUDIO_UNSUPPORTED",
    "AUDIO_PROBE_FAILED",
    "AUDIO_DECODE_FAILED",
    "SOURCE_HASH_MISMATCH",
    "OUTPUT_PATH_REJECTED",
    "DISK_SPACE_INSUFFICIENT",
    "WORKER_PROTOCOL_ERROR",
    "WORKER_TIMEOUT",
    "WORKER_CRASHED",
    "JOB_CANCELLED",
    "ALIGNMENT_UNAVAILABLE",
    "ALIGNMENT_PARTIAL",
    "DIARIZATION_FAILED",
    "TRANSCRIPT_SCHEMA_INVALID",
    "ARTIFACT_WRITE_FAILED",
    "ARTIFACT_HASH_MISMATCH",
    "NOTE_MODEL_UNAVAILABLE",
    "NOTE_SCHEMA_INVALID",
    "NOTE_EVIDENCE_INVALID",
    "NOTE_QUOTE_INVALID",
    "PROTOCOL_VERSION_UNSUPPORTED",
    "DATABASE_WRITE_FAILED",
    "UNKNOWN_INTERNAL_ERROR",
)

_ERROR_CODE_SET = frozenset(ERROR_CODES)


class WorkerError(Exception):
    """A coded, recognised failure the worker reports over the protocol.

    ``code`` should be one of :data:`ERROR_CODES`. ``details`` is an optional
    JSON-serialisable dict of content-safe metadata (never transcript text or
    credentials).
    """

    def __init__(
        self, code: str, message: str, details: Optional[dict[str, Any]] = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def is_known_code(self) -> bool:
        return self.code in _ERROR_CODE_SET


class JobCancelled(Exception):
    """Raised when a SIGTERM/SIGINT cancellation is observed mid-pipeline."""


# CUDA OOM message patterns. faster-whisper/CTranslate2 and torch surface OOM
# with these substrings; anything else must NOT be treated as OOM (spec 02 §8:
# "do not turn arbitrary exceptions into OOM retries").
_CUDA_OOM_PATTERNS = (
    re.compile(r"CUDA out of memory", re.IGNORECASE),
    re.compile(r"cublas.*alloc.*failed", re.IGNORECASE),
    re.compile(r"CUBLAS_STATUS_ALLOC_FAILED", re.IGNORECASE),
    re.compile(r"out of memory", re.IGNORECASE),
)


def classify_oom(exc: BaseException) -> bool:
    """Return True only for a genuine CUDA out-of-memory condition.

    Order of checks:
      1. ``torch.cuda.OutOfMemoryError`` by type, when torch is importable.
      2. Exception class name ``OutOfMemoryError`` (covers torch without an
         import, and lets tests simulate it with a same-named class).
      3. ``RuntimeError`` (or subclass) whose message matches a known CUDA OOM
         pattern.

    An arbitrary ``ValueError`` (or any exception with an unrelated message)
    returns False.
    """
    # 1. Real torch type, guarded so tests never need torch installed.
    try:  # pragma: no cover - exercised only when torch is present
        import torch  # type: ignore

        oom_type = getattr(getattr(torch, "cuda", None), "OutOfMemoryError", None)
        if oom_type is not None and isinstance(exc, oom_type):
            return True
    except Exception:
        pass

    # 2. Class name match (torch's OutOfMemoryError, or a test double).
    if type(exc).__name__ == "OutOfMemoryError":
        return True

    # 3. RuntimeError with a CUDA-OOM-shaped message.
    if isinstance(exc, RuntimeError):
        message = str(exc)
        return any(pattern.search(message) for pattern in _CUDA_OOM_PATTERNS)

    return False
