"""Artifact rendering and writing with strict path confinement.

Path confinement mirrors ``src/helpers/whisperx/pathConfinement.js``: a relative
path must not use absolute/drive/UNC forms, ``..``/``.`` segments, alternate data
streams (``:``), Windows reserved device names, or trailing space/dot — enforced
even on POSIX so contract behaviour is identical everywhere. Every writer keeps
its output strictly inside the assigned job directory and returns
``(relative_path, sha256, bytes)``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any, Optional

from .errors import WorkerError

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_DRIVE_RE = re.compile(r"^[a-zA-Z]:")
_RESERVED_DEVICE_RE = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", re.IGNORECASE)
_MAX_RELATIVE_PATH_LENGTH = 512

# format id -> (relative path, artifact kind)
FORMAT_TO_ARTIFACT = {
    "canonical-json": ("transcript.raw.json", "canonical-transcript"),
    "raw-txt": ("transcript.raw.txt", "raw-transcript"),
    "speaker-markdown": ("transcript.speakers.md", "speaker-transcript"),
    "srt": ("transcript.srt", "srt"),
    "vtt": ("transcript.vtt", "vtt"),
}


def is_relative_artifact_path_safe(relative_path: str) -> bool:
    if not isinstance(relative_path, str) or relative_path == "":
        return False
    if len(relative_path) > _MAX_RELATIVE_PATH_LENGTH:
        return False
    if _CONTROL_CHAR_RE.search(relative_path):
        return False
    if relative_path.startswith("/") or relative_path.startswith("\\"):
        return False
    if _DRIVE_RE.match(relative_path):
        return False
    if ":" in relative_path:
        return False
    for segment in re.split(r"[/\\]", relative_path):
        if segment in ("", "."):
            return False
        if segment == "..":
            return False
        if _RESERVED_DEVICE_RE.match(segment):
            return False
        if segment.endswith(" ") or segment.endswith("."):
            return False
    return True


def confine(root: str, relative_path: str) -> str:
    """Resolve ``relative_path`` under ``root`` and confirm it stays inside.

    Follows symlinks on existing ancestors (reparse escape guard). Raises
    WorkerError(OUTPUT_PATH_REJECTED) when the path is unsafe or escapes.
    """
    if not is_relative_artifact_path_safe(relative_path):
        raise WorkerError(
            "OUTPUT_PATH_REJECTED",
            "relativePath escapes the job directory or uses a forbidden form",
        )
    try:
        resolved_root = os.path.realpath(root)
    except OSError as exc:
        raise WorkerError("OUTPUT_PATH_REJECTED", "job directory could not be resolved") from exc

    target = os.path.normpath(os.path.join(resolved_root, relative_path))
    rel = os.path.relpath(target, resolved_root)
    if rel == "" or rel == os.pardir or rel.startswith(os.pardir + os.sep) or os.path.isabs(rel):
        raise WorkerError("OUTPUT_PATH_REJECTED", "relativePath escapes the job directory")

    # Walk existing components; a symlink must not point outside the root.
    current = resolved_root
    for part in rel.split(os.sep):
        current = os.path.join(current, part)
        if os.path.islink(current):
            real = os.path.realpath(current)
            real_rel = os.path.relpath(real, resolved_root)
            if (
                real_rel == os.pardir
                or real_rel.startswith(os.pardir + os.sep)
                or os.path.isabs(real_rel)
            ):
                raise WorkerError(
                    "OUTPUT_PATH_REJECTED", "relativePath resolves outside the job directory"
                )
        elif not os.path.exists(current):
            break
    return target


def write_artifact(root: str, relative_path: str, content: str) -> tuple[str, str, int]:
    """Atomically write ``content`` (utf-8) to a confined path.

    Writes to a sibling temp file and ``os.replace``s it into place so a crash
    mid-write can never leave a truncated artifact (spec §21: per-file
    atomicity in addition to the staging-directory promotion).
    Returns (rel, sha256, bytes).
    """
    target = confine(root, relative_path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    data = content.encode("utf-8")
    # Unique suffix for parity with recordingArtifactStore.js (`.tmp-<pid>-…`);
    # the worker is single-process per job, so this is robustness, not a fix.
    temporary = f"{target}.tmp-{os.getpid()}"
    try:
        with open(temporary, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except OSError as exc:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise WorkerError("ARTIFACT_WRITE_FAILED", "failed to write artifact") from exc
    sha256 = hashlib.sha256(data).hexdigest()
    return relative_path, sha256, len(data)


# ---------------------------------------------------------------------------
# Timestamp formatting
# ---------------------------------------------------------------------------


def _srt_timestamp(seconds: float) -> str:
    ms_total = int(round(max(0.0, seconds) * 1000))
    hours = ms_total // 3_600_000
    minutes = (ms_total % 3_600_000) // 60_000
    secs = (ms_total % 60_000) // 1000
    millis = ms_total % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _vtt_timestamp(seconds: float) -> str:
    return _srt_timestamp(seconds).replace(",", ".")


def _clock_timestamp(seconds: float) -> str:
    total = int(max(0.0, seconds))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------


def render_canonical_json(transcript: dict[str, Any]) -> str:
    return json.dumps(transcript, ensure_ascii=False, sort_keys=True, indent=2) + "\n"


def render_raw_txt(transcript: dict[str, Any]) -> str:
    lines = [seg.get("text", "") for seg in transcript.get("segments", [])]
    return "\n".join(lines) + "\n"


def render_speaker_markdown(transcript: dict[str, Any]) -> Optional[str]:
    """Return "[hh:mm:ss] SPEAKER_xx: text" lines, or None without diarization."""
    if not transcript.get("speakers"):
        return None
    lines = []
    for seg in transcript.get("segments", []):
        speaker = seg.get("speakerId") or "UNKNOWN"
        stamp = _clock_timestamp(float(seg.get("start", 0.0) or 0.0))
        lines.append(f"[{stamp}] {speaker}: {seg.get('text', '')}")
    return "\n".join(lines) + "\n"


def render_srt(transcript: dict[str, Any]) -> str:
    blocks = []
    for i, seg in enumerate(transcript.get("segments", []), start=1):
        start = _srt_timestamp(float(seg.get("start", 0.0) or 0.0))
        end = _srt_timestamp(float(seg.get("end", 0.0) or 0.0))
        blocks.append(f"{i}\n{start} --> {end}\n{seg.get('text', '')}\n")
    return "\n".join(blocks) + "\n"


def render_vtt(transcript: dict[str, Any]) -> str:
    blocks = []
    for i, seg in enumerate(transcript.get("segments", []), start=1):
        start = _vtt_timestamp(float(seg.get("start", 0.0) or 0.0))
        end = _vtt_timestamp(float(seg.get("end", 0.0) or 0.0))
        blocks.append(f"{i}\n{start} --> {end}\n{seg.get('text', '')}\n")
    return "WEBVTT\n\n" + "\n".join(blocks) + "\n"


def render_format(fmt: str, transcript: dict[str, Any]) -> Optional[str]:
    if fmt == "canonical-json":
        return render_canonical_json(transcript)
    if fmt == "raw-txt":
        return render_raw_txt(transcript)
    if fmt == "speaker-markdown":
        return render_speaker_markdown(transcript)
    if fmt == "srt":
        return render_srt(transcript)
    if fmt == "vtt":
        return render_vtt(transcript)
    raise WorkerError("ARTIFACT_WRITE_FAILED", f"unknown format {fmt!r}")
